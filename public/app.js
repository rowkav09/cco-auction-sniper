const state = {
  settings: null,
  running: false,
  me: { data: null },
  ledger: { heldByAuction: {}, sessionCommitted: 0, totalHeld: 0 },
  stats: {},
  auctions: [],
  priceData: {},
  sortMode: 'timeLeft',
  ruleStats: {},
};

function fmt(n) {
  if (n == null || isNaN(n)) return '—';
  return Math.round(n).toLocaleString('en-US');
}
// Auctions bid in tokens, but showing raw token amounts next to dollar-denominated market values
// was confusing (they're ~10x apart and easy to mix up at a glance) -- convert everything to
// dollars for display using the live $->tokens rate (falls back to the confirmed 10:1 rate).
function usd(tokens) {
  if (tokens == null || isNaN(tokens)) return '—';
  const rate = state.fx?.rate || 10;
  return '$' + fmt(tokens / rate);
}
// Inverse of usd() -- settings/rule inputs are entered in dollars but stored internally in
// tokens (that's the unit the bidding math and the CCO API actually use).
function toTokens(dollars) {
  if (dollars == null || isNaN(dollars)) return null;
  const rate = state.fx?.rate || 10;
  return Math.round(dollars * rate);
}
function fromTokens(tokens) {
  if (tokens == null || isNaN(tokens)) return null;
  const rate = state.fx?.rate || 10;
  return Math.round((tokens / rate) * 100) / 100;
}
function timeLeft(iso) {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return 'ended';
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

// ---------- panel collapse ----------
document.querySelectorAll('[data-toggle]').forEach((h) => {
  h.addEventListener('click', () => {
    document.getElementById(h.dataset.toggle).classList.toggle('collapsed');
  });
});

// ---------- websocket ----------
let ws;
function connectWs() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onopen = () => setWsStatus(true);
  ws.onclose = () => { setWsStatus(false); setTimeout(connectWs, 2000); };
  ws.onerror = () => ws.close();
  ws.onmessage = (evt) => {
    const { type, payload } = JSON.parse(evt.data);
    if (type === 'init') {
      Object.assign(state, payload);
      renderAll();
    } else if (type === 'auctions') {
      state.auctions = payload;
      renderAuctions();
    } else if (type === 'log') {
      appendLog(payload);
    } else if (type === 'ledger') {
      state.ledger = payload;
      renderStats();
    } else if (type === 'stats') {
      state.stats = payload;
      renderStats();
    } else if (type === 'settings') {
      state.settings = payload;
      renderSettingsForm();
      renderRules();
    } else if (type === 'me') {
      state.me = payload;
      renderStats();
    } else if (type === 'fx') {
      state.fx = payload;
      renderStats();
    } else if (type === 'browser') {
      state.browser = payload;
      // running can change on its own (e.g. the sniper auto-stops if the Chrome window gets
      // closed) -- without this the Start/Stop buttons could get stuck showing stale state.
      if (payload.running !== undefined) state.running = payload.running;
      renderBrowserStatus();
      renderStats();
    } else if (type === 'ruleStats') {
      state.ruleStats = payload;
      renderRules();
    }
  };
}
function setWsStatus(on) {
  document.getElementById('wsDot').className = 'dot ' + (on ? 'on' : 'off');
  document.getElementById('wsText').textContent = on ? 'dashboard connected' : 'reconnecting…';
}
connectWs();

// ---------- render: browser/CCO connection status ----------
function renderBrowserStatus() {
  const b = state.browser;
  const ccoDot = document.getElementById('ccoDot');
  const ccoText = document.getElementById('ccoText');
  const statusEl = document.getElementById('browserStatus');
  const warning = document.getElementById('browserWarning');
  if (!b || !b.ready) {
    ccoDot.className = 'dot off';
    ccoText.textContent = 'browser not started';
    if (statusEl) statusEl.textContent = 'not started -- click Start (a Chrome window will open)';
    warning.style.display = 'block';
    return;
  }
  warning.style.display = 'none';
  ccoDot.className = 'dot ' + (b.socketConnected ? 'on' : 'off');
  ccoText.textContent = b.socketConnected ? `live (${b.userName})` : `browser ready, socket reconnecting…`;
  if (statusEl) statusEl.textContent = `${b.userName} (${b.userId})${b.socketConnected ? ', websocket connected' : ', websocket reconnecting…'}`;
}

