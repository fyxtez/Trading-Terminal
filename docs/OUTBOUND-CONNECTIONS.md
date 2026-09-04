# Outbound connections and failure policy

The supported desktop product binds its own API only to loopback. It still
makes the following outbound connections. Adding a provider or changing a host
requires a CSP, timeout, redirect and redaction review.

| Purpose | Destination | Data sent | Boundary and failure behavior |
| --- | --- | --- | --- |
| Binance USD-M REST | `fapi.binance.com`, `demo-fapi.binance.com` | Public queries or signed account/order requests | 5 s connect, 20 s total; redirects disabled so API key/signature material cannot move to another host; exposure increases fail closed |
| Binance API-key permissions | `api.binance.com` | Mainnet-only signed permission validation before native credential storage | 5 s connect, 15 s total; redirects disabled; withdrawal-enabled, non-readable, non-Futures, invalid, or unverifiable keys are not stored |
| Binance market/user streams | Binance Futures `wss` hosts selected by network | Public subscriptions or a temporary listen key | 20 s connection bound; bounded reconnect; REST reconciliation after reconnect; stream state is not authoritative |
| MEXC public contract data | `api.mexc.com` and configured public WebSocket host | Symbol and candle identifiers only | 5 s connect, 15 s REST total, at most three redirects; unavailable data becomes a visible degraded chart state |
| Binance token metadata | Binance public Alpha endpoint | Public symbol lookup | 5 s connect, 15 s total; best effort only |
| CoinGecko / DexScreener / MEXC metadata | Public provider APIs | Public ticker/address lookup | 5 s connect, 15 s total, at most three redirects; failure cannot reject a valid symbol |
| TradingView/FMP/provider images | Provider image URL returned by metadata | Image request only | 5 s connect, 15 s total, at most three redirects; downloaded bytes are validated and cached; icon failure is cosmetic |
| ntfy | User-selected HTTP(S) publish URL, or `https://ntfy.sh/<topic>` | Notification title/body/click URL; topic is part of destination | 5 s connect, 10–12 s total; redirects disabled to avoid disclosing private topics; failure is visible but cannot change the completed alert/trade result |
| Telegram Bot API | `api.telegram.org` | Bot token in the fixed URL plus configured chat ID and message | 5 s connect, 10–12 s total; redirects disabled; token, URL and chat ID are excluded from diagnostics and logs |

## Invariants

- Exchange and notification secrets come only from the OS credential manager.
- Signed Binance URLs, Telegram bot URLs and ntfy private topics are never
  written to the audit journal or diagnostics. Diagnostic URL sanitization
  retains only scheme and authority.
- Native URLs reject non-HTTP(S) schemes, embedded username/password fields and
  oversized values. Credential and message fields have explicit size limits.
- Axum applies a 64 KiB request-body limit and a 90-second outer request limit;
  individual provider clients use tighter timeouts shown above.
- Credentials-bearing HTTP clients do not follow redirects. Public metadata
  clients permit no more than three redirects.
- CSP lists current direct frontend data hosts. Backend-only providers do not
  need WebView CSP access.
- A provider failure is classified by authority: exchange prerequisite failure
  blocks new exposure, market-data failure degrades charting, and notification
  or icon failure is secondary and visible/best-effort.

Testnet, offline, malformed-response and notification-provider drills remain
necessary because static review cannot prove remote behavior.
