// Wraps the Socket.IO connection CCO's own frontend uses for auctions (reverse-engineered from
// the site's client bundle -- see pages/auctions/[id] and the app-level SocketProvider). REST
// covers discovery (GET /api/auctions*); this covers live updates and every bid mutation.
import { EventEmitter } from 'node:events';
import { io } from 'socket.io-client';
import { store } from './store.js';
import { getSocketToken } from './ccoRest.js';

const WS_URL = 'https://ws.case-clicker.com';

const INCOMING_EVENTS = [
  'auctionInfo', 'auctionWatchersUpdated', 'auctionUpdated', 'auctionEnded', 'auctionCancelled',
  'bidPlaced', 'bidRejected', 'outbid', 'autobidFailed', 'autobidSet', 'autobidRemoved',
  'auctionWatchlistUpdated', 'auctionError',
];

export class CcoSocket extends EventEmitter {
  constructor() {
    super();
    this.socket = null;
    this.connected = false;
    this._subscribedIds = new Set();
  }

  connect() {
    if (this.socket) return;
    const { cookie, userAgent } = store.settings.cco;

    this.socket = io(WS_URL, {
      // The site's own provider re-fetches the token on every (re)connect attempt because it's
      // short-lived -- a static {token} object would go stale after the first reconnect.
      auth: (cb) => {
        getSocketToken()
          .then((token) => cb(token ? { token } : {}))
          .catch((e) => {
            store.log('error', `socket auth token fetch failed: ${e.message}`);
            cb({});
          });
      },
      transports: ['websocket'],
      reconnectionDelay: 5000,
      extraHeaders: {
        cookie: cookie || '',
        'user-agent': userAgent || 'Mozilla/5.0',
      },
    });

    this.socket.on('connect', () => {
      this.connected = true;
      store.log('info', 'connected to auction websocket');
      this.emit('status', { connected: true });
      // Re-subscribe after a reconnect -- the server doesn't remember our old room membership.
      if (this._subscribedIds.size) this.socket.emit('subscribeAuctions', [...this._subscribedIds]);
    });

    this.socket.on('disconnect', (reason) => {
      this.connected = false;
      store.log('warn', `disconnected from auction websocket: ${reason}`);
      this.emit('status', { connected: false, reason });
    });

    this.socket.on('connect_error', (err) => {
      this.connected = false;
      store.log('error', `websocket connect_error: ${err.message}`);
      this.emit('status', { connected: false, error: err.message });
    });

    for (const evt of INCOMING_EVENTS) {
      this.socket.on(evt, (payload) => this.emit(evt, payload));
    }
  }

  disconnect() {
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
      this.connected = false;
    }
  }

  /** Diff-updates the set of auction rooms we're subscribed to for live currentBid/expiresAt pushes. */
  setSubscriptions(idsWanted) {
    const wanted = new Set(idsWanted);
    const toAdd = [...wanted].filter((id) => !this._subscribedIds.has(id));
    const toRemove = [...this._subscribedIds].filter((id) => !wanted.has(id));
    if (toAdd.length && this.socket && this.connected) this.socket.emit('subscribeAuctions', toAdd);
    if (toRemove.length && this.socket && this.connected) this.socket.emit('unsubscribeAuctions', toRemove);
    this._subscribedIds = wanted;
  }

  placeBid(auctionId, bidAmount) {
    if (!this.socket || !this.connected) throw new Error('socket not connected');
    this.socket.emit('placeBid', { auctionId, bidAmount: Math.round(bidAmount) });
  }

  setAutobid(auctionId, maxBid) {
    if (!this.socket || !this.connected) throw new Error('socket not connected');
    this.socket.emit('setAutobid', { auctionId, maxBid: Math.round(maxBid) });
  }

  removeAutobid(auctionId) {
    if (!this.socket || !this.connected) throw new Error('socket not connected');
    this.socket.emit('removeAutobid', { auctionId });
  }
}

export const ccoSocket = new CcoSocket();
