import { store } from './store.js';

const BASE = 'https://case-clicker.com';

class CloudflareChallengeError extends Error {
  constructor() {
    super('Blocked by Cloudflare challenge page — cookie is missing cf_clearance, expired, or the User-Agent no longer matches the browser that issued it.');
    this.name = 'CloudflareChallengeError';
  }
}

function headers(extra) {
  const { cookie, userAgent } = store.settings.cco;
  return {
    accept: 'application/json',
    cookie: cookie || '',
    'user-agent': userAgent || 'Mozilla/5.0',
    ...extra,
  };
}

async function req(pathAndQuery, opts = {}) {
  const res = await fetch(BASE + pathAndQuery, {
    ...opts,
    headers: headers(opts.headers),
  });
  const text = await res.text();
  const looksLikeChallenge = res.status === 403 || /Just a moment|cf-browser-verification|challenges\.cloudflare\.com/i.test(text.slice(0, 2000));
  if (looksLikeChallenge) throw new CloudflareChallengeError();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* leave null */ }
  if (!res.ok) {
    const err = new Error(`CCO API ${res.status} on ${pathAndQuery}: ${(json && json.message) || text.slice(0, 200)}`);
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
}

export async function getMe() {
  return req('/api/me', { cache: 'no-store' });
}

export async function getSession() {
  return req('/api/auth/get-session', { cache: 'no-store' });
}

export async function getSocketToken() {
  const j = await req('/api/auth/token', { cache: 'no-store' });
  return j && j.token;
}

export async function getAuctionsHome() {
  return req('/api/auctions/home', { cache: 'no-store' });
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
  return req(`/api/auctions?${q.toString()}`, { cache: 'no-store' });
}

export async function getAuctionHistory(auctionId) {
  const j = await req(`/api/auctions/${auctionId}/history`, { cache: 'no-store' });
  return j && j.history;
}

export { CloudflareChallengeError };
