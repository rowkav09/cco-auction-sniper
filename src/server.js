import express from 'express';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

import { store } from './store.js';
import { getMe } from './ccoRest.js';
import { priceData, getTokensPerDollar } from './pricing.js';
import { sniper } from './sniper.js';
import { browserSession } from './browserSession.js';
import { startTray } from './tray.js';
import { history } from './history.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

let meCache = { data: null, fetchedAt: 0, error: null };
async function refreshMe() {
  if (!browserSession.ready) return;
  try {
    meCache = { data: await getMe(), fetchedAt: Date.now(), error: null };
  } catch (e) {
    meCache = { data: meCache.data, fetchedAt: meCache.fetchedAt, error: e.message };
  }
  store._notify('me', meCache);
}

function browserStatus() {
  return {
    ready: browserSession.ready,
    socketConnected: browserSession.socketConnected,
    userId: browserSession.userId,
    userName: browserSession.userName,
    running: sniper._running,
  };
}

function fullState() {
  return {
    settings: store.settings,
    running: sniper._running,
    browser: browserStatus(),
    priceData: { ready: priceData.ready, lastLoadedAt: priceData.lastLoadedAt, failures: priceData.failures },
    fx: getTokensPerDollar(),
    me: meCache,
    ledger: { ...store.runtime.ledger, totalHeld: store.totalHeld() },
    stats: store.runtime.stats,
    ruleStats: store.runtime.ruleStats,
    auctions: sniper.snapshot(),
    log: store.recentLog(200),
    categories: sniper.knownCategories(),
    history: history.points,
  };
}

function sampleHistory() {
  const realizedPnlTokens = (store.runtime.stats.totalMarketValueOnWins || 0) - (store.runtime.stats.totalSpentOnWins || 0);
  history.record({
    balanceTokens: meCache.data?.tokens ?? null,
    heldTokens: store.totalHeld(),
    sessionCommittedTokens: store.runtime.ledger.sessionCommitted || 0,
    trackedAuctions: sniper.auctions.size,
    won: store.runtime.stats.won,
    lost: store.runtime.stats.lost,
    unrealizedPnlTokens: sniper.unrealizedPnlTokens(),
    realizedPnlTokens,
  });
}

app.get('/api/state', (req, res) => res.json(fullState()));
app.get('/api/categories', (req, res) => res.json(sniper.knownCategories()));

app.post('/api/settings', (req, res) => {
  const patch = req.body || {};
  store.updateSettings(patch);
  res.json(store.settings);
  // Valuation changes (e.g. the $->tokens rate) should show up on already-tracked auctions right
  // away instead of trickling in as each one happens to get a fresh bid event.
  if (patch.valuation || patch.defaultRule) sniper.reevaluateAll().catch((e) => store.log('error', `reevaluate after settings change failed: ${e.message}`));
});

app.post('/api/rules', (req, res) => {
  const rule = store.addRule(req.body || {});
  res.json(rule);
  sniper.reevaluateAll().catch((e) => store.log('error', `reevaluate after rule add failed: ${e.message}`));
});
app.put('/api/rules/:id', (req, res) => {
  const updated = store.updateRule(req.params.id, req.body || {});
  if (!updated) return res.status(404).json({ error: 'not found' });
  res.json(updated);
  sniper.reevaluateAll().catch((e) => store.log('error', `reevaluate after rule update failed: ${e.message}`));
});
app.delete('/api/rules/:id', (req, res) => {
  store.removeRule(req.params.id);
  res.json({ ok: true });
  sniper.reevaluateAll().catch((e) => store.log('error', `reevaluate after rule delete failed: ${e.message}`));
});

app.post('/api/test-connection', async (req, res) => {
  if (!browserSession.ready) return res.json({ ok: false, error: 'browser session not started yet -- click Start' });
  try {
    const me = await getMe();
    res.json({ ok: true, tokens: me?.tokens, money: me?.money, membership: me?.membership, user: browserSession.userName, userId: browserSession.userId });
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

app.post('/api/control/refresh', async (req, res) => {
  try {
    await Promise.all([sniper.pollNewest(), sniper.pollFull()]);
    res.json({ ok: true, tracked: sniper.auctions.size });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/auctions/:id/quick-autobid', async (req, res) => {
  const pct = Number(req.body?.pct);
  if (!pct || pct <= 0) return res.status(400).json({ ok: false, error: 'pct must be a positive number' });
  try {
    res.json(await sniper.quickAutobid(req.params.id, pct));
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
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
  if (type === 'ruleStats') { broadcast('ruleStats', payload); return; }
  if (type === 'settings') { broadcast('settings', store.settings); return; }
  if (type === 'me') { broadcast('me', payload); return; }
  if (type === 'historyPoint') { broadcast('historyPoint', payload); return; }
});

setInterval(() => broadcast('browser', browserStatus()), 5000);

setInterval(() => broadcast('fx', getTokensPerDollar()), 15000);

setInterval(sampleHistory, 30000);
sampleHistory();

const PORT = store.settings.port || 8934;
server.listen(PORT, () => {
  store.log('info', `dashboard listening on http://localhost:${PORT}`);
  console.log(`\n  CCO Auction Sniper dashboard: http://localhost:${PORT}\n`);
});

setInterval(refreshMe, 15000);
refreshMe();

await priceData.start();

sniper.start().catch((e) => store.log('error', `auto-start failed: ${e.message}`));

async function shutdown() {
  sniper.stop();
  await browserSession.stop();
  process.exit(0);
}

process.on('SIGINT', shutdown);
startTray({ onQuit: shutdown });
