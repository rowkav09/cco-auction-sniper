import { store } from './store.js';
import { listAuctions, getSession } from './ccoRest.js';
import { ccoSocket } from './ccoSocket.js';
import { valuateAuction, invalidateHistoryCache } from './pricing.js';

// Reverse-engineered from case-clicker.com's client bundle (module 10893 in the auction detail
// page chunk). Increment is 10% of the current bid (1% once the bid crosses 1e9), floored at 1.
// A leading bidder can only self-raise 3 times in a row before the UI locks further raises until
// someone outbids them -- we mirror that so we don't waste an emit that the server will reject.
export const MAX_CONSECUTIVE_BIDS = 3;
export const MAX_SINGLE_BID = 1e9;

export function minBidIncrement(currentBid) {
  const i = Math.max(0, currentBid || 0);
  return Math.max(1, Math.round(i * (i >= 1e9 ? 0.01 : 0.1)));
}

export function minNextBid(currentBid, startingPrice) {
  return currentBid > 0 ? Math.round(currentBid + minBidIncrement(currentBid)) : Math.round(startingPrice);
}

function ruleMatches(match, skin) {
  if (!match) return true;
  const name = (skin.name || '').toLowerCase();
  if (match.nameContains && !name.includes(match.nameContains.toLowerCase())) return false;
  if (match.weaponType && skin.weaponType !== match.weaponType) return false;
  if (match.rarity && skin.rarity !== match.rarity) return false;
  if (match.exterior && skin.exterior !== match.exterior) return false;
  if (match.statTrak != null && match.statTrak !== '' && !!skin.statTrak !== !!match.statTrak) return false;
  if (match.souvenir != null && match.souvenir !== '' && !!skin.souvenir !== !!match.souvenir) return false;
  if (match.minNativePrice != null && match.minNativePrice !== '' && (skin.price || 0) < Number(match.minNativePrice)) return false;
  if (match.maxNativePrice != null && match.maxNativePrice !== '' && (skin.price || 0) > Number(match.maxNativePrice)) return false;
  return true;
}

function findMatchingRule(skin) {
  for (const rule of store.settings.rules) {
    if (rule.enabled && ruleMatches(rule.match, skin)) return rule;
  }
  if (store.settings.defaultRule.enabled) return { ...store.settings.defaultRule, id: 'default', name: 'Default rule', match: {} };
  return null;
}

function skinLabel(skin) {
  if (!skin) return 'unknown skin';
  return `${skin.statTrak ? 'StatTrak™ ' : ''}${skin.name || 'unknown'}`;
}

class Sniper {
  constructor() {
    this.auctions = new Map(); // auctionId -> auction doc (as last known)
    this.ownedByUs = new Map(); // auctionId -> { amount, rule, marketValueTokens } our active commitments
    this.ourUserId = null;
    this._running = false;
    this._discoveryTimers = [];
    this._snipeTicker = null;
    this._listeners = [];
  }

  broadcastState() {
    store._notify('auctions', this.snapshot());
  }

  snapshot() {
    return [...this.auctions.values()].map((a) => ({
      id: a._id,
      name: a.auctionedSkinId?.name,
      statTrak: a.auctionedSkinId?.statTrak,
      exterior: a.auctionedSkinId?.exterior,
      rarity: a.auctionedSkinId?.rarity,
      iconUrl: a.auctionedSkinId?.iconUrl,
      currentBid: a.currentBid,
      startingPrice: a.startingPrice,
      minNextBid: minNextBid(a.currentBid, a.startingPrice),
      bidCount: a.bidCount ?? a.bids?.length ?? 0,
      expiresAt: a.expiresAt,
      status: a.status,
      isLocked: a.isLocked,
      currentBidder: a.currentBidder,
      isLeading: a.currentBidder === this.ourUserId,
      consecutiveBidCount: a.consecutiveBidCount || 0,
      sellerName: a.seller?.name,
      lastDecision: a._decision || null,
      marketValueTokens: a._marketValueTokens ?? null,
      valuationConfidence: a._valuationConfidence ?? null,
      cooldown: store.isOnCooldown(a._id),
    })).sort((x, y) => new Date(x.expiresAt) - new Date(y.expiresAt));
  }

