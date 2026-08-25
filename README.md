# CCO Auction Sniper

A local valuation + bidding bot for the Auction House on [case-clicker.com](https://case-clicker.com) ("CCO"), with a web dashboard for stats and settings. It's a game-currency tool — no real money involved.

It watches every active auction, estimates each skin's market value from your [Pricedata Overlay sheet](https://github.com/rowkav09/CCO-scripts-archive/blob/main/scripts/Utilities/Case%20Clicker%20Pricedata%20Overlay-2.7.user.js), and — once you turn dry-run off — bids or sets an autobid whenever the price looks good relative to rules you define.

## How it works

- **Discovery**: polls `GET /api/auctions` (paginated, sorted by newest and by ending-soonest) to find active auctions, same endpoint the site's own Auction House page uses.
- **Live updates**: connects to CCO's Socket.IO server (`wss://ws.case-clicker.com`) with the same auth flow the browser uses, subscribes to every tracked auction, and gets `auctionUpdated`/`auctionEnded`/`outbid`/etc. pushed in real time instead of re-polling.
- **Valuation**: pulls the same two Google Sheets your userscript reads (PriceData + List tabs) and runs the same `calcPrice()` formula (quality scaling, pattern/List overrides, StatTrak/Souvenir/event adjustments, 1/1 bonuses, Katowice holo special case) to get a dollar estimate per skin.
- **$ → tokens**: auctions are bid in a separate "tokens" currency, not dollars. Rather than guess a fixed exchange rate, the app self-calibrates one from CCO's own "comparable sales" data (real recent token sale prices for the same skin) — every time an auction has enough recent comparable sales *and* a usable pricedata estimate, that pair becomes one sample of the real $→tokens rate, and the live rate is the median of recent samples. You can also just set a manual rate in Settings and skip waiting on that.
- **Bidding**: either sets a native **autobid** (CCO's own hidden-max proxy-bidding system — it auto-raises for you up to your ceiling, same mechanism eBay uses) or does last-second **sniping**, per your strategy setting. Bid-increment and consecutive-bid-limit math is ported from CCO's own client code, not guessed.

## Setup

```
npm install
npm start
```

This starts the dashboard at **http://localhost:8934** (change `port` in Settings/`data/settings.json` if you want a different one — chosen to avoid clashing with common dev ports).

### Connecting your account

The bot authenticates as *you*, using your existing browser session — there's no separate login flow, and it never sees your password.

1. Log into case-clicker.com in Chrome as normal.
2. Open DevTools → Network tab, reload the page, click any request to `case-clicker.com`.
3. Under **Request Headers**, copy the entire `cookie:` value and paste it into **Settings → Cookie header** in the dashboard.
4. Copy the `user-agent:` value from the same request into **Settings → User-Agent**. This has to match exactly — the site's Cloudflare protection binds its clearance cookie to a specific browser fingerprint, so a mismatched User-Agent gets you a "Just a moment…" challenge page instead of JSON.
5. Click **Save connection**, then **Test connection** to confirm.

The cookie must include `cf_clearance` (not just the login/session cookie) or every request will be blocked by Cloudflare. If Test Connection reports a Cloudflare challenge error, re-copy the cookie — `cf_clearance` is short-lived and needs refreshing periodically (re-copy it whenever the test starts failing).

### Dry run first

The bot starts in **dry run** by default: it evaluates every auction and logs exactly what it *would* do, without emitting a single bid. Leave it in dry run and watch the Activity Log and Tracked Auctions table until the decisions look right, especially the `$→tokens rate` stat (Settings → Valuation) — a bad rate produces confidently wrong bids in either direction. Only flip **Dry run** off once you trust it.

## Rules

Rules are checked top to bottom; the first enabled one whose filters (name/weapon/rarity/exterior/StatTrak/Souvenir/native $ price range) match an auctioned skin is used. Each rule sets:

- **Threshold %** — only act if the minimum next bid is at or below this % of market value.
- **Max bid %** — the ceiling we're willing to pay, as a % of market value, even in a bidding war.
- **Max bid absolute** (optional) — a hard token cap regardless of the above.

An auction that matches no rule is ignored, unless you enable the **default rule** as a catch-all.

## Safety rails

- **Session spend cap** (Settings → Limits): a hard stop on cumulative new token commitments since the process started. Resets on restart — keep it low until you trust your rules, then raise it.
- Never bids against itself (checks `currentBidder` against your own user id before every emit).
- Respects CCO's own consecutive-self-raise limit (3) and skips locked/inactive auctions.
- Treats `bidRejected` / `autobidFailed` / `auctionError` from the server as authoritative: puts that auction on a 10-minute cooldown instead of retrying.

## Known gaps / things to verify yourself

- The exact payload shape of `bidRejected`, `autobidFailed`, `outbid`, and `auctionError` socket events wasn't confirmed against a real rejection/loss (that would have meant deliberately losing test auctions). The handlers read common field names defensively and log the raw payload either way — check the Activity Log the first few times these fire and adjust `src/sniper.js` (`_onFailure`) if the reason text looks off.
- The `sort` values accepted by `GET /api/auctions` (`newest`, `endingSoon`) are inferred from the site's minified bundle, not exhaustively enumerated. If discovery seems to miss auctions, check `src/sniper.js` (`pollNewest`/`pollFull`).
- Cloudflare may fingerprint at the TLS/HTTP level in addition to the cookie + User-Agent pair. If a correctly-configured cookie still gets challenged, that's why — there isn't a pure-Node workaround for that beyond keeping the cookie fresh and identical to a real browser's.

## Architecture

```
src/
  server.js    Express + WS dashboard server, wires everything together
  store.js     settings/ledger/log persistence (data/*.json, data/log.jsonl)
  ccoRest.js   REST client for case-clicker.com (cookie/UA auth, Cloudflare detection)
  ccoSocket.js Socket.IO client for wss://ws.case-clicker.com (live updates + bidding)
  pricing.js   Google Sheet pricedata (ported calcPrice) + $->tokens calibration
  sniper.js    discovery polling, rule matching, decision engine, bid execution
public/        vanilla JS/HTML/CSS dashboard (no build step)
data/          settings.json, runtime.json (ledger/stats/calibration), log.jsonl
```
