// Lightweight in-memory time series for the dashboard's live graphs (balance/held/committed over
// time). Not persisted across restarts -- this is for watching the current run, not long-term
// archival, so keeping it simple (no disk writes, no unbounded growth) is the right trade-off.
import { store } from './store.js';

const MAX_POINTS = 480; // ~4 hours at one sample/30s

class HistoryTracker {
  constructor() {
    this.points = [];
  }

  record(point) {
    const full = { ts: Date.now(), ...point };
    this.points.push(full);
    if (this.points.length > MAX_POINTS) this.points.shift();
    store._notify('historyPoint', full);
    return full;
  }
}

export const history = new HistoryTracker();