// ---------- render: stats ----------
function renderStats() {
  const grid = document.getElementById('statsGrid');
  const tokens = state.me?.data?.tokens;
  const held = state.ledger?.totalHeld || 0;
  const free = tokens != null ? tokens - held : null;
  const cap = state.settings?.limits?.sessionSpendCap;
  const committed = state.ledger?.sessionCommitted || 0;
  const s = state.stats || {};
  const winRate = (s.won || 0) + (s.lost || 0) > 0 ? Math.round((100 * (s.won || 0)) / ((s.won || 0) + (s.lost || 0))) : null;
  const avgDiscount = s.totalMarketValueOnWins > 0
    ? Math.round(100 * (1 - s.totalSpentOnWins / s.totalMarketValueOnWins))
    : null;

  const cards = [
    { label: 'Balance', value: usd(tokens), sub: state.me?.error ? 'fetch error' : '' },
    { label: 'Held (worst-case)', value: usd(held), sub: 'autobids counted at their ceiling, not current bid' },
    { label: 'Free balance', value: usd(free), sub: '' },
    { label: 'Session committed', value: `${usd(committed)} / ${usd(cap)}`, sub: 'new commitments this run' },
    { label: 'Tracked auctions', value: fmt(state.auctions.length), sub: '' },
    { label: 'Bids placed', value: fmt(s.bidsPlaced || 0), sub: '' },
    { label: 'Autobids set', value: fmt(s.autobidsSet || 0), sub: '' },
    { label: 'Won / Lost', value: `${fmt(s.won || 0)} / ${fmt(s.lost || 0)}`, sub: winRate != null ? `${winRate}% win rate` : '' },
    { label: 'Avg. discount on wins', value: avgDiscount != null ? `${avgDiscount}%` : '—', sub: 'vs. market value' },
    { label: 'Pricedata sheet', value: state.priceData?.ready ? 'loaded' : 'loading…', sub: state.priceData?.lastLoadedAt ? new Date(state.priceData.lastLoadedAt).toLocaleTimeString() : '' },
  ];
  grid.innerHTML = cards.map((c) => `
    <div class="stat"><div class="label">${c.label}</div><div class="value">${c.value}</div><div class="sub">${c.sub || ''}</div></div>
  `).join('');

  document.getElementById('dryPill').className = 'pill ' + (state.settings?.dryRun ? 'dry' : 'live');
  document.getElementById('dryPill').textContent = state.settings?.dryRun ? 'DRY RUN' : 'LIVE — placing real bids';
  document.getElementById('startBtn').disabled = state.running;
  document.getElementById('stopBtn').disabled = !state.running;
}

// ---------- render: auctions ----------
function discountPct(a) {
  if (a.marketValueTokens == null || !a.marketValueTokens) return -Infinity;
  return 100 * (1 - a.minNextBid / a.marketValueTokens);
}

function sortedAuctions() {
  const list = [...state.auctions];
  switch (state.sortMode) {
    case 'favorite':
      return list.sort((a, b) => (b.isFavorite - a.isFavorite) || (new Date(a.expiresAt) - new Date(b.expiresAt)));
    case 'marketValue':
      return list.sort((a, b) => (b.marketValueDollars || 0) - (a.marketValueDollars || 0));
    case 'discount':
      return list.sort((a, b) => discountPct(b) - discountPct(a));
    case 'bidCount':
      return list.sort((a, b) => (b.bidCount || 0) - (a.bidCount || 0));
    default:
      return list; // server already sends time-left order
  }
}

async function quickAutobid(id, pct, btn) {
  btn.disabled = true;
  const original = btn.textContent;
  btn.textContent = '...';
  try {
    const res = await fetch(`/api/auctions/${id}/quick-autobid`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pct }),
    }).then((r) => r.json());
    if (!res.ok) { btn.textContent = original; alert(`Couldn't set autobid: ${res.error}`); }
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}

function marketValueCellHtml(a) {
  if (a.marketValueDollars != null) return `$${fmt(a.marketValueDollars)}`;
  return a.valuationConfidence === 'uncalibrated' ? 'set $→tokens rate' : (a.valuationConfidence || '—');
}

