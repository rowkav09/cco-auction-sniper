import { store } from './store.js';
import { listAuctions } from './ccoRest.js';
import { ccoSocket } from './ccoSocket.js';
import { browserSession } from './browserSession.js';
import { valuateAuction, invalidateHistoryCache, isOneOfOne } from './pricing.js';

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
  if (match.weaponType) {
    // Gloves aren't a weaponType value in CCO's own data (they're a separate top-level `type`),
    // so "Gloves" needs its own check rather than a plain weaponType equality.
    if (match.weaponType === 'Gloves') { if (skin.type !== 'Gloves') return false; }
    else if (skin.weaponType !== match.weaponType) return false;
  }
  if (match.rarity && skin.rarity !== match.rarity) return false;
  if (match.exterior && skin.exterior !== match.exterior) return false;
  if (match.statTrak != null && match.statTrak !== '' && !!skin.statTrak !== !!match.statTrak) return false;
  if (match.souvenir != null && match.souvenir !== '' && !!skin.souvenir !== !!match.souvenir) return false;
  if (match.isEvent != null && match.isEvent !== '' && !!skin.event !== !!match.isEvent) return false;
  if (match.isOneOfOne != null && match.isOneOfOne !== '' && isOneOfOne(skin) !== !!match.isOneOfOne) return false;
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

function isFavoriteSkin(skin) {
  const favorites = store.settings.favorites || [];
  if (!favorites.length || !skin?.name) return false;
  const name = skin.name.toLowerCase();
  return favorites.some((f) => f && name.includes(f.toLowerCase()));
}

class Sniper {
  constructor() {
    this.auctions = new Map(); // auctionId -> auction doc (as last known)
    this.ownedByUs = new Map(); // auctionId -> { amount, rule, marketValueTokens } our active commitments
    // CCO's REST /api/auctions responses don't reliably carry the autobids array back (confirmed
    // empty even right after a just-confirmed autobid), so track our own autobid registrations
    // locally off the socket confirmations instead of trying to read them back from auction data.
    this.myAutobids = new Map(); // auctionId -> maxBid
    this.ourUserId = null;
    this._running = false;
    this._discoveryTimers = [];
    this._snipeTicker = null;
    this._listeners = [];
    this._spendCapWarned = new Map(); // auctionId -> last time we logged a spend-cap skip for it
  }

  /** Coalesces bursts of updates (a live auction house can push several auctionUpdated events a
   * second across the auctions we're subscribed to) into at most one dashboard refresh per
   * ~800ms, instead of a full-table re-render (and re-sort) on every single one -- that was
   * making the tracked-auctions table visibly jump around and made the quick-action buttons hard
   * to click since the row underneath them kept getting rebuilt mid-click. */
  broadcastState() {
    if (this._broadcastTimer) return;
    this._broadcastTimer = setTimeout(() => {
      this._broadcastTimer = null;
      store._notify('auctions', this.snapshot());
    }, 800);
  }

  broadcastStateImmediately() {
    clearTimeout(this._broadcastTimer);
    this._broadcastTimer = null;
    store._notify('auctions', this.snapshot());
  }

  /** Weapon type and rarity strings aren't a documented enum (and aren't consistently pluralized
   * -- "Rifles" but "Knife", confirmed empirically) so rather than hardcode a guessed list for
   * the rule-builder dropdowns, derive it from what's actually showing up in tracked auctions. */
  knownCategories() {
    const weaponTypes = new Set();
    const rarities = new Set();
    for (const a of this.auctions.values()) {
      const skin = a.auctionedSkinId;
      if (!skin) continue;
      if (skin.weaponType) weaponTypes.add(skin.weaponType);
      if (skin.type === 'Gloves') weaponTypes.add('Gloves');
      if (skin.rarity) rarities.add(skin.rarity);
    }
    return {
      weaponTypes: [...weaponTypes].sort(),
      rarities: [...rarities].sort(),
    };
  }

