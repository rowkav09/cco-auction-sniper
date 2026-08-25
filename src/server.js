import express from 'express';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

import { store } from './store.js';
import { getMe, getSession } from './ccoRest.js';
import { priceData, getTokensPerDollar } from './pricing.js';
import { sniper } from './sniper.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

let meCache = { data: null, fetchedAt: 0, error: null };
async function refreshMe() {
  try {
    meCache = { data: await getMe(), fetchedAt: Date.now(), error: null };
  } catch (e) {
    meCache = { data: meCache.data, fetchedAt: meCache.fetchedAt, error: e.message };
  }
  store._notify('me', meCache);
}

function maskedSettings() {
  const s = store.settings;
  return {
    ...s,
    cco: {
      cookieConfigured: !!s.cco.cookie,
      cookiePreview: s.cco.cookie ? `${s.cco.cookie.slice(0, 12)}… (${s.cco.cookie.length} chars)` : '',
      userAgent: s.cco.userAgent,
    },
  };
}

function fullState() {
  return {
    settings: maskedSettings(),
    running: sniper._running,
    priceData: { ready: priceData.ready, lastLoadedAt: priceData.lastLoadedAt, failures: priceData.failures },
    fx: getTokensPerDollar(),
    me: meCache,
    ledger: { ...store.runtime.ledger, totalHeld: store.totalHeld() },
    stats: store.runtime.stats,
    auctions: sniper.snapshot(),
    log: store.recentLog(200),
  };
}

app.get('/api/state', (req, res) => res.json(fullState()));

app.post('/api/settings', (req, res) => {
  const patch = req.body || {};
  // cco.cookie/userAgent are write-only from the client's perspective (masked on read), so only
  // overwrite them if the client actually sent a non-empty replacement.
  if (patch.cco) {
    if (!patch.cco.cookie) delete patch.cco.cookie;
    if (!patch.cco.userAgent) delete patch.cco.userAgent;
  }
  store.updateSettings(patch);
  res.json(maskedSettings());
});

app.post('/api/rules', (req, res) => res.json(store.addRule(req.body || {})));
app.put('/api/rules/:id', (req, res) => {
  const updated = store.updateRule(req.params.id, req.body || {});
  if (!updated) return res.status(404).json({ error: 'not found' });
  res.json(updated);
});
app.delete('/api/rules/:id', (req, res) => { store.removeRule(req.params.id); res.json({ ok: true }); });

app.post('/api/test-connection', async (req, res) => {
  try {
    const [me, session] = await Promise.all([getMe(), getSession()]);
    res.json({ ok: true, tokens: me?.tokens, money: me?.money, membership: me?.membership, user: session?.user?.name, userId: session?.user?.id });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

app.post('/api/control/start', async (req, res) => {
  try {
    await sniper.start();
    res.json({ ok: true, running: sniper._running });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/control/stop', (req, res) => {
  sniper.stop();
  res.json({ ok: true, running: sniper._running });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

function broadcast(type, payload) {
  const msg = JSON.stringify({ type, payload });
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(msg);
  }
}

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'init', payload: fullState() }));
});

store.onChange((type, payload) => {
  if (type === 'auctions') { broadcast('auctions', payload); return; }
  if (type === 'log') { broadcast('log', payload); return; }
  if (type === 'ledger') { broadcast('ledger', { ...payload, totalHeld: store.totalHeld() }); return; }
  if (type === 'stats') { broadcast('stats', payload); return; }
  if (type === 'settings') { broadcast('settings', maskedSettings()); return; }
  if (type === 'me') { broadcast('me', payload); return; }
});

setInterval(() => broadcast('fx', getTokensPerDollar()), 15000);

const PORT = store.settings.port || 8934;
server.listen(PORT, () => {
  store.log('info', `dashboard listening on http://localhost:${PORT}`);
  console.log(`\n  CCO Auction Sniper dashboard: http://localhost:${PORT}\n`);
});

setInterval(refreshMe, 15000);
refreshMe();

await priceData.start();

if (store.settings.cco.cookie) {
  sniper.start().catch((e) => store.log('error', `auto-start failed: ${e.message}`));
} else {
  store.log('warn', 'no cookie configured yet -- open the dashboard, paste your CCO cookie + user-agent in Settings, then click Start.');
}

process.on('SIGINT', () => {
  sniper.stop();
  process.exit(0);
});
