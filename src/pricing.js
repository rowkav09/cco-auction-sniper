// Ports the market-value logic from the "Case Clicker Pricedata Overlay" userscript
// (https://github.com/rowkav09/CCO-scripts-archive) so we can estimate a skin's *dollar*
// value the same way that overlay does. IMPORTANT: auctions are denominated in a separate
// "tokens" currency, not dollars -- see valuateAuction() below for how the two are reconciled.
import { store } from './store.js';
import { getAuctionHistory } from './ccoRest.js';

const SHEET_ID = '1DmJr6L6oIUZPDUZBg0DxnqZ8Xhk7nhzLOy6jv3yi02A';
const PRICE_DATA_GID = 1858636668;
const LIST_GID = 1167749951;
const LIST_PUB_ID = '2PACX-1vQHX9j8A3dRJrJS-J7Zs7PcIAC-5CgBydhFVOELd92PqPZY2VdJXEDtk4AIDgVl1-lnO_JcV3pBGouy';

const REFRESH_MS = 5 * 60 * 1000;
const MAX_REFRESH_MS = 30 * 60 * 1000;
const QUALITY_BASE = 7;
const EXT_COL = { 'Factory New': 4, 'Minimal Wear': 5, 'Field-Tested': 6, 'Well-Worn': 7, 'Battle-Scarred': 8 };

// Patterns flagged as event drops with no EV multiplier documented in the sheet.
const EVENT_EV_FALLBACK_BY_PATTERN_ID = {
  '65a652a7fdd7ea906a8f8767': 3000000, // Talon Knife | Fade '100% Fade'
  '65a652acfdd7ea906a8f8768': 800000, // Talon Knife | Fade '80% Fade'
};

function csvUrl(gid) {
  return `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&gid=${gid}`;
}
function listCsvUrl() {
  return `https://docs.google.com/spreadsheets/d/e/${LIST_PUB_ID}/pub?gid=${LIST_GID}&single=true&output=csv`;
}

function parseCSV(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else { inQuotes = false; } }
      else field += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else if (c === '\r') { /* skip */ }
      else field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function parseMagnitude(str) {
  if (str == null) return null;
  str = String(str).trim();
  if (!str || str.toUpperCase() === 'N/A') return null;
  const m = str.match(/^([\-+]?[\d.,]+)\s*([kKmMbB])?$/);
  if (!m) { const n = parseFloat(str.replace(/,/g, '')); return isNaN(n) ? null : n; }
  let n = parseFloat(m[1].replace(/,/g, ''));
  if (isNaN(n)) return null;
  const suf = (m[2] || '').toLowerCase();
  if (suf === 'k') n *= 1e3; else if (suf === 'm') n *= 1e6; else if (suf === 'b') n *= 1e9;
  return n;
}

function parseAdjustment(str) {
  if (str == null) return null;
  str = String(str).trim();
  if (!str || str.toUpperCase() === 'N/A') return null;
  if (str[0] === 'x' || str[0] === 'X') { const v = parseFloat(str.slice(1)); return isNaN(v) ? null : { type: 'mult', value: v }; }
  if (str[0] === '+') { const v = parseMagnitude(str.slice(1)); return v == null ? null : { type: 'add', value: v }; }
  if (str[0] === '-') { const v = parseMagnitude(str.slice(1)); return v == null ? null : { type: 'add', value: -v }; }
  const setVal = parseMagnitude(str);
  if (setVal != null) return { type: 'set', value: setVal };
  return null;
}

function applyAdjustment(base, adj) {
  if (adj.type === 'mult') return base * adj.value;
  if (adj.type === 'set') return adj.value;
  return base + adj.value; // 'add'
}

function getFloatRanks(skin) {
  return skin.floatRanks ? Object.values(skin.floatRanks) : [];
}

