// case-clicker.com sits behind Cloudflare bot management that fingerprints the TLS/HTTP
// handshake itself, not just cookies -- a plain Node fetch/socket.io-client gets a "Just a
// moment..." challenge page even with a perfectly valid, freshly-copied session cookie (verified
// directly: same cookie, 200 JSON from a browser tab, 403 challenge from Node). So instead of
// making our own HTTP/WS connections, we drive a real Chrome instance via Playwright and run
// every request as `fetch(...)` inside that page -- genuine Chrome network stack, no fingerprint
// mismatch, and the session persists in its own on-disk profile so login (and cf_clearance) only
// has to happen once, ever, rather than being pasted in by hand each time it expires.
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { store } from './store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROFILE_DIR = path.join(__dirname, '..', 'data', 'browser-profile');
const SITE = 'https://case-clicker.com/';
const WS_URL = 'https://ws.case-clicker.com';

const SOCKET_IO_CLIENT_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'node_modules', 'socket.io-client', 'dist', 'socket.io.min.js'),
  'utf8'
);

const SOCKET_EVENTS = [
  'auctionInfo', 'auctionWatchersUpdated', 'auctionUpdated', 'auctionEnded', 'auctionCancelled',
  'bidPlaced', 'bidRejected', 'outbid', 'autobidFailed', 'autobidSet', 'autobidRemoved',
  'auctionWatchlistUpdated', 'auctionError',
];

/** Limits concurrent async jobs and staggers them slightly, so a burst of calls (e.g. a full
 * discovery sweep wanting /history for every tracked auction) doesn't fire dozens of requests
 * at once and trip CCO's own rate limiter. */
class RequestQueue {
  constructor(concurrency, minGapMs) {
    this.concurrency = concurrency;
    this.minGapMs = minGapMs;
    this.active = 0;
    this.queue = [];
  }

  run(fn) {
    return new Promise((resolve, reject) => {
      this.queue.push({ fn, resolve, reject });
      this._pump();
    });
  }

  _pump() {
    while (this.active < this.concurrency && this.queue.length) {
      const { fn, resolve, reject } = this.queue.shift();
      this.active++;
      fn().then(resolve, reject).finally(() => {
        setTimeout(() => { this.active--; this._pump(); }, this.minGapMs);
      });
    }
  }
}

class BrowserSession extends EventEmitter {
  constructor() {
    super();
    this.context = null;
    this.page = null;
    this.ready = false;
    this.socketConnected = false;
    this.userId = null;
    this.userName = null;
    this._starting = null;
    // Sequential with a 350ms gap, matching the pricedata userscript's own FETCH_DELAY_MS -- that
    // value is proven safe against CCO's rate limiter from real usage; 3-way concurrency still
    // tripped it during testing here.
    this._requestQueue = new RequestQueue(1, 350);
  }

  /** Idempotent -- safe to call from multiple places (server boot, dashboard Start button). */
  start() {
    if (this._starting) return this._starting;
    this._starting = this._start().catch((e) => {
      // Don't cache a rejected promise forever -- a transient launch failure (e.g. a stale
      // Chrome profile lock right after a previous instance was killed) would otherwise wedge
      // every future start() call, since the guard above just returns the same rejection.
      this._starting = null;
      throw e;
    });
    return this._starting;
  }

  async _start() {
    store.log('info', 'launching browser session...');
    try {
      this.context = await chromium.launchPersistentContext(PROFILE_DIR, {
        channel: 'chrome',
        headless: false, // bidding is consequential even in a game -- keep it visible, not a silent background process
        viewport: { width: 1100, height: 800 },
        // Without this, Playwright leaves navigator.webdriver === true, which Cloudflare's bot
        // management checks for directly -- confirmed empirically: same profile, same site, 403
        // "Just a moment..." with this flag absent, clean 200 JSON with it present.
        args: ['--window-position=0,0', '--disable-blink-features=AutomationControlled'],
      });
    } catch (e) {
      if (/ProcessSingleton|already in use/i.test(e.message)) {
        throw new Error(
          'Chrome profile is locked by a leftover process from a previous run (usually from the app being killed rather than stopped cleanly). ' +
          'Open Task Manager, end any chrome.exe processes with no window/title, then try Start again.'
        );
      }
      throw e;
    }
    this.page = this.context.pages()[0] || (await this.context.newPage());
    this.context.on('close', () => {
      this.ready = false;
      this.socketConnected = false;
      this._starting = null;
      store.log('warn', 'browser window was closed -- the bot has stopped, restart the app to reconnect');
      this.emit('closed');
    });

    await this.page.goto(SITE, { waitUntil: 'domcontentloaded' });
    await this._ensureLoggedIn();
    await this._injectSocketBridge();

    this.ready = true;
    store.log('info', `browser session ready (logged in as ${this.userName || '?'})`);
  }