  async start() {
    if (this._running) return;
    this._running = true;

    try {
      const session = await getSession();
      this.ourUserId = session?.user?.id || null;
      store.log('info', `identified as user ${session?.user?.name || '?'} (${this.ourUserId || 'unknown id'})`);
    } catch (e) {
      store.log('error', `could not fetch session (check cookie/UA in settings): ${e.message}`);
    }

    ccoSocket.connect();
    this._wireSocketEvents();

    await this.pollNewest();
    await this.pollFull();

    this._discoveryTimers.push(setInterval(() => this.pollNewest().catch((e) => store.log('error', `pollNewest failed: ${e.message}`)), store.settings.discovery.newestPollMs));
    this._discoveryTimers.push(setInterval(() => this.pollFull().catch((e) => store.log('error', `pollFull failed: ${e.message}`)), store.settings.discovery.fullPollMs));
    this._snipeTicker = setInterval(() => this.snipeTick(), 1000);

    store.log('info', 'sniper engine started');
  }

  stop() {
    this._running = false;
    for (const t of this._discoveryTimers) clearInterval(t);
    this._discoveryTimers = [];
    if (this._snipeTicker) clearInterval(this._snipeTicker);
    for (const off of this._listeners) off();
    this._listeners = [];
    ccoSocket.disconnect();
    store.log('info', 'sniper engine stopped');
  }

  _wireSocketEvents() {
    const on = (evt, fn) => { ccoSocket.on(evt, fn); this._listeners.push(() => ccoSocket.off(evt, fn)); };

    on('auctionUpdated', (p) => this._onAuctionUpdated(p));
    on('auctionEnded', (p) => this._onAuctionEnded(p));
    on('auctionCancelled', (p) => this._onAuctionRemoved(p, 'cancelled'));
    on('bidPlaced', (p) => store.log('info', `bid placed on ${p?.auctionId || '?'}`, p));
    on('bidRejected', (p) => this._onFailure(p, 'bid rejected'));
    on('outbid', (p) => {
      store.log('info', `outbid on ${p?.auctionId || '?'}`, p);
      const a = this.auctions.get(p?.auctionId);
      if (a) this.evaluateAuction(a).catch((e) => store.log('error', `re-evaluate after outbid failed: ${e.message}`));
    });
    on('autobidFailed', (p) => this._onFailure(p, 'autobid failed'));
    on('autobidSet', (p) => store.log('info', `autobid confirmed on ${p?.auctionId || '?'}`, p));
    on('autobidRemoved', (p) => { if (p?.auctionId) { this.ownedByUs.delete(p.auctionId); store.setHeld(p.auctionId, 0); } });
    on('auctionError', (p) => this._onFailure(p, 'auction error'));
  }

  _onFailure(payload, label) {
    const id = payload?.auctionId;
    store.log('error', `${label}${id ? ` on ${id}` : ''}: ${payload?.reason || payload?.message || 'no reason given'}`, payload);
    if (id) {
      store.setCooldown(id, Date.now() + 10 * 60 * 1000);
      this.ownedByUs.delete(id);
      store.setHeld(id, 0);
    }
  }

  _mergeAuctionFields(existing, patch) {
    const next = existing ? { ...existing } : {};
    for (const [k, v] of Object.entries(patch)) {
      if (v !== undefined) next[k] = v;
    }
    return next;
  }

  _onAuctionUpdated(payload) {
    if (!payload?.auctionId) return;
    const existing = this.auctions.get(payload.auctionId);
    const merged = this._mergeAuctionFields(existing, {
      _id: payload.auctionId,
      currentBid: payload.currentBid,
      currentBidder: payload.currentBidder,
      consecutiveBidCount: payload.consecutiveBidCount,
      expiresAt: payload.expiresAt,
      bids: payload.bids,
      autobids: payload.autobids,
      bidCount: payload.bidCount,
      status: payload.status,
    });
    this.auctions.set(payload.auctionId, merged);
    if (payload.extended) store.log('info', `auction extended (anti-snipe): ${skinLabel(merged.auctionedSkinId)}`, { auctionId: payload.auctionId });
    invalidateHistoryCache(payload.auctionId);
    this.evaluateAuction(merged).catch((e) => store.log('error', `evaluate failed: ${e.message}`));
    this.broadcastState();
  }

  _onAuctionEnded(payload) {
    const id = payload?.auctionId;
    if (!id) return;
    const wonByUs = payload.winnerId && this.ourUserId && payload.winnerId === this.ourUserId;
    const owned = this.ownedByUs.get(id);
    if (owned || wonByUs) {
      store.recordOutcome({ won: !!wonByUs, spent: wonByUs ? payload.finalPrice : 0, marketValue: owned?.marketValueTokens });
      store.log(wonByUs ? 'info' : 'info', wonByUs ? `WON auction: ${skinLabel(this.auctions.get(id)?.auctionedSkinId)} for ${payload.finalPrice} tokens` : `lost auction we were tracking: ${skinLabel(this.auctions.get(id)?.auctionedSkinId)}`, payload);
    }
    this._onAuctionRemoved(payload, 'ended');
  }

