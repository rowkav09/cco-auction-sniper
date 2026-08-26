import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = path.join(__dirname, '..', 'data');
const SETTINGS_PATH = path.join(DATA_DIR, 'settings.json');
const RUNTIME_PATH = path.join(DATA_DIR, 'runtime.json');
const LOG_PATH = path.join(DATA_DIR, 'log.jsonl');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DEFAULT_SETTINGS = {
  port: 8934,
  // No cookie/token settings here: sign-in happens by logging into case-clicker.com in the
  // Playwright-controlled Chrome window (see browserSession.js). The session lives in that
  // browser profile (data/browser-profile/), not in this settings file.
  dryRun: true,
  strategy: 'autobid', // 'autobid' | 'snipe'
  snipeSeconds: 8,
  discovery: {
    newestPollMs: 8000,
    fullPollMs: 60000,
    includeEnded: false,
  },
  valuation: {
    // Gate for admitting a comparable-sales sample into the $->tokens calibration (see pricing.js) --
    // NOT a gate on the pricedata-based valuation itself, which is the primary signal. Defaults
    // are loose (1 sale, don't require CCO's "valid" flag) because a young auction house has few
    // closed sales to calibrate from -- tighten these once there's enough volume that noisy
    // samples are worth filtering out.
    minComparableSales: 1,
    requireValid: false,
    minCalibrationSamples: 1,
    // Confirmed exchange rate: 10 tokens = $1. Set to null to fall back to self-calibrating from
    // CCO's own comparable sales instead (see getTokensPerDollar() in pricing.js) -- kept as an
    // option in case the real rate ever changes or turns out to vary by item tier.
    manualTokensPerDollar: 10,
  },
  limits: {
    // Hard stop on cumulative NEW token commitments this run. Resets on server restart.
    // Keep this conservative until you trust the rules -- raise it once dry-run output looks right.
    sessionSpendCap: 10000000,
    maxConcurrentTracked: 300,
  },
  defaultRule: {
    enabled: false,
    thresholdPct: 65,
    maxBidPct: 85,
  },
  rules: [],
  // Substrings matched (case-insensitive) against a skin's name, purely to sort/flag them in the
  // dashboard's tracked-auctions table -- doesn't affect bidding decisions on its own.
  favorites: [],
};

function deepMerge(base, override) {
  if (override == null) return base;
  if (Array.isArray(base)) return Array.isArray(override) ? override : base;
  if (typeof base === 'object' && base !== null) {
    const out = { ...base };
    for (const k of Object.keys(override)) {
      out[k] = deepMerge(base[k], override[k]);
    }
    return out;
  }
  return override === undefined ? base : override;
}

function loadJson(p, fallback) {
  try {
    if (!fs.existsSync(p)) return fallback;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    console.error(`[store] failed to read ${p}, using fallback:`, e.message);
    return fallback;
  }
}

function saveJson(p, data) {
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, p);
}

class Store {
  constructor() {
    this.settings = deepMerge(DEFAULT_SETTINGS, loadJson(SETTINGS_PATH, {}));
    // deepMerge here too, not a plain load -- data/runtime.json persists across restarts, so a
    // file written before a new field existed (e.g. ruleStats, added after calibration was
    // already shipping) would otherwise come back missing that key entirely and crash the first
    // thing that reads it.
    this.runtime = deepMerge({
      ledger: { heldByAuction: {}, sessionCommitted: 0 },
      stats: { bidsPlaced: 0, autobidsSet: 0, won: 0, lost: 0, totalSpentOnWins: 0, totalMarketValueOnWins: 0 },
      cooldowns: {}, // auctionId -> ISO timestamp until which we skip it
      calibration: { samplesByAuction: {} }, // $->tokens FX calibration samples, see pricing.js
      ruleStats: {}, // ruleId -> { itemsWon, totalSpentTokens } -- backs a rule's maxItemsToWin/maxTotalSpend caps
    }, loadJson(RUNTIME_PATH, {}));
    this._logBuf = this._loadRecentLog(200);
    this._saveTimer = null;
    this._subscribers = new Set();
  }

  _loadRecentLog(n) {
    try {
      if (!fs.existsSync(LOG_PATH)) return [];
      const lines = fs.readFileSync(LOG_PATH, 'utf8').trim().split('\n').filter(Boolean);
      return lines.slice(-n).map((l) => JSON.parse(l));
    } catch {
      return [];
    }
  }

  onChange(fn) {
    this._subscribers.add(fn);
    return () => this._subscribers.delete(fn);
  }

