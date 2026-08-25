// Re-exposes browserSession's in-page socket connection with the same interface sniper.js
// already expects (EventEmitter + placeBid/setAutobid/removeAutobid/setSubscriptions). The actual
// socket lives inside the Playwright-driven Chrome tab -- see browserSession.js.
import { EventEmitter } from 'node:events';
import { store } from './store.js';
import { browserSession } from './browserSession.js';

class CcoSocket extends EventEmitter {
  constructor() {
    super();
    this.connected = false;
    this._wired = false;
  }

  connect() {
    if (this._wired) return;
    this._wired = true;
    browserSession.on('status', (s) => {
      this.connected = !!s.connected;
      if (s.connected) store.log('info', 'connected to auction websocket');
      else store.log('warn', `disconnected from auction websocket${s.reason ? `: ${s.reason}` : s.error ? `: ${s.error}` : ''}`);
      this.emit('status', s);
    });
    for (const evt of [
      'auctionInfo', 'auctionWatchersUpdated', 'auctionUpdated', 'auctionEnded', 'auctionCancelled',
      'bidPlaced', 'bidRejected', 'outbid', 'autobidFailed', 'autobidSet', 'autobidRemoved',
      'auctionWatchlistUpdated', 'auctionError',
    ]) {
      browserSession.on(evt, (payload) => this.emit(evt, payload));
    }
    // browserSession.socketConnected flips once the bridge's in-page socket actually connects,
    // which can happen before or after this wiring runs -- pick up the current state too.
    this.connected = browserSession.socketConnected;
  }

  disconnect() {
    // The bridged socket lives with the browser session's lifetime, not ours -- nothing to do
    // here beyond stop caring about it, which stop()-ping sniper.js already does by dropping
    // listeners via the off() calls in _wireSocketEvents.
  }

  setSubscriptions(ids) {
    browserSession.setSubscriptions(ids);
  }

  // These return promises now (the emit itself runs as page.evaluate inside the browser) --
  // callers in sniper.js await them and handle rejection, unlike the old fire-and-forget
  // socket.io-client version.
  placeBid(auctionId, bidAmount) {
    if (!this.connected) throw new Error('socket not connected');
    return browserSession.emitToSocket('placeBid', { auctionId, bidAmount: Math.round(bidAmount) });
  }

  setAutobid(auctionId, maxBid) {
    if (!this.connected) throw new Error('socket not connected');
    return browserSession.emitToSocket('setAutobid', { auctionId, maxBid: Math.round(maxBid) });
  }

  removeAutobid(auctionId) {
    if (!this.connected) throw new Error('socket not connected');
    return browserSession.emitToSocket('removeAutobid', { auctionId });
  }
}

export const ccoSocket = new CcoSocket();