/** "1/1": lowest-float AND highest-float instance for its pattern/skingroup within an event --
 * no other copy can hold both extremes. Same index positions calcDollarPrice's 1/1 bonus uses
 * below (18/19 for pattern skins, 6/7 for non-pattern), exported so rule matching can filter on
 * it without duplicating the float-rank indexing logic. */
export function isOneOfOne(skin) {
  const ranks = getFloatRanks(skin);
  if (skin.patternId) return ranks[18] === 1 && ranks[19] === 1;
  return ranks[6] === 1 && ranks[7] === 1;
}

class PriceDataService {
  constructor() {
    this.priceDataByName = new Map();
    this.listByPatternId = new Map();
    this.ready = false;
    this.lastLoadedAt = null;
    this.failures = 0;
    this._timer = null;
  }

  async start() {
    await this.load();
    this._scheduleNext();
  }

  _scheduleNext() {
    clearTimeout(this._timer);
    const delay = Math.min(REFRESH_MS * Math.pow(2, this.failures), MAX_REFRESH_MS);
    this._timer = setTimeout(() => this.load().finally(() => this._scheduleNext()), delay);
  }

  async load() {
    try {
      const [pdText, listText] = await Promise.all([
        fetch(csvUrl(PRICE_DATA_GID)).then((r) => r.text()),
        fetch(listCsvUrl()).then((r) => r.text()),
      ]);
      const pdRows = parseCSV(pdText);
      const newPriceMap = new Map();
      for (let i = 1; i < pdRows.length; i++) {
        const row = pdRows[i];
        if (!row || !row[3]) continue;
        const price = parseFloat(row[11]);
        if (!isNaN(price)) newPriceMap.set(row[3].trim(), price);
      }
      const newListMap = new Map();
      const listRows = parseCSV(listText);
      for (let i = 1; i < listRows.length; i++) {
        const row = listRows[i];
        if (!row || !row[30]) continue;
        newListMap.set(row[30].trim(), row);
      }
      this.priceDataByName = newPriceMap;
      this.listByPatternId = newListMap;
      this.ready = true;
      this.lastLoadedAt = Date.now();
      this.failures = 0;
      store.log('info', `pricedata sheet refreshed (${newPriceMap.size} names, ${newListMap.size} patterns)`);
    } catch (e) {
      this.failures = Math.min(this.failures + 1, 4);
      store.log('error', `pricedata sheet refresh failed: ${e.message}`);
    }
  }