  async _ensureLoggedIn() {
    let session = await this._trySession();
    if (session?.user?.id) {
      this.userId = session.user.id;
      this.userName = session.user.name;
      return;
    }
    store.log('warn', 'not logged in -- log into case-clicker.com in the Chrome window that just opened. Waiting...');
    while (true) {
      await this.page.waitForTimeout(3000);
      session = await this._trySession();
      if (session?.user?.id) {
        this.userId = session.user.id;
        this.userName = session.user.name;
        store.log('info', `login detected: ${this.userName}`);
        return;
      }
    }
  }

  async _trySession() {
    try {
      return await this.page.evaluate(() => fetch('/api/auth/get-session', { credentials: 'include', cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)));
    } catch {
      return null;
    }
  }

  /** Loads socket.io-client into the page and opens a second, independent socket connection
   * (separate from whatever the site's own React app is doing) so we can drive it directly. Page
   * events are relayed back to us via exposeFunction; must be set up before the script runs. */
  async _injectSocketBridge() {
    await this.page.exposeFunction('__sniperOnEvent', (name, payload) => {
      if (name === '__connect') { this.socketConnected = true; this.emit('status', { connected: true }); return; }
      if (name === '__disconnect') { this.socketConnected = false; this.emit('status', { connected: false, reason: payload }); return; }
      if (name === '__connect_error') { this.socketConnected = false; this.emit('status', { connected: false, error: payload }); return; }
      this.emit(name, payload);
    });

    await this.page.addScriptTag({ content: SOCKET_IO_CLIENT_SRC });
    await this.page.evaluate(
      ({ wsUrl, events }) => {
        if (window.__sniperSocket) { window.__sniperSocket.disconnect(); }
        const s = window.io(wsUrl, {
          auth: (cb) => {
            fetch('/api/auth/token', { cache: 'no-store', credentials: 'include' })
              .then((r) => r.json())
              .then((t) => cb(t?.token ? { token: t.token } : {}))
              .catch(() => cb({}));
          },
          transports: ['websocket'],
          reconnectionDelay: 5000,
        });
        window.__sniperSocket = s;
        s.on('connect', () => window.__sniperOnEvent('__connect', null));
        s.on('disconnect', (reason) => window.__sniperOnEvent('__disconnect', reason));
        s.on('connect_error', (err) => window.__sniperOnEvent('__connect_error', err?.message || String(err)));
        events.forEach((evt) => s.on(evt, (payload) => window.__sniperOnEvent(evt, payload)));
      },
      { wsUrl: WS_URL, events: SOCKET_EVENTS }
    );
  }

  apiGet(pathAndQuery) {
    // CCO rate-limits its own API per-IP (the pricedata userscript this project is based on has
    // the same note -- fetching a big batch of pages/history calls at once trips it). A full
    // discovery sweep can want history for a couple hundred auctions at nearly the same instant,
    // so queue them instead of firing them all as concurrent page.evaluate calls.
    return this._requestQueue.run(() => this._rawApiGet(pathAndQuery));
  }

  async _rawApiGet(pathAndQuery) {
    const result = await this.page.evaluate(
      async (p) => {
        try {
          const res = await fetch(p, { credentials: 'include', cache: 'no-store' });
          const text = await res.text();
          let json = null;
          try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
          return { ok: res.ok, status: res.status, json };
        } catch (e) {
          return { ok: false, status: 0, error: e.message };
        }
      },
      pathAndQuery
    );
    if (!result.ok) {
      const err = new Error(`CCO API ${result.status} on ${pathAndQuery}: ${result.error || (result.json && result.json.message) || 'request failed'}`);
      err.status = result.status;
      throw err;
    }
    return result.json;
  }

  emitToSocket(event, payload) {
    if (!this.socketConnected) throw new Error('socket not connected');
    return this.page.evaluate(({ event, payload }) => window.__sniperSocket?.emit(event, payload), { event, payload });
  }

  setSubscriptions(idsWanted) {
    const wanted = new Set(idsWanted);
    const prev = this._subscribedIds || new Set();
    const toAdd = [...wanted].filter((id) => !prev.has(id));
    const toRemove = [...prev].filter((id) => !wanted.has(id));
    this._subscribedIds = wanted;
    if (!this.socketConnected) return;
    if (toAdd.length) this.emitToSocket('subscribeAuctions', toAdd).catch(() => {});
    if (toRemove.length) this.emitToSocket('unsubscribeAuctions', toRemove).catch(() => {});
  }

  async stop() {
    if (this.context) { await this.context.close().catch(() => {}); }
    this.context = null;
    this.page = null;
    this.ready = false;
    this.socketConnected = false;
    this._starting = null;
  }
}

export const browserSession = new BrowserSession();