function quickActionsCellHtml(a) {
  const canAct = !a.isLeading && !a.cooldown && a.marketValueTokens != null && a.status === 'active' && !a.isLocked;
  if (!canAct) return a.marketValueTokens == null && !a.isLeading && !a.cooldown ? '<span class="hint">no token value yet</span>' : '';
  return [20, 50, 100].map((pct) => `<button class="small qa-btn" data-id="${a.id}" data-pct="${pct}">${pct}%</button>`).join(' ');
}

// Rows are keyed by auction id and updated in place rather than rebuilt via innerHTML on every
// update -- rebuilding the whole table on every socket push (which can arrive several times a
// second on a live auction house) destroyed and recreated the quick-action buttons out from under
// whatever the user was about to click, and made the list visibly jump.
const auctionRows = new Map(); // id -> <tr>

function buildRow(a) {
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td class="cell-skin"></td>
    <td class="mono cell-currentBid"></td>
    <td class="mono cell-minNext"></td>
    <td class="mono cell-marketValue"></td>
    <td class="mono cell-bidCount"></td>
    <td class="mono cell-timeLeft"></td>
    <td class="cell-decision"></td>
    <td class="cell-actions"></td>
  `;
  updateRow(tr, a, { actions: true });
  return tr;
}

function updateRow(tr, a, opts = {}) {
  const decision = a.lastDecision;
  const verdict = decision?.verdict || 'pending';
  const skinName = `${a.statTrak ? 'StatTrak™ ' : ''}${a.name || '?'}${a.exterior ? ` (${a.exterior})` : ''}`;
  const iconSrc = a.iconUrl ? (a.iconUrl.startsWith('http') ? a.iconUrl : `https://case-clicker.com/pictures/skins/${a.iconUrl}`) : null;
  const skinHtml = `${iconSrc ? `<img class="icon" src="${iconSrc}" onerror="this.style.display='none'">` : ''} ${a.isFavorite ? '★ ' : ''}<a href="https://case-clicker.com/auctions/${a.id}" target="_blank" rel="noopener">${skinName}</a>
    ${a.isLeading ? '<span class="tag leading">LEADING</span>' : ''}
    ${a.cooldown ? '<span class="tag skip">cooldown</span>' : ''}`;
  setHtmlIfChanged(tr.querySelector('.cell-skin'), skinHtml);
  setHtmlIfChanged(tr.querySelector('.cell-currentBid'), usd(a.currentBid));
  setHtmlIfChanged(tr.querySelector('.cell-minNext'), usd(a.minNextBid));
  setHtmlIfChanged(tr.querySelector('.cell-marketValue'), marketValueCellHtml(a));
  setHtmlIfChanged(tr.querySelector('.cell-bidCount'), fmt(a.bidCount));
  tr.querySelector('.cell-timeLeft').textContent = timeLeft(a.expiresAt);
  setHtmlIfChanged(tr.querySelector('.cell-decision'), `<span class="tag ${verdict}">${verdict}</span><div class="decision-reason">${decision?.reason || ''}</div>`);
  // Quick-action buttons: only rebuilt when what they'd do actually changes (canAct flips, or the
  // auction id changes on a reused row), so a button never disappears mid-click.
  const actionsKey = `${a.id}:${!a.isLeading && !a.cooldown && a.marketValueTokens != null && a.status === 'active' && !a.isLocked}`;
  if (opts.actions || tr.dataset.actionsKey !== actionsKey) {
    tr.dataset.actionsKey = actionsKey;
    const cell = tr.querySelector('.cell-actions');
    cell.innerHTML = quickActionsCellHtml(a);
    cell.querySelectorAll('.qa-btn').forEach((btn) => {
      btn.addEventListener('click', () => quickAutobid(btn.dataset.id, Number(btn.dataset.pct), btn));
    });
  }
}

function setHtmlIfChanged(el, html) {
  if (el.__lastHtml !== html) { el.innerHTML = html; el.__lastHtml = html; }
}