  /** Dollar-denominated estimate, ported from the userscript's calcPrice(). Reference only --
   * do NOT compare this directly against a token-denominated auction bid. */
  calcDollarPrice(skin) {
    const native = (typeof skin.price === 'number' ? skin.price : skin.weaponPrice) || 0;
    if (!this.ready) return { calc: native, native, source: 'loading' };

    const ranks = getFloatRanks(skin);
    const weaponPrice = typeof skin.weaponPrice === 'number' ? skin.weaponPrice : 0;
    const skinPrice = typeof skin.price === 'number' ? skin.price : weaponPrice;
    let price = skinPrice;
    let source = 'fallback-native';

    if (skin.patternId && this.listByPatternId.has(skin.patternId)) {
      const row = this.listByPatternId.get(skin.patternId);
      const skinGroupValue = String(row[3] || '').trim();
      const col = EXT_COL[skin.exterior];
      let wearPrice = col != null ? parseMagnitude(row[col]) : null;
      if (wearPrice == null) wearPrice = parseMagnitude(row[2]);
      let hasPrice = false;
      if (wearPrice != null) { price = wearPrice; hasPrice = true; }

      if (ranks[18] === 1 && ranks[19] === 1) {
        price = skinGroupValue === 'Tier' ? 5000000 : Math.max(5000000, price * 15);
      }

      const skipStForKnife08FN = skinGroupValue === 'Knife08' && skin.exterior === 'Factory New';
      if (skin.statTrak) {
        if (!skipStForKnife08FN) { const adj = parseAdjustment(row[9]); if (adj) price = applyAdjustment(price, adj); }
      } else if (skin.souvenir) {
        const adj = parseAdjustment(row[10]); if (adj) price = applyAdjustment(price, adj);
      }

      if (skin.event) {
        const ev = parseAdjustment(row[11]);
        if (ev) price = applyAdjustment(price, ev);
        else if (EVENT_EV_FALLBACK_BY_PATTERN_ID[skin.patternId] != null) price = EVENT_EV_FALLBACK_BY_PATTERN_ID[skin.patternId];
      }

      const quality = typeof skin.quality === 'number' ? skin.quality : 0;
      if (quality) {
        price = hasPrice ? price : weaponPrice;
        price = price * (quality > 0 ? Math.pow(QUALITY_BASE, quality) : 1);
      }

      if (skinPrice !== weaponPrice) price = price + (skinPrice - weaponPrice);
      source = hasPrice ? 'calculated' : 'calculated-no-wear-price';
    } else if (!skin.patternId) {
      if (ranks[6] === 1 && ranks[7] === 1) price = Math.max(5000000, price);
    }

    if (typeof skin.name === 'string' && skin.name.includes('Terminal')) { price = 25000; source = 'terminal-flat'; }
    if (typeof skin.name === 'string' && skin.name.includes("(Holo) | Katowice 2014")) {
      const kQuality = typeof skin.quality === 'number' ? skin.quality : 0;
      const qsBase = kQuality > 0 ? weaponPrice * Math.pow(QUALITY_BASE, kQuality) : skinPrice;
      price = qsBase * 3;
      source = 'katowice-3x';
    }

    // A skin can be genuinely rare -- an event drop, or holding just one end of a float extreme
    // (rank 1 for lowest OR highest, not both) -- without any of the branches above ever having
    // touched `price`. The formula (ported as-is from the sheet's own methodology) only prices
    // event/near-1-of-1 premiums through the patternId-matched branch or a full lowest+highest
    // 1/1; anything else with these signals silently falls through to the bare native price.
    // Confirmed against a real case: an event-tagged SSG 08 nicknamed "Event HF: #1" (rank 1 for
    // highest-float-in-event-skingroup) priced at its $0.05 native value while actually being bid
    // to $2M+ in the live auction house. Flag it instead of returning a confident-looking number
    // that isn't one -- valuateAuction treats this as low-confidence and won't auto-bid on it.
    const partialFloatExtreme = (ranks[6] === 1) !== (ranks[7] === 1) || (ranks[18] === 1) !== (ranks[19] === 1);
    const unpricedSpecial = source === 'fallback-native' && (!!skin.event || partialFloatExtreme);
    if (unpricedSpecial) source = 'fallback-native-unpriced-special';

    return { calc: price, native, source };
  }
}

export const priceData = new PriceDataService();

const historyCache = new Map(); // auctionId -> { history, fetchedAt }
const HISTORY_TTL_MS = 10 * 60 * 1000;

async function getHistoryCached(auctionId) {
  const cached = historyCache.get(auctionId);
  if (cached && Date.now() - cached.fetchedAt < HISTORY_TTL_MS) return cached.history;
  const history = await getAuctionHistory(auctionId);
  historyCache.set(auctionId, { history, fetchedAt: Date.now() });
  return history;
}

