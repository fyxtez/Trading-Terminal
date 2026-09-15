# Outbound connections and failure policy

The supported desktop product binds its own API only to loopback. It still
makes the following outbound connections. Adding a provider or changing a host
requires a CSP, timeout, redirect and redaction review.

| Purpose | Destination | Data sent | Boundary and failure behavior |
| --- | --- | --- | --- |
| Binance USD-M REST | `fapi.binance.com`, `demo-fapi.binance.com` | Public queries or signed account/order requests | 5 s connect, 20 s total; redirects disabled so API key/signature material cannot move to another host; exposure increases fail closed |
| Binance API-key validation | `api.binance.com`, `demo-fapi.binance.com` | Signed validation before native credential storage | 5 s connect, 15 s total; redirects disabled; Mainnet rejects withdrawal-enabled, non-readable or non-Futures keys, while Testnet requires an authenticated Futures account with trading access; invalid or unverifiable keys are not stored |
| Binance market/user streams | Binance Futures `wss` hosts selected by network | Public subscriptions or a temporary listen key | 20 s connection bound; bounded reconnect; REST reconciliation after reconnect; stream state is not authoritative |
| MEXC public contract data | `api.mexc.com` and configured public WebSocket host | Symbol and candle identifiers only | 5 s connect, 15 s REST total, at most three redirects; unavailable data becomes a visible degraded chart state |
| Binance token metadata | Binance public Alpha endpoint | Public symbol lookup | 5 s connect, 15 s total; best effort only |
| CoinGecko / DexScreener / MEXC metadata | Public provider APIs | Public ticker/address lookup | 5 s connect, 15 s total, at most three redirects; failure cannot reject a valid symbol |
| TradingView/FMP/provider images | Provider image URL returned by metadata | Image request only | 5 s connect, 15 s total, at most three redirects; downloaded bytes are validated and cached; icon failure is cosmetic |

The repository retains dormant ntfy and Telegram client code, but ADR 0013
removes every product entry point: their native command is not registered and
the backend alert worker is not started. Current builds therefore make no ntfy
or Telegram requests.

## Binance polling budget

Within each frontend window, chart panes and the positions panel share account
and open-order reads, including in-flight reads whose original component has
unmounted. Account state retains a 3.5-second display cache and a four-second
fallback poll. Exposure-changing backend actions still validate fresh exchange
state before placing orders.

- Open orders on visible symbols and symbols with existing orders reconcile
  every four seconds. A global sweep discovers other symbols every 30 seconds;
  order events and explicit forced refreshes request a global sweep immediately.
  If the user stream is unavailable, a new order on an unobserved symbol can
  therefore take up to the next global sweep (about 32 seconds with this timer)
  to appear. Failed symbol reads retain the previous display and report failure.
- Realized-PNL history is skipped when the account read fails or the account is
  flat. Successful history is reused for up to a minute, with early invalidation
  when position size/entry changes or a position mutation invalidates the cache.
- Failed snapshot reads back off from four seconds to one minute. API access
  rejections pause account readers for a minute; changing the saved connection
  resets that pause. Price and snapshot readers share the outgoing-IP cooldown
  for Binance rate-limit responses. Public price readers honor `Retry-After`;
  older backend error responses without that header use a conservative fallback.

The fake-clock regression test in `snapshotPolling.test.ts` covers 15 polling
ticks over one minute, one watched symbol, a flat account, and multiple readers.
It produces two global order reads and 13 symbol reads: **93 request-weight
units**, compared with **600** for 15 global reads. These are calculated weights
for that scenario, not a measurement of total traffic from the user's IP.

## Invariants

- Exchange secrets come only from the OS credential manager.
- Signed Binance URLs are never written to the audit journal or diagnostics.
  Diagnostic URL sanitization retains only scheme and authority. Dormant legacy
  notification credentials are not read.
- Native URLs reject non-HTTP(S) schemes, embedded username/password fields and
  oversized values. Credential and message fields have explicit size limits.
- Axum applies a 64 KiB request-body limit and a 90-second outer request limit;
  individual provider clients use tighter timeouts shown above.
- Credentials-bearing HTTP clients do not follow redirects. Public metadata
  clients permit no more than three redirects.
- CSP lists current direct frontend data hosts. Backend-only providers do not
  need WebView CSP access.
- A provider failure is classified by authority: exchange prerequisite failure
  blocks new exposure, market-data failure degrades charting, and icon failure
  is secondary and visible/best-effort.

Testnet, offline, and malformed-response drills remain necessary because static
review cannot prove remote behavior.