  _onAuctionRemoved(payload, why) {
    const id = payload?.auctionId;
    if (!id) return;
    this.auctions.delete(id);
    this.ownedByUs.delete(id);
    store.setHeld(id, 0);
    this.broadcastState();
  }

  async pollNewest() {
    const j = await listAuctions({ page: 1, limit: 50, sort: 'newest', includeEnded: store.settings.discovery.includeEnded });
    this._ingest(j?.auctions || []);
  }

  async pollFull() {
    const maxPages = 20;
    let page = 1;
    let all = [];
    while (page <= maxPages) {
      const j = await listAuctions({ page, limit: 100, sort: 'endingSoon', includeEnded: false });
      const auctions = j?.auctions || [];
      all = all.concat(auctions);
      const pages = j?.pages || 1;
      if (page >= pages || auctions.length === 0) break;
      if (all.length >= store.settings.limits.maxConcurrentTracked) break;
      page++;
    }
    this._ingest(all);
    // We don't prune auctions missing from this sweep: pagination is capped at maxPages, so an
    // absence here doesn't mean the auction ended. Removal normally happens on an explicit
    // auctionEnded/auctionCancelled event from the socket; this is just a safety net for entries
    // that went stale because we missed that event (e.g. a socket outage).
    const staleCutoff = Date.now() - 5 * 60 * 1000;
    for (const [id, a] of this.auctions) {
      if (!this.ownedByUs.has(id) && new Date(a.expiresAt).getTime() < staleCutoff) {
        this.auctions.delete(id);
      }
    }
    ccoSocket.setSubscriptions([...this.auctions.keys()]);
    this.broadcastState();
  }

  _ingest(list) {
    for (const a of list) {
      const existing = this.auctions.get(a._id);
      this.auctions.set(a._id, existing ? { ...a, ...pickLiveFields(existing) } : a);
      this.evaluateAuction(this.auctions.get(a._id)).catch((e) => store.log('error', `evaluate failed: ${e.message}`));
    }
  }

  snipeTick() {
    if (store.settings.strategy !== 'snipe') return;
    const now = Date.now();
    for (const a of this.auctions.values()) {
      if (a.status !== 'active' || a.isLocked) continue;
      if (a.currentBidder === this.ourUserId) continue;
      const msLeft = new Date(a.expiresAt).getTime() - now;
      if (msLeft <= store.settings.snipeSeconds * 1000 && msLeft > -5000) {
        this.evaluateAuction(a, { forceSnipeNow: true }).catch((e) => store.log('error', `snipe tick failed: ${e.message}`));
      }
    }
  }