// ---------- $ -> tokens calibration ----------
// Per user request, the pricedata sheet (dollars) is the PRIMARY market-value source, not CCO's
// own comparable-sales feed. But auctions are bid in tokens, so a dollar figure needs converting
// before it can be compared to a bid. Rather than hardcode a guessed ratio (the two data points
// gathered during reconnaissance disagreed by ~100x, so a single constant would be unreliable),
// we derive tokens-per-dollar from CCO's own comparable sales: whenever an auction has enough
// recent comparable sales (tokens) AND a usable pricedata estimate (dollars) for the same skin,
// that pair is one sample of the real exchange rate. The median of recent samples is the live
// rate. `valuation.manualTokensPerDollar` in settings overrides this entirely if set.
function median(nums) {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function recordCalibrationSample(auctionId, ratio) {
  if (!isFinite(ratio) || ratio <= 0) return;
  const cal = store.runtime.calibration || (store.runtime.calibration = { samplesByAuction: {} });
  cal.samplesByAuction[auctionId] = { ratio, ts: Date.now() };
  // Cap the sample set so a huge tracked-auction history doesn't grow this file forever.
  const keys = Object.keys(cal.samplesByAuction);
  if (keys.length > 500) {
    keys.sort((a, b) => cal.samplesByAuction[a].ts - cal.samplesByAuction[b].ts);
    for (const k of keys.slice(0, keys.length - 500)) delete cal.samplesByAuction[k];
  }
  store.saveRuntimeSoon();
}

export function getTokensPerDollar() {
  const manual = store.settings.valuation.manualTokensPerDollar;
  const cal = store.runtime.calibration || { samplesByAuction: {} };
  const ratios = Object.values(cal.samplesByAuction).map((s) => s.ratio);
  if (manual) return { rate: Number(manual), source: 'manual', sampleCount: ratios.length };
  const need = store.settings.valuation.minCalibrationSamples;
  if (ratios.length < need) return { rate: null, source: 'insufficient', sampleCount: ratios.length, need };
  return { rate: median(ratios), source: 'calibrated', sampleCount: ratios.length };
}

/**
 * Primary market-value signal for bidding decisions: the pricedata-sheet dollar estimate
 * (calcDollarPrice, ported from the userscript), converted to tokens via getTokensPerDollar().
 * CCO's own comparable-sale history is used only (a) as calibration input for that conversion
 * rate and (b) as secondary/reference data returned alongside for the dashboard -- it does not
 * gate or override the pricedata-based decision.
 */
export async function valuateAuction(auction) {
  const { minComparableSales, requireValid } = store.settings.valuation;
  let history = null;
  try {
    history = await getHistoryCached(auction._id);
  } catch (e) {
    store.log('error', `history fetch failed for ${auction._id}: ${e.message}`);
  }

  const dollarEstimate = priceData.calcDollarPrice(auction.auctionedSkinId || {});
  const isUnpricedSpecial = dollarEstimate.source === 'fallback-native-unpriced-special';

  // Don't let an unpriced-special's near-zero $ estimate poison the $->tokens calibration --
  // dividing a real comparable-sale price by a ~$0.05 estimate would produce a wildly inflated
  // ratio and drag the calibrated rate off for everything else.
  const historyUsable = history && history.count >= minComparableSales && (!requireValid || history.isValid !== false);
  if (historyUsable && !isUnpricedSpecial && dollarEstimate.source !== 'loading' && dollarEstimate.calc > 0) {
    recordCalibrationSample(auction._id, history.average / dollarEstimate.calc);
  }

  if (dollarEstimate.source === 'loading' || !dollarEstimate.calc) {
    return { marketValueTokens: null, confidence: 'none', reason: 'pricedata sheet not loaded yet', history, dollarEstimate };
  }

  if (isUnpricedSpecial) {
    return {
      marketValueTokens: null,
      confidence: 'unpriced-special',
      reason: 'event/rare-float item the pricing formula has no real number for (falls back to native $ price, which would be misleadingly tiny) -- skipped rather than bid on a guess',
      history, dollarEstimate,
    };
  }

  const fx = getTokensPerDollar();
  if (!fx.rate) {
    return {
      marketValueTokens: null,
      confidence: 'uncalibrated',
      reason: `no $→tokens rate yet (${fx.sampleCount}/${fx.need} comparable-sale samples collected; or set a manual rate in Settings)`,
      history, dollarEstimate, fx,
    };
  }

  return { marketValueTokens: dollarEstimate.calc * fx.rate, confidence: 'ok', reason: null, history, dollarEstimate, fx };
}

export function invalidateHistoryCache(auctionId) {
  historyCache.delete(auctionId);
}