function renderAuctions() {
  const body = document.getElementById('auctionsBody');
  const empty = document.getElementById('auctionsEmpty');
  const list = sortedAuctions();

  if (!list.length) {
    body.innerHTML = '';
    auctionRows.clear();
    empty.style.display = 'block';
    return;
  }
  empty.style.display = 'none';

  const seen = new Set();
  list.forEach((a, index) => {
    seen.add(a.id);
    let tr = auctionRows.get(a.id);
    if (!tr) {
      tr = buildRow(a);
      auctionRows.set(a.id, tr);
    } else {
      updateRow(tr, a);
    }
    const current = body.children[index];
    if (current !== tr) body.insertBefore(tr, current || null);
  });

  for (const [id, tr] of auctionRows) {
    if (!seen.has(id)) { tr.remove(); auctionRows.delete(id); }
  }
}

// Countdown text updates on its own timer without touching anything else (no re-sort, no cell
// diffing) so it can't interfere with a table structure update mid-interaction.
setInterval(() => {
  for (const [id, tr] of auctionRows) {
    const a = state.auctions.find((x) => x.id === id);
    if (a) tr.querySelector('.cell-timeLeft').textContent = timeLeft(a.expiresAt);
  }
}, 1000);

document.getElementById('sortModeSelect').addEventListener('change', (e) => { state.sortMode = e.target.value; renderAuctions(); });
document.getElementById('refreshAuctionsBtn').addEventListener('click', async (e) => {
  e.target.disabled = true;
  e.target.textContent = 'refreshing…';
  try { await fetch('/api/control/refresh', { method: 'POST' }); }
  finally { e.target.disabled = false; e.target.textContent = 'Refresh now'; }
});

// ---------- render: log ----------
function appendLog(entry) {
  const el = document.getElementById('log');
  const div = document.createElement('div');
  div.className = `log-line ${entry.level}`;
  div.textContent = `[${new Date(entry.ts).toLocaleTimeString()}] ${entry.message}`;
  el.appendChild(div);
  while (el.children.length > 400) el.removeChild(el.firstChild);
}
function renderLog() {
  const el = document.getElementById('log');
  el.innerHTML = '';
  (state.log || []).forEach(appendLog);
}

// ---------- render: settings form ----------
function renderSettingsForm() {
  const s = state.settings;
  if (!s) return;
  document.getElementById('dryRunToggle').checked = !!s.dryRun;
  document.getElementById('strategySelect').value = s.strategy;
  document.getElementById('snipeSecondsInput').value = s.snipeSeconds;
  document.getElementById('newestPollInput').value = s.discovery.newestPollMs;
  document.getElementById('fullPollInput').value = s.discovery.fullPollMs;
  document.getElementById('minCompInput').value = s.valuation.minComparableSales;
  document.getElementById('requireValidToggle').checked = !!s.valuation.requireValid;
  document.getElementById('manualFxInput').value = s.valuation.manualTokensPerDollar ?? '';
  document.getElementById('minCalSamplesInput').value = s.valuation.minCalibrationSamples;
  document.getElementById('spendCapInput').value = fromTokens(s.limits.sessionSpendCap);
  document.getElementById('maxTrackedInput').value = s.limits.maxConcurrentTracked;
  document.getElementById('defaultRuleEnabled').checked = !!s.defaultRule.enabled;
  document.getElementById('defaultThreshold').value = s.defaultRule.thresholdPct;
  document.getElementById('defaultMaxBidPct').value = s.defaultRule.maxBidPct;
  document.getElementById('favoritesInput').value = (s.favorites || []).join('\n');
}

document.getElementById('saveFavoritesBtn').addEventListener('click', async (e) => {
  const favorites = document.getElementById('favoritesInput').value.split('\n').map((s) => s.trim()).filter(Boolean);
  await patchSettings({ favorites }, e.target);
});

document.getElementById('testConnBtn').addEventListener('click', async () => {
  const out = document.getElementById('testConnResult');
  out.textContent = 'testing…';
  const res = await fetch('/api/test-connection', { method: 'POST' }).then((r) => r.json());
  out.textContent = res.ok
    ? `OK — signed in as ${res.user}, ${fmt(res.tokens)} tokens, ${res.membership}`
    : `FAILED — ${res.error}`;
  out.style.color = res.ok ? '#3fb950' : '#f85149';
});