  async evaluateAuction(auction, opts = {}) {
    if (!auction || auction.status !== 'active' || auction.isLocked) return;
    if (store.isOnCooldown(auction._id)) return;
    const skin = auction.auctionedSkinId;
    if (!skin) return;

    const rule = findMatchingRule(skin);
    if (!rule) { auction._decision = { verdict: 'no-rule', at: Date.now() }; return; }

    const isLeading = this.ourUserId && auction.currentBidder === this.ourUserId;
    if (isLeading) {
      auction._decision = { verdict: 'leading', at: Date.now(), rule: rule.name || rule.id };
      return;
    }

    const valuation = await valuateAuction(auction);
    auction._marketValueTokens = valuation.marketValueTokens;
    auction._valuationConfidence = valuation.confidence;
    if (valuation.confidence !== 'ok') {
      auction._decision = { verdict: 'skip', reason: valuation.reason, at: Date.now(), rule: rule.name || rule.id };
      return;
    }

    const marketValue = valuation.marketValueTokens;
    const minNext = minNextBid(auction.currentBid, auction.startingPrice);
    const thresholdPrice = marketValue * (rule.thresholdPct / 100);
    let maxBid = marketValue * (rule.maxBidPct / 100);
    if (rule.maxBidAbsolute) maxBid = Math.min(maxBid, Number(rule.maxBidAbsolute));
    maxBid = Math.min(maxBid, MAX_SINGLE_BID);

    if ((auction.consecutiveBidCount || 0) >= MAX_CONSECUTIVE_BIDS) {
      auction._decision = { verdict: 'skip', reason: 'we already hit the consecutive-bid limit here', at: Date.now(), rule: rule.name || rule.id };
      return;
    }
    if (minNext > maxBid) {
      auction._decision = { verdict: 'skip', reason: `min next bid ${fmt(minNext)} exceeds our max bid ${fmt(maxBid)} (${rule.maxBidPct}% of ${fmt(marketValue)} market value)`, at: Date.now(), rule: rule.name || rule.id };
      return;
    }
    if (minNext > thresholdPrice) {
      auction._decision = { verdict: 'skip', reason: `min next bid ${fmt(minNext)} is above our ${rule.thresholdPct}% threshold (${fmt(thresholdPrice)})`, at: Date.now(), rule: rule.name || rule.id };
      return;
    }

    const strategy = store.settings.strategy;
    if (strategy === 'snipe') {
      const msLeft = new Date(auction.expiresAt).getTime() - Date.now();
      const withinWindow = msLeft <= store.settings.snipeSeconds * 1000;
      if (!withinWindow && !opts.forceSnipeNow) {
        auction._decision = { verdict: 'waiting-to-snipe', reason: `attractive (min next ${fmt(minNext)} <= threshold ${fmt(thresholdPrice)}), will bid in the final ${store.settings.snipeSeconds}s`, at: Date.now(), rule: rule.name || rule.id };
        return;
      }
    }

    const projected = strategy === 'autobid' ? maxBid : minNext;
    const sessionCommitted = store.runtime.ledger.sessionCommitted || 0;
    if (sessionCommitted + projected > store.settings.limits.sessionSpendCap) {
      auction._decision = { verdict: 'skip', reason: `would exceed session spend cap (${fmt(store.settings.limits.sessionSpendCap)} tokens)`, at: Date.now(), rule: rule.name || rule.id };
      store.log('warn', `session spend cap reached, skipping ${skinLabel(skin)}`);
      return;
    }

    if (store.settings.dryRun) {
      auction._decision = {
        verdict: 'would-bid',
        reason: `[dry run] would ${strategy === 'autobid' ? `set autobid up to ${fmt(maxBid)}` : `place bid of ${fmt(minNext)}`} (market value ${fmt(marketValue)} tokens = $${fmt(valuation.dollarEstimate?.calc)} pricedata x ${valuation.fx?.rate?.toFixed(2)} tokens/$ [${valuation.fx?.source}])`,
        at: Date.now(),
        rule: rule.name || rule.id,
      };
      return;
    }

    try {
      if (strategy === 'autobid') {
        ccoSocket.setAutobid(auction._id, maxBid);
        store.bumpAutobidsSet();
        this.ownedByUs.set(auction._id, { amount: maxBid, rule: rule.id, marketValueTokens: marketValue });
        store.setHeld(auction._id, maxBid);
        store.addSessionCommitted(maxBid);
        auction._decision = { verdict: 'autobid-set', reason: `autobid up to ${fmt(maxBid)} tokens (market value ${fmt(marketValue)})`, at: Date.now(), rule: rule.name || rule.id };
        store.log('info', `set autobid on ${skinLabel(skin)}: up to ${fmt(maxBid)} tokens`, { auctionId: auction._id, marketValue });
      } else {
        ccoSocket.placeBid(auction._id, minNext);
        store.bumpBidsPlaced();
        this.ownedByUs.set(auction._id, { amount: minNext, rule: rule.id, marketValueTokens: marketValue });
        store.setHeld(auction._id, minNext);
        store.addSessionCommitted(minNext);
        auction._decision = { verdict: 'bid-placed', reason: `bid ${fmt(minNext)} tokens (market value ${fmt(marketValue)})`, at: Date.now(), rule: rule.name || rule.id };
        store.log('info', `placed snipe bid on ${skinLabel(skin)}: ${fmt(minNext)} tokens`, { auctionId: auction._id, marketValue });
      }
    } catch (e) {
      store.log('error', `emit failed for ${auction._id}: ${e.message}`);
    }
  }
}

function pickLiveFields(existing) {
  // When a REST poll re-fetches an auction we already have fresher socket data for, keep the
  // socket-derived bid fields (they're pushed in real time; REST snapshots can be seconds stale).
  const keys = ['currentBid', 'currentBidder', 'consecutiveBidCount', 'expiresAt', 'bidCount', 'bids', 'autobids', 'status'];
  const out = {};
  for (const k of keys) if (existing[k] !== undefined) out[k] = existing[k];
  return out;
}

function fmt(n) {
  if (n == null || isNaN(n)) return '?';
  return Math.round(n).toLocaleString('en-US');
}

export const sniper = new Sniper();
