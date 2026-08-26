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
  categories: { weaponTypes: [], rarities: [] },
  history: [],
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
      renderHoldings();
    } else if (type === 'log') {
      appendLog(payload);
    } else if (type === 'ledger') {
      state.ledger = payload;
      renderStats();
      renderBudget();
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
      renderBudget();
    } else if (type === 'historyPoint') {
      state.history.push(payload);
      if (state.history.length > 480) state.history.shift();
      renderBudget();
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
  const allocation = state.settings?.limits?.allocation;
  const lifetimeCommitted = state.ledger?.sessionCommitted || 0;
  const s = state.stats || {};
  const winRate = (s.won || 0) + (s.lost || 0) > 0 ? Math.round((100 * (s.won || 0)) / ((s.won || 0) + (s.lost || 0))) : null;
  const avgDiscount = s.totalMarketValueOnWins > 0
    ? Math.round(100 * (1 - s.totalSpentOnWins / s.totalMarketValueOnWins))
    : null;
  const realizedPnl = (s.totalMarketValueOnWins || 0) - (s.totalSpentOnWins || 0);

  const active = state.auctions.filter((a) => a.status === 'active');
  const leading = active.filter((a) => a.isLeading);
  const totalActiveVolume = active.reduce((sum, a) => sum + (a.currentBid || 0), 0);
  const myVolume = leading.reduce((sum, a) => sum + (a.currentBid || 0), 0);
  const marketSharePct = totalActiveVolume > 0 ? (100 * myVolume) / totalActiveVolume : 0;

  const cards = [
    { label: 'Balance', value: usd(tokens), sub: state.me?.error ? 'fetch error' : '' },
    { label: 'At risk (held)', value: usd(held), sub: 'auctions currently leading, at their ceiling' },
    { label: 'Free balance', value: usd(free), sub: '' },
    { label: 'Bot allocation', value: `${usd(held)} / ${usd(allocation)}`, sub: `${usd(lifetimeCommitted)} committed lifetime this run` },
    { label: 'Winning', value: `${fmt(leading.length)} / ${fmt(active.length)}`, sub: 'of currently tracked active auctions' },
    { label: 'Market share', value: `${marketSharePct.toFixed(1)}%`, sub: 'my leading bids vs. total tracked bid volume' },
    { label: 'Realized P&L', value: usd(realizedPnl), sub: `${fmt(s.won || 0)} won, market value vs. paid` },
    { label: 'Won / Lost', value: `${fmt(s.won || 0)} / ${fmt(s.lost || 0)}`, sub: winRate != null ? `${winRate}% win rate` : '' },
    { label: 'Avg. discount on wins', value: avgDiscount != null ? `${avgDiscount}%` : '—', sub: 'vs. market value' },
    { label: 'Bids placed / Autobids set', value: `${fmt(s.bidsPlaced || 0)} / ${fmt(s.autobidsSet || 0)}`, sub: '' },
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

// ---------- render: current holdings (auctions we're leading) ----------
function renderHoldings() {
  const body = document.getElementById('holdingsBody');
  const empty = document.getElementById('holdingsEmpty');
  const summary = document.getElementById('holdingsSummary');
  const holdings = state.auctions.filter((a) => a.isLeading);
  if (!holdings.length) {
    body.innerHTML = '';
    summary.innerHTML = '';
    empty.style.display = 'block';
    return;
  }
  empty.style.display = 'none';

  const rate = state.fx?.rate || 10;
  const valued = holdings.filter((a) => a.marketValueDollars != null);
  const pnls = valued.map((a) => ({ a, pnl: a.marketValueDollars - a.currentBid / rate }));
  const totalUnrealized = pnls.reduce((sum, p) => sum + p.pnl, 0);
  const best = pnls.length ? pnls.reduce((m, p) => (p.pnl > m.pnl ? p : m)) : null;
  const worst = pnls.length ? pnls.reduce((m, p) => (p.pnl < m.pnl ? p : m)) : null;
  summary.innerHTML = [
    { label: 'Unrealized P&L', value: `$${fmt(totalUnrealized)}`, sub: `across ${valued.length} valued holding(s)` },
    { label: 'Best position', value: best ? `$${fmt(best.pnl)}` : '—', sub: best ? best.a.name : '' },
    { label: 'Worst position', value: worst ? `$${fmt(worst.pnl)}` : '—', sub: worst ? worst.a.name : '' },
  ].map((c) => `<div class="stat"><div class="label">${c.label}</div><div class="value">${c.value}</div><div class="sub">${c.sub || ''}</div></div>`).join('');

  body.innerHTML = holdings.map((a) => {
    const skinName = `${a.statTrak ? 'StatTrak™ ' : ''}${a.name || '?'}${a.exterior ? ` (${a.exterior})` : ''}`;
    const discount = a.marketValueTokens ? Math.round(100 * (1 - a.currentBid / a.marketValueTokens)) : null;
    const type = a.hasAutobid ? `autobid (up to ${usd(a.autobidMax)})` : 'fixed bid';
    return `<tr>
      <td><a href="https://case-clicker.com/auctions/${a.id}" target="_blank" rel="noopener">${a.isFavorite ? '★ ' : ''}${skinName}</a></td>
      <td class="mono">${usd(a.currentBid)}</td>
      <td class="mono">${a.marketValueDollars != null ? '$' + fmt(a.marketValueDollars) : '—'}</td>
      <td class="mono">${discount != null ? discount + '%' : '—'}</td>
      <td class="mono">${timeLeft(a.expiresAt)}</td>
      <td>${type}</td>
    </tr>`;
  }).join('');
}
setInterval(() => { if (state.auctions.some((a) => a.isLeading)) renderHoldings(); }, 1000);

// ---------- render: budget bars + history chart ----------
function renderBudget() {
  const allocation = state.settings?.limits?.allocation || 0;
  const held = state.ledger?.totalHeld || 0;
  const pct = allocation > 0 ? Math.min(100, (held / allocation) * 100) : 0;
  const fill = document.getElementById('budgetCapFill');
  fill.style.width = pct + '%';
  fill.className = 'budget-bar-fill' + (pct >= 90 ? ' danger' : pct >= 60 ? ' warn' : '');
  document.getElementById('budgetCapText').textContent = `${usd(held)} at risk / ${usd(allocation)} allocated (${Math.round(pct)}%)`;

  const rulesWithBudget = [...(state.settings?.rules || []), { id: 'default', name: 'Default rule', ...state.settings?.defaultRule }]
    .filter((r) => r.maxTotalSpend);
  document.getElementById('ruleBudgetBars').innerHTML = rulesWithBudget.map((r) => {
    const s = (state.ruleStats && state.ruleStats[r.id]) || { totalSpentTokens: 0 };
    const p = Math.min(100, (s.totalSpentTokens / r.maxTotalSpend) * 100);
    return `<div class="budget-bar-row">
      <div class="budget-bar-label"><span>${r.name || r.id}</span><span>${usd(s.totalSpentTokens)} / ${usd(r.maxTotalSpend)} (${Math.round(p)}%)</span></div>
      <div class="budget-bar"><div class="budget-bar-fill${p >= 90 ? ' danger' : p >= 60 ? ' warn' : ''}" style="width:${p}%"></div></div>
    </div>`;
  }).join('');

  renderHistoryChart();
}

// General-purpose small line chart: multiple labeled series sharing one Y axis, with actual
// min/max/zero labels so even a flat or short line still reads as real numbers instead of an
// unlabeled shape (a flat line with no scale looks like the chart is broken, not like "this
// number hasn't moved yet").
function svgLineChart(pts, series, opts = {}) {
  const W = 900, H = 150, PAD_L = 60, PAD_R = 10, PAD_T = 10, PAD_B = 20;
  const innerW = W - PAD_L - PAD_R, innerH = H - PAD_T - PAD_B;

  if (pts.length < 2) {
    return '<div class="hint">Chart fills in as the app runs (one sample every 30s) -- not enough data yet.</div>';
  }

  const allValues = series.flatMap((s) => pts.map((p) => s.get(p)).filter((v) => v != null));
  // Forcing zero into the range makes sense for a series that's meaningfully centered near zero
  // (P&L: profit vs. loss). For something like balance -- always a large positive number, never
  // anywhere near zero -- it does the opposite: squashes all the actual movement into a sliver at
  // the top of a mostly-empty 0-to-max chart, which is what was making that line look invisible.
  const includeZero = opts.includeZero !== false;
  let minY = includeZero ? Math.min(0, ...allValues) : Math.min(...allValues);
  let maxY = includeZero ? Math.max(0, ...allValues) : Math.max(...allValues);
  if (minY === maxY) { minY -= 1; maxY += 1; } // avoid a zero-height range on perfectly flat data
  const pad = (maxY - minY) * 0.08;
  minY -= pad; maxY += pad;

  const xOf = (i) => PAD_L + (i / (pts.length - 1)) * innerW;
  const yOf = (v) => PAD_T + innerH - ((v - minY) / (maxY - minY)) * innerH;
  const zeroY = yOf(0);

  const toPath = (getter) => pts.map((p, i) => {
    const v = getter(p);
    if (v == null) return null;
    return `${i === 0 ? 'M' : 'L'}${xOf(i).toFixed(1)},${yOf(v).toFixed(1)}`;
  }).filter(Boolean).join(' ');

  const fmtY = opts.fmtY || ((v) => fmt(v));
  const zeroLine = minY < 0 && maxY > 0
    ? `<line x1="${PAD_L}" y1="${zeroY.toFixed(1)}" x2="${W - PAD_R}" y2="${zeroY.toFixed(1)}" stroke="#2a323d" stroke-dasharray="3,3" />`
    : '';

  const paths = series.map((s) => `<path d="${toPath(s.get)}" fill="none" stroke="${s.color}" stroke-width="2" />`).join('');
  const first = pts[0], last = pts[pts.length - 1];
  const timeLabel = (p) => new Date(p.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  const svg = `<svg viewBox="0 0 ${W} ${H}">
    ${zeroLine}
    <text x="${PAD_L - 6}" y="${PAD_T + 4}" text-anchor="end" font-size="10" fill="#8b98a5">${fmtY(maxY)}</text>
    <text x="${PAD_L - 6}" y="${H - PAD_B}" text-anchor="end" font-size="10" fill="#8b98a5">${fmtY(minY)}</text>
    ${paths}
    <text x="${PAD_L}" y="${H - 4}" font-size="10" fill="#8b98a5">${timeLabel(first)}</text>
    <text x="${W - PAD_R}" y="${H - 4}" text-anchor="end" font-size="10" fill="#8b98a5">${timeLabel(last)}</text>
  </svg>`;

  const legend = series.map((s) => `<span><span class="dotline" style="background:${s.color}"></span>${s.label}: <strong>${fmtY(s.get(last))}</strong></span>`).join('');
  return `${svg}<div class="chart-legend">${legend}<span>${pts.length} samples, ~${Math.round((pts.length * 30) / 60)} min</span></div>`;
}

function renderHistoryChart() {
  const pts = state.history;
  const rate = state.fx?.rate || 10;
  const dollarFmt = (v) => '$' + fmt(v);

  document.getElementById('pnlChart').innerHTML = svgLineChart(pts, [
    { label: 'Unrealized P&L', color: '#4c9aff', get: (p) => p.unrealizedPnlTokens != null ? p.unrealizedPnlTokens / rate : null },
    { label: 'Realized P&L', color: '#3fb950', get: (p) => p.realizedPnlTokens != null ? p.realizedPnlTokens / rate : null },
  ], { fmtY: dollarFmt });

  document.getElementById('balanceChart').innerHTML = svgLineChart(pts, [
    { label: 'Balance', color: '#e07b39', get: (p) => p.balanceTokens != null ? p.balanceTokens / rate : null },
  ], { fmtY: dollarFmt, includeZero: false });

  document.getElementById('allocationChart').innerHTML = svgLineChart(pts, [
    { label: 'Held (at risk)', color: '#4c9aff', get: (p) => p.heldTokens != null ? p.heldTokens / rate : null },
    { label: 'Lifetime committed', color: '#e07b39', get: (p) => p.sessionCommittedTokens != null ? p.sessionCommittedTokens / rate : null },
  ], { fmtY: dollarFmt, includeZero: false });
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
  if (a.valuationConfidence === 'uncalibrated') return 'set $→tokens rate';
  if (a.valuationConfidence === 'unpriced-special') return '<span title="event/rare-float item -- the pricing formula has no real number for this, so it\'s excluded rather than shown wrong">unpriced (rare)</span>';
  return a.valuationConfidence || '—';
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

// Weapon-type/rarity dropdown options are derived from whatever's actually showing up in
// tracked auctions (see knownCategories() server-side) -- refresh occasionally so a category
// that hasn't appeared yet shows up without needing a full page reload.
async function refreshCategories() {
  state.categories = await fetch('/api/categories').then((r) => r.json());
  renderRules();
}
setInterval(refreshCategories, 60000);

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
  document.getElementById('spendCapInput').value = fromTokens(s.limits.allocation);
  document.getElementById('maxTrackedInput').value = s.limits.maxConcurrentTracked;
  document.getElementById('defaultRuleEnabled').checked = !!s.defaultRule.enabled;
  document.getElementById('defaultThreshold').value = s.defaultRule.thresholdPct;
  document.getElementById('defaultMaxBidPct').value = s.defaultRule.maxBidPct;
  document.getElementById('defaultMaxBidAbsolute').value = s.defaultRule.maxBidAbsolute != null ? fromTokens(s.defaultRule.maxBidAbsolute) : '';
  document.getElementById('defaultMaxItemsToWin').value = s.defaultRule.maxItemsToWin ?? '';
  document.getElementById('defaultMaxTotalSpend').value = s.defaultRule.maxTotalSpend != null ? fromTokens(s.defaultRule.maxTotalSpend) : '';
  document.getElementById('defaultRuleStats').textContent = ruleStatsHint({ id: 'default', ...s.defaultRule });
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
      allocation: toTokens(Number(document.getElementById('spendCapInput').value)),
      maxConcurrentTracked: Number(document.getElementById('maxTrackedInput').value),
    },
  }, e.target);
});