document.getElementById('saveSettingsBtn').addEventListener('click', async (e) => {
  await patchSettings({
    dryRun: document.getElementById('dryRunToggle').checked,
    strategy: document.getElementById('strategySelect').value,
    snipeSeconds: Number(document.getElementById('snipeSecondsInput').value),
    discovery: {
      newestPollMs: Number(document.getElementById('newestPollInput').value),
      fullPollMs: Number(document.getElementById('fullPollInput').value),
    },
    valuation: {
      minComparableSales: Number(document.getElementById('minCompInput').value),
      requireValid: document.getElementById('requireValidToggle').checked,
      manualTokensPerDollar: document.getElementById('manualFxInput').value === '' ? null : Number(document.getElementById('manualFxInput').value),
      minCalibrationSamples: Number(document.getElementById('minCalSamplesInput').value),
    },
    limits: {
      sessionSpendCap: toTokens(Number(document.getElementById('spendCapInput').value)),
      maxConcurrentTracked: Number(document.getElementById('maxTrackedInput').value),
    },
  }, e.target);
});

document.getElementById('saveDefaultRuleBtn').addEventListener('click', async (e) => {
  await patchSettings({
    defaultRule: {
      enabled: document.getElementById('defaultRuleEnabled').checked,
      thresholdPct: Number(document.getElementById('defaultThreshold').value),
      maxBidPct: Number(document.getElementById('defaultMaxBidPct').value),
    },
  }, e.target);
});

