// Thin wrappers around browserSession.apiGet -- every request actually runs as a real fetch()
// inside the Playwright-driven Chrome tab (see browserSession.js for why: Cloudflare blocks a
// plain Node client at the TLS layer regardless of cookie validity).
import { browserSession } from './browserSession.js';

export async function getMe() {
  return browserSession.apiGet('/api/me');
}

export async function getSession() {
  return browserSession.apiGet('/api/auth/get-session');
}

export async function getAuctionsHome() {
  return browserSession.apiGet('/api/auctions/home');
}

/**
 * params: { page, limit, sort, includeEnded, minPrice, maxPrice, sellerId, ...extra filters }
 */
export async function listAuctions(params = {}) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    q.set(k, String(v));
  }
  return browserSession.apiGet(`/api/auctions?${q.toString()}`);
}

export async function getAuctionHistory(auctionId) {
  const j = await browserSession.apiGet(`/api/auctions/${auctionId}/history`);
  return j && j.history;
}