  snapshot() {
    return [...this.auctions.values()].map((a) => {
      const myAutobidMax = this.myAutobids.get(a._id) ?? null;
      return {
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
        marketValueDollars: a._marketValueDollars ?? null,
        fxSource: a._fxSource ?? null,
        valuationConfidence: a._valuationConfidence ?? null,
        cooldown: store.isOnCooldown(a._id),
        isFavorite: isFavoriteSkin(a.auctionedSkinId),
        hasAutobid: myAutobidMax != null,
        autobidMax: myAutobidMax,
      };
    }).sort((x, y) => new Date(x.expiresAt) - new Date(y.expiresAt));
  }

  async start() {
    if (this._running) return;
    this._running = true;

    try {
      await browserSession.start(); // opens/reuses the Chrome window, blocks here until logged in
    } catch (e) {
      // Don't leave _running stuck true on a failed launch -- that would permanently block every
      // future start() call via the guard above, since nothing else ever resets it.
      this._running = false;
      throw e;
    }
    this.ourUserId = browserSession.userId;
    store.log('info', `identified as user ${browserSession.userName || '?'} (${this.ourUserId || 'unknown id'})`);

    // If the Chrome window gets closed, every poll/emit will keep failing forever otherwise --
    // stop cleanly instead of hammering a dead browser with retries every few seconds.
    browserSession.once('closed', () => { if (this._running) this.stop(); });

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
      // CCO releases held tokens the instant you're outbid (that's what "held until someone
      // outbids you" on the auction page means) -- mirror that immediately rather than leaving
      // the held amount counted until the auction eventually ends. If we're still in this via an
      // autobid and it re-takes the lead, _executeAutobid sets it right back on the next
      // evaluation below; if not, the budget now correctly reflects that this money isn't at
      // risk here anymore.
      if (p?.auctionId) store.setHeld(p.auctionId, 0);
      const a = this.auctions.get(p?.auctionId);
      if (a) this.evaluateAuction(a).catch((e) => store.log('error', `re-evaluate after outbid failed: ${e.message}`));
    });
    on('autobidFailed', (p) => this._onFailure(p, 'autobid failed'));
    on('autobidSet', (p) => {
      store.log('info', `autobid confirmed on ${p?.auctionId || '?'}`, p);
      if (p?.auctionId && p?.maxBid != null) this.myAutobids.set(p.auctionId, p.maxBid);
    });
    on('autobidRemoved', (p) => {
      if (p?.auctionId) { this.ownedByUs.delete(p.auctionId); this.myAutobids.delete(p.auctionId); store.setHeld(p.auctionId, 0); }
    });
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
      if (wonByUs && owned?.ruleId) store.recordRuleWin(owned.ruleId, payload.finalPrice, owned.marketValueTokens);
      store.log(wonByUs ? 'info' : 'info', wonByUs ? `WON auction: ${skinLabel(this.auctions.get(id)?.auctionedSkinId)} for ${payload.finalPrice} tokens` : `lost auction we were tracking: ${skinLabel(this.auctions.get(id)?.auctionedSkinId)}`, payload);
    }
    this._onAuctionRemoved(payload, 'ended');
  }

  _onAuctionRemoved(payload, why) {
    const id = payload?.auctionId;
    if (!id) return;
    this.auctions.delete(id);
    this.ownedByUs.delete(id);
    this.myAutobids.delete(id);
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

  /** Re-runs valuation/rule evaluation for every currently tracked auction without a fresh REST
   * sweep -- used when a settings change (FX rate, rules, thresholds) should immediately update
   * what's already on screen instead of waiting for the next bid event or poll to touch each one. */
  async reevaluateAll() {
    await Promise.all([...this.auctions.values()].map((auction) =>
      this.evaluateAuction(auction).catch((e) => store.log('error', `re-evaluate failed: ${e.message}`))
    ));
    this.broadcastStateImmediately();
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

    // Valuation runs regardless of rule match / leading status so the dashboard always shows the
    // pricedata-script estimate for every tracked auction, not just the ones we're bidding on.
    const valuation = await valuateAuction(auction);
    auction._marketValueTokens = valuation.marketValueTokens;
    auction._marketValueDollars = valuation.dollarEstimate?.calc ?? null;
    auction._valuationConfidence = valuation.confidence;
    auction._fxSource = valuation.fx?.source ?? null;

    const rule = findMatchingRule(skin);
    if (!rule) { auction._decision = { verdict: 'no-rule', at: Date.now() }; return; }

    const isLeading = this.ourUserId && auction.currentBidder === this.ourUserId;
    if (isLeading) {
      auction._decision = { verdict: 'leading', at: Date.now(), rule: rule.name || rule.id };
      return;
    }

    if (valuation.confidence !== 'ok') {
      auction._decision = { verdict: 'skip', reason: valuation.reason, at: Date.now(), rule: rule.name || rule.id };
      return;
    }

    const ruleStats = store.ruleStatsFor(rule.id);
    if (rule.maxItemsToWin && ruleStats.itemsWon >= Number(rule.maxItemsToWin)) {
      auction._decision = { verdict: 'skip', reason: `rule has already won its limit of ${rule.maxItemsToWin} item(s)`, at: Date.now(), rule: rule.name || rule.id };
      return;
    }

    const marketValue = valuation.marketValueTokens;
    const minNext = minNextBid(auction.currentBid, auction.startingPrice);
    const thresholdPrice = marketValue * (rule.thresholdPct / 100);
    let maxBid = marketValue * (rule.maxBidPct / 100);
    if (rule.maxBidAbsolute) maxBid = Math.min(maxBid, Number(rule.maxBidAbsolute));
    maxBid = Math.min(maxBid, MAX_SINGLE_BID);

    if (rule.maxTotalSpend && ruleStats.totalSpentTokens + maxBid > Number(rule.maxTotalSpend)) {
      // Clamp rather than skip outright -- if there's still some budget left, bid up to what's
      // left instead of giving up on an otherwise-attractive auction entirely.
      const remaining = Math.max(0, Number(rule.maxTotalSpend) - ruleStats.totalSpentTokens);
      if (remaining <= 0) {
        auction._decision = { verdict: 'skip', reason: `rule has already spent its ${fmt(Number(rule.maxTotalSpend))}-token budget`, at: Date.now(), rule: rule.name || rule.id };
        return;
      }
      maxBid = Math.min(maxBid, remaining);
    }

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
    // Gate on what's actually AT RISK right now (current holds), not the lifetime sum of every
    // commitment ever made -- that sum never goes back down even after being outbid releases the
    // hold, so it very quickly overstates real exposure (a user caught this: "150m committed but
    // only 8m is actually max loss"). totalHeld() reflects only auctions we're presently leading.
    const currentlyAtRisk = store.totalHeld();
    if (currentlyAtRisk + projected > store.settings.limits.allocation) {
      auction._decision = { verdict: 'skip', reason: `would exceed bot allocation (${fmt(store.settings.limits.allocation)} tokens)`, at: Date.now(), rule: rule.name || rule.id };
      // This auction gets re-evaluated on every bid anywhere in it plus every poll cycle, so
      // without throttling this was re-logging the identical warning every few seconds for as
      // long as the auction stayed above the cap -- the decision column in the tracked-auctions
      // table already shows this per-row continuously, so the activity log only needs it once in
      // a while as a heads-up, not on every pass.
      const lastWarned = this._spendCapWarned.get(auction._id) || 0;
      if (Date.now() - lastWarned > 10 * 60 * 1000) {
        this._spendCapWarned.set(auction._id, Date.now());
        store.log('warn', `bot allocation reached, skipping ${skinLabel(skin)}`);
      }
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

    if (strategy === 'autobid') {
      await this._executeAutobid(auction, skin, maxBid, marketValue, rule.name || rule.id, rule.id);
    } else {
      await this._executeSnipeBid(auction, skin, minNext, marketValue, rule.name || rule.id, rule.id);
    }
  }

  /** Sets an autobid and records the (worst-case) commitment. Used by both the rule engine and
   * the dashboard's manual quick-action buttons (which pass ruleId undefined -- a manual bid
   * isn't attributed to any rule's maxItemsToWin/maxTotalSpend caps). Caller is responsible for
   * dry-run/cap checks. */
  async _executeAutobid(auction, skin, maxBid, marketValue, ruleLabel, ruleId) {
    try {
      await ccoSocket.setAutobid(auction._id, maxBid);
      store.bumpAutobidsSet();
      this.ownedByUs.set(auction._id, { amount: maxBid, rule: ruleLabel, ruleId, marketValueTokens: marketValue });
      this.myAutobids.set(auction._id, maxBid); // optimistic -- the autobidSet confirmation also sets this, but don't wait on it for the dashboard to reflect it
      store.setHeld(auction._id, maxBid);
      store.addSessionCommitted(maxBid);
      auction._decision = { verdict: 'autobid-set', reason: `autobid up to ${fmt(maxBid)} tokens (market value ${fmt(marketValue)})`, at: Date.now(), rule: ruleLabel };
      store.log('info', `set autobid on ${skinLabel(skin)}: up to ${fmt(maxBid)} tokens`, { auctionId: auction._id, marketValue });
      return true;
    } catch (e) {
      store.log('error', `emit failed for ${auction._id}: ${e.message}`);
      return false;
    }
  }

  async _executeSnipeBid(auction, skin, amount, marketValue, ruleLabel, ruleId) {
    try {
      await ccoSocket.placeBid(auction._id, amount);
      store.bumpBidsPlaced();
      this.ownedByUs.set(auction._id, { amount, rule: ruleLabel, ruleId, marketValueTokens: marketValue });
      store.setHeld(auction._id, amount);
      store.addSessionCommitted(amount);
      auction._decision = { verdict: 'bid-placed', reason: `bid ${fmt(amount)} tokens (market value ${fmt(marketValue)})`, at: Date.now(), rule: ruleLabel };
      store.log('info', `placed bid on ${skinLabel(skin)}: ${fmt(amount)} tokens`, { auctionId: auction._id, marketValue });
      return true;
    } catch (e) {
      store.log('error', `emit failed for ${auction._id}: ${e.message}`);
      return false;
    }
  }

  /** Manual one-click action from the dashboard: set an autobid at pct% of this auction's
   * already-computed market value, bypassing the rule engine entirely. Still respects the
   * safety checks (self-bid guard, lock/cooldown, consecutive-bid limit, session spend cap,
   * dry run) since those protect the account regardless of what triggered the bid. */
  async quickAutobid(auctionId, pct) {
    const auction = this.auctions.get(auctionId);
    if (!auction) return { ok: false, error: 'auction not tracked' };
    if (auction.status !== 'active' || auction.isLocked) return { ok: false, error: 'auction is not active/bid-locked' };
    if (store.isOnCooldown(auctionId)) return { ok: false, error: 'auction is on cooldown after a previous rejection' };
    if (this.ourUserId && auction.currentBidder === this.ourUserId) return { ok: false, error: 'already leading this auction' };
    if ((auction.consecutiveBidCount || 0) >= MAX_CONSECUTIVE_BIDS) return { ok: false, error: 'consecutive-bid limit already reached here' };

    const marketValue = auction._marketValueTokens;
    if (!marketValue) return { ok: false, error: `no market value yet (${auction._valuationConfidence || 'unvalued'})` };

    const maxBid = Math.min(Math.round(marketValue * (pct / 100)), MAX_SINGLE_BID);
    const minNext = minNextBid(auction.currentBid, auction.startingPrice);
    if (minNext > maxBid) return { ok: false, error: `min next bid ${fmt(minNext)} exceeds ${pct}% of market value (${fmt(maxBid)})` };

    if (store.totalHeld() + maxBid > store.settings.limits.allocation) return { ok: false, error: 'would exceed bot allocation' };

    const skin = auction.auctionedSkinId;
    const label = `manual ${pct}%`;
    if (store.settings.dryRun) {
      auction._decision = { verdict: 'would-bid', reason: `[dry run] manual: would set autobid up to ${fmt(maxBid)} tokens (${pct}% of ${fmt(marketValue)} market value)`, at: Date.now(), rule: label };
      store.log('info', `[dry run] manual autobid on ${skinLabel(skin)}: would go up to ${fmt(maxBid)} tokens`, { auctionId, marketValue, pct });
      this.broadcastStateImmediately();
      return { ok: true, dryRun: true, maxBid };
    }

    const success = await this._executeAutobid(auction, skin, maxBid, marketValue, label);
    this.broadcastStateImmediately();
    return success ? { ok: true, maxBid } : { ok: false, error: 'emit failed, check activity log' };
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