  _notify(type, payload) {
    for (const fn of this._subscribers) {
      try { fn(type, payload); } catch (e) { console.error('[store] subscriber error', e); }
    }
  }

  saveSettingsSoon() {
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => {
      saveJson(SETTINGS_PATH, this.settings);
    }, 250);
  }

  saveRuntimeSoon() {
    clearTimeout(this._runtimeTimer);
    this._runtimeTimer = setTimeout(() => {
      saveJson(RUNTIME_PATH, this.runtime);
    }, 250);
  }

  updateSettings(patch) {
    this.settings = deepMerge(this.settings, patch);
    this.saveSettingsSoon();
    this._notify('settings', this.settings);
    return this.settings;
  }

  addRule(rule) {
    const id = rule.id || `r_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const full = { enabled: true, thresholdPct: 65, maxBidPct: 85, match: {}, ...rule, id };
    this.settings.rules.push(full);
    this.saveSettingsSoon();
    this._notify('settings', this.settings);
    return full;
  }

  updateRule(id, patch) {
    const idx = this.settings.rules.findIndex((r) => r.id === id);
    if (idx === -1) return null;
    this.settings.rules[idx] = { ...this.settings.rules[idx], ...patch, id };
    this.saveSettingsSoon();
    this._notify('settings', this.settings);
    return this.settings.rules[idx];
  }

  removeRule(id) {
    this.settings.rules = this.settings.rules.filter((r) => r.id !== id);
    this.saveSettingsSoon();
    this._notify('settings', this.settings);
  }

  log(level, message, data) {
    const entry = { ts: new Date().toISOString(), level, message, data: data ?? null };
    this._logBuf.push(entry);
    if (this._logBuf.length > 500) this._logBuf.shift();
    fs.appendFile(LOG_PATH, JSON.stringify(entry) + '\n', () => {});
    const line = `[${entry.ts}] ${level.toUpperCase()} ${message}`;
    if (level === 'error') console.error(line, data ?? '');
    else console.log(line, data ?? '');
    this._notify('log', entry);
    return entry;
  }

  recentLog(n = 200) {
    return this._logBuf.slice(-n);
  }

  setHeld(auctionId, amount) {
    if (amount > 0) this.runtime.ledger.heldByAuction[auctionId] = amount;
    else delete this.runtime.ledger.heldByAuction[auctionId];
    this.saveRuntimeSoon();
    this._notify('ledger', this.runtime.ledger);
  }

  addSessionCommitted(delta) {
    this.runtime.ledger.sessionCommitted = (this.runtime.ledger.sessionCommitted || 0) + delta;
    this.saveRuntimeSoon();
    this._notify('ledger', this.runtime.ledger);
  }

  totalHeld() {
    return Object.values(this.runtime.ledger.heldByAuction).reduce((a, b) => a + b, 0);
  }

  setCooldown(auctionId, untilMs) {
    this.runtime.cooldowns[auctionId] = untilMs;
    this.saveRuntimeSoon();
  }

  isOnCooldown(auctionId) {
    const until = this.runtime.cooldowns[auctionId];
    return typeof until === 'number' && until > Date.now();
  }

  recordOutcome({ won, spent, marketValue }) {
    const s = this.runtime.stats;
    if (won) {
      s.won += 1;
      s.totalSpentOnWins += spent || 0;
      s.totalMarketValueOnWins += marketValue || 0;
    } else {
      s.lost += 1;
    }
    this.saveRuntimeSoon();
    this._notify('stats', s);
  }

  bumpBidsPlaced() {
    this.runtime.stats.bidsPlaced += 1;
    this.saveRuntimeSoon();
    this._notify('stats', this.runtime.stats);
  }

  bumpAutobidsSet() {
    this.runtime.stats.autobidsSet += 1;
    this.saveRuntimeSoon();
    this._notify('stats', this.runtime.stats);
  }

  ruleStatsFor(ruleId) {
    return this.runtime.ruleStats[ruleId] || { itemsWon: 0, totalSpentTokens: 0 };
  }

  recordRuleWin(ruleId, spentTokens) {
    if (!ruleId) return;
    const cur = this.ruleStatsFor(ruleId);
    this.runtime.ruleStats[ruleId] = { itemsWon: cur.itemsWon + 1, totalSpentTokens: cur.totalSpentTokens + (spentTokens || 0) };
    this.saveRuntimeSoon();
    this._notify('ruleStats', this.runtime.ruleStats);
  }
}

export const store = new Store();