async function patchSettings(patch, btn) {
  const res = await fetch('/api/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) });
  state.settings = await res.json();
  renderSettingsForm();
  renderStats();
  if (btn) flashSaved(btn);
}

// Buttons that just save settings (no error state to report, nothing else visibly changes if
// the value you typed matches what was already there) got reported as "does nothing" -- flash a
// clear confirmation instead of silently succeeding.
function flashSaved(btn) {
  const original = btn.textContent;
  btn.textContent = 'Saved ✓';
  btn.disabled = true;
  setTimeout(() => { btn.textContent = original; btn.disabled = false; }, 1200);
}

document.getElementById('startBtn').addEventListener('click', async () => {
  const res = await fetch('/api/control/start', { method: 'POST' }).then((r) => r.json());
  state.running = res.running;
  renderStats();
});
document.getElementById('stopBtn').addEventListener('click', async () => {
  const res = await fetch('/api/control/stop', { method: 'POST' }).then((r) => r.json());
  state.running = res.running;
  renderStats();
});

// ---------- render: rules ----------
function renderRules() {
  const list = document.getElementById('rulesList');
  const rules = state.settings?.rules || [];
  list.innerHTML = rules.map((r) => ruleCardHtml(r)).join('');
  rules.forEach((r) => wireRuleCard(r.id));
}

function ruleCardHtml(r) {
  const m = r.match || {};
  return `<div class="rule-card" data-id="${r.id}">
    <div class="rule-head">
      <label class="switch"><input type="checkbox" class="r-enabled" ${r.enabled ? 'checked' : ''}><span class="slider"></span></label>
      <input type="text" class="r-name" value="${(r.name || '').replace(/"/g, '&quot;')}" placeholder="Rule name">
      <div class="spacer"></div>
      <button class="small danger r-remove">Remove</button>
    </div>
    <div class="match-grid">
      <div><label>Name contains</label><input type="text" class="r-nameContains" value="${(m.nameContains || '').replace(/"/g, '&quot;')}" placeholder="e.g. Karambit"></div>
      <div><label>Weapon type</label><input type="text" class="r-weaponType" value="${m.weaponType || ''}" placeholder="e.g. Knives"></div>
      <div><label>Rarity</label><input type="text" class="r-rarity" value="${m.rarity || ''}" placeholder="e.g. Covert"></div>
      <div><label>Exterior</label><input type="text" class="r-exterior" value="${m.exterior || ''}" placeholder="e.g. Factory New"></div>
      <div><label>StatTrak (blank/true/false)</label><input type="text" class="r-statTrak" value="${m.statTrak ?? ''}"></div>
      <div><label>Souvenir (blank/true/false)</label><input type="text" class="r-souvenir" value="${m.souvenir ?? ''}"></div>
      <div><label>Min native $ price</label><input type="number" class="r-minNativePrice" value="${m.minNativePrice ?? ''}"></div>
      <div><label>Max native $ price</label><input type="number" class="r-maxNativePrice" value="${m.maxNativePrice ?? ''}"></div>
    </div>
    <div class="match-grid">
      <div><label>Threshold % of market value (act if min next bid ≤ this)</label><input type="number" class="r-thresholdPct" value="${r.thresholdPct}"></div>
      <div><label>Max bid % of market value (ceiling)</label><input type="number" class="r-maxBidPct" value="${r.maxBidPct}"></div>
      <div><label>Max bid per item ($, optional)</label><input type="number" class="r-maxBidAbsolute" value="${r.maxBidAbsolute != null ? fromTokens(r.maxBidAbsolute) : ''}"></div>
      <div><label>Max items to win (optional)</label><input type="number" min="1" class="r-maxItemsToWin" value="${r.maxItemsToWin ?? ''}"></div>
      <div><label>Max total spend ($, optional)</label><input type="number" class="r-maxTotalSpend" value="${r.maxTotalSpend != null ? fromTokens(r.maxTotalSpend) : ''}"></div>
    </div>
    <div class="hint">${ruleStatsHint(r)}</div>
    <button class="small r-save">Save rule</button>
  </div>`;
}

function ruleStatsHint(r) {
  const s = (state.ruleStats && state.ruleStats[r.id]) || { itemsWon: 0, totalSpentTokens: 0 };
  const parts = [`${s.itemsWon} won so far`, `${usd(s.totalSpentTokens)} spent so far`];
  if (r.maxItemsToWin) parts.push(`${Math.max(0, r.maxItemsToWin - s.itemsWon)} more allowed`);
  if (r.maxTotalSpend) parts.push(`${usd(Math.max(0, r.maxTotalSpend - s.totalSpentTokens))} budget left`);
  return parts.join(' · ');
}

function wireRuleCard(id) {
  const card = document.querySelector(`.rule-card[data-id="${id}"]`);
  card.querySelector('.r-remove').addEventListener('click', async () => {
    await fetch(`/api/rules/${id}`, { method: 'DELETE' });
  });
  card.querySelector('.r-save').addEventListener('click', async (e) => {
    const g = (cls) => card.querySelector(`.${cls}`).value.trim();
    const parseBool = (v) => (v === '' ? null : v === 'true');
    const body = {
      name: g('r-name'),
      enabled: card.querySelector('.r-enabled').checked,
      thresholdPct: Number(g('r-thresholdPct')),
      maxBidPct: Number(g('r-maxBidPct')),
      maxBidAbsolute: g('r-maxBidAbsolute') === '' ? null : toTokens(Number(g('r-maxBidAbsolute'))),
      maxItemsToWin: g('r-maxItemsToWin') === '' ? null : Number(g('r-maxItemsToWin')),
      maxTotalSpend: g('r-maxTotalSpend') === '' ? null : toTokens(Number(g('r-maxTotalSpend'))),
      match: {
        nameContains: g('r-nameContains') || undefined,
        weaponType: g('r-weaponType') || undefined,
        rarity: g('r-rarity') || undefined,
        exterior: g('r-exterior') || undefined,
        statTrak: parseBool(g('r-statTrak')),
        souvenir: parseBool(g('r-souvenir')),
        minNativePrice: g('r-minNativePrice') === '' ? undefined : Number(g('r-minNativePrice')),
        maxNativePrice: g('r-maxNativePrice') === '' ? undefined : Number(g('r-maxNativePrice')),
      },
    };
    await fetch(`/api/rules/${id}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    flashSaved(e.target);
  });
}

document.getElementById('addRuleBtn').addEventListener('click', async () => {
  // Don't optimistically splice the response into state.settings.rules here -- the server's own
  // 'settings' broadcast (sent synchronously inside store.addRule, often arriving over the
  // websocket before this fetch's response does) already updates state.settings and re-renders.
  // Doing both raced and produced a duplicate rule card.
  await fetch('/api/rules', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'New rule', enabled: false, thresholdPct: 65, maxBidPct: 85, match: {} }),
  });
});

function renderAll() {
  renderStats();
  renderAuctions();
  renderSettingsForm();
  renderRules();
  renderLog();
  renderBrowserStatus();
}