document.getElementById('saveDefaultRuleBtn').addEventListener('click', async (e) => {
  const maxBidAbsolute = document.getElementById('defaultMaxBidAbsolute').value;
  const maxItemsToWin = document.getElementById('defaultMaxItemsToWin').value;
  const maxTotalSpend = document.getElementById('defaultMaxTotalSpend').value;
  await patchSettings({
    defaultRule: {
      enabled: document.getElementById('defaultRuleEnabled').checked,
      thresholdPct: Number(document.getElementById('defaultThreshold').value),
      maxBidPct: Number(document.getElementById('defaultMaxBidPct').value),
      maxBidAbsolute: maxBidAbsolute === '' ? null : toTokens(Number(maxBidAbsolute)),
      maxItemsToWin: maxItemsToWin === '' ? null : Number(maxItemsToWin),
      maxTotalSpend: maxTotalSpend === '' ? null : toTokens(Number(maxTotalSpend)),
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
// renderRules() gets called from things that have nothing to do with what a rule *card* looks
// like -- a categories refresh every 60s, a ruleStats update the moment any rule wins an auction.
// Full-rebuilding every card's innerHTML on those was wiping out whatever the user was mid-typing
// into a rule they hadn't saved yet (and, worse, silently reverting an already-clicked Save's
// button back to a detached node before its "Saved" flash could show -- looked exactly like the
// click did nothing). Only rebuild the DOM when the actual set/order of rules changed; otherwise
// just refresh the bits that can go stale (dropdown option lists, the won/spent hint) in place.
function renderRules() {
  const list = document.getElementById('rulesList');
  const rules = state.settings?.rules || [];
  const currentIds = [...list.children].map((el) => el.dataset.id);
  const newIds = rules.map((r) => r.id);
  const structuralChange = currentIds.length !== newIds.length || currentIds.some((id, i) => id !== newIds[i]);

  if (structuralChange) {
    list.innerHTML = rules.map((r) => ruleCardHtml(r)).join('');
    rules.forEach((r) => wireRuleCard(r.id));
  } else {
    rules.forEach((r) => updateRuleCardCosmetics(r));
  }
}

function updateRuleCardCosmetics(r) {
  const card = document.querySelector(`.rule-card[data-id="${r.id}"]`);
  if (!card) return;
  const cats = state.categories || { weaponTypes: [], rarities: [] };
  updateSelectOptionsPreservingValue(card.querySelector('.r-weaponType'), cats.weaponTypes);
  updateSelectOptionsPreservingValue(card.querySelector('.r-rarity'), cats.rarities);
  const hint = card.querySelector('.hint');
  if (hint) hint.textContent = ruleStatsHint(r);
}

function updateSelectOptionsPreservingValue(sel, values) {
  if (!sel) return;
  const current = sel.value;
  sel.innerHTML = optionsHtml(values, current);
  sel.value = current; // no-op if current isn't in the refreshed list -- falls back to "(any)"
}

const EXTERIORS = ['Factory New', 'Minimal Wear', 'Field-Tested', 'Well-Worn', 'Battle-Scarred'];
const TRI_STATE = [{ v: '', label: '(any)' }, { v: 'true', label: 'Yes' }, { v: 'false', label: 'No' }];

function optionsHtml(values, current) {
  return `<option value="">(any)</option>` + values.map((v) => `<option value="${v}" ${v === current ? 'selected' : ''}>${v}</option>`).join('');
}
function triStateHtml(cls, current) {
  return `<select class="${cls}">${TRI_STATE.map((o) => `<option value="${o.v}" ${String(current ?? '') === o.v ? 'selected' : ''}>${o.label}</option>`).join('')}</select>`;
}

function ruleCardHtml(r) {
  const m = r.match || {};
  const cats = state.categories || { weaponTypes: [], rarities: [] };
  return `<div class="rule-card" data-id="${r.id}">
    <div class="rule-head">
      <label class="switch"><input type="checkbox" class="r-enabled" ${r.enabled ? 'checked' : ''}><span class="slider"></span></label>
      <input type="text" class="r-name" value="${(r.name || '').replace(/"/g, '&quot;')}" placeholder="Rule name">
      <div class="spacer"></div>
      <button class="small danger r-remove">Remove</button>
    </div>
    <div class="match-grid">
      <div><label>Name contains</label><input type="text" class="r-nameContains" value="${(m.nameContains || '').replace(/"/g, '&quot;')}" placeholder="e.g. Karambit"></div>
      <div><label>Weapon type</label><select class="r-weaponType">${optionsHtml(cats.weaponTypes, m.weaponType)}</select></div>
      <div><label>Rarity</label><select class="r-rarity">${optionsHtml(cats.rarities, m.rarity)}</select></div>
      <div><label>Exterior</label><select class="r-exterior">${optionsHtml(EXTERIORS, m.exterior)}</select></div>
      <div><label>StatTrak</label>${triStateHtml('r-statTrak', m.statTrak)}</div>
      <div><label>Souvenir</label>${triStateHtml('r-souvenir', m.souvenir)}</div>
      <div><label>Event skin</label>${triStateHtml('r-isEvent', m.isEvent)}</div>
      <div><label>1/1 (lowest+highest float)</label>${triStateHtml('r-isOneOfOne', m.isOneOfOne)}</div>
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
  const s = (state.ruleStats && state.ruleStats[r.id]) || { itemsWon: 0, totalSpentTokens: 0, totalMarketValueTokens: 0 };
  const pnl = (s.totalMarketValueTokens || 0) - (s.totalSpentTokens || 0);
  const parts = [`${s.itemsWon} won so far`, `${usd(s.totalSpentTokens)} spent`, `P&L ${usd(pnl)}`];
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
        isEvent: parseBool(g('r-isEvent')),
        isOneOfOne: parseBool(g('r-isOneOfOne')),
      },
    };
    await fetch(`/api/rules/${id}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    // e.target can be a detached node if a structural rules-list change (add/remove elsewhere)
    // raced this save and rebuilt the DOM while the request was in flight -- re-find the current
    // button for this rule id rather than trusting the closure reference.
    const freshBtn = document.querySelector(`.rule-card[data-id="${id}"] .r-save`);
    if (freshBtn) flashSaved(freshBtn);
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
  renderHoldings();
  renderBudget();
  renderSettingsForm();
  renderRules();
  renderLog();
  renderBrowserStatus();
}
