# ADR 0014: Provide trading in a local browser companion

- Status: Accepted
- Date: 2026-09-06

## Context

The installed Linux application is the current single-user deployment unit. It
owns the Binance credential-store entries and supervises the local Axum trading
service. The embedded WebView is not always the user's preferred place to work,
however; a normal desktop browser provides familiar tab, window and display
management.

Turning the public download website into a trading backend would create a
different product and trust model. Sending Binance keys to that website, putting
the native service capability in browser JavaScript, or exposing Axum on the LAN
would violate the existing local-secret and single-user boundaries.

Browser-owned settings and drawings also use origin-scoped `localStorage`. A
new random browser port on every launch would therefore make that workspace
appear to disappear after every application restart.

## Decision

The Linux installation provides an opt-in **Browser access** mode:

- The installed application remains the owner and supervisor of Axum, Binance
  credentials, trading state and financial-intent recovery.
- Axum exposes a second listener only on the fixed loopback origin
  `http://127.0.0.1:8658` and serves the production React bundle there. It is
  never bound to a LAN or public interface. Failure to reserve this optional
  port must not prevent the native terminal from starting.
- Browser access starts disabled. Enabling it in native Settings allows Tauri
  to create a short-lived, one-use launch ticket and open the local URL. The
  ticket travels only in a URL fragment, which HTTP never transmits, is removed
  before the first API request, and is exchanged for a split session: an opaque
  `HttpOnly`,
  `SameSite=Strict` cookie plus an independent proof kept only in that tab's
  `sessionStorage`. Both parts are required because cookies do not isolate
  different ports on the same loopback host. A later launch into the same
  browser profile reuses its valid cookie session and adds a new tab proof;
  earlier authorized tabs remain valid. A different browser profile receives
  an independent cookie session.
- The browser never receives the native sidecar capability, Binance API key or
  Binance secret. Session status contains only safe connection metadata such as
  whether Binance is configured and whether it is Live or Practice.
- Browser sessions may call the same account and trading routes as the native
  UI, including the existing durable-intent protection. They cannot manage
  credential-store entries or browser-access control routes.
- Disabling Browser access revokes all launch tickets, HTTP sessions and their
  associated streaming access. Backend restart and application exit also erase
  every in-memory browser capability.
- While Browser access is enabled and a system tray is available, closing the
  Linux window hides it and leaves the supervised process available from the
  tray. Tray **Quit** remains a real shutdown. If tray creation fails, close
  remains a real exit so no invisible background process is created. This
  lifecycle is for an explicitly opened trading UI and does not revive the
  dormant alert system from ADR 0013.
- The browser origin is stable so its own drawings, tabs and preferences persist
  across application restarts. Native WebView and normal browser storage remain
  two separate local workspaces in this version; neither silently overwrites
  the other.

The hosted download website is outside this decision. Android keeps its
embedded native UI and does not expose Browser access.

## Consequences

- A user can trade in Chrome, Firefox or another browser on the same Linux
  computer, but the installed Fyxtez process must remain running.
- Loopback becomes a deliberate browser trust boundary. Host/origin validation,
  split session proof, short-lived one-use tickets, expiry, revocation and
  native-only control authorization require dedicated regression tests.
- Multiple authorized tabs in one browser profile share its `HttpOnly` cookie
  but keep separate tab proofs. They share the cookie session's remaining
  lifetime and are revoked together; the reported session count represents
  issued, unexpired proofs rather than a live count of open tabs.
- Port `8658` is reserved for the browser workspace. A collision produces a
  clear Browser access error rather than falling back to another origin or
  breaking the native terminal.
- Anyone with control of the unlocked local user session can interact with the
  running desktop application; Browser access does not claim to defend a
  compromised operating-system account.
- Sharing drawings and preferences between the WebView and browser would need a
  versioned backend-owned synchronization protocol and conflict rules. It is
  intentionally not implied by this feature.

## Follow-up

1. Exercise enable, open, window-close, tray reopen, disable and quit on the
   packaged Linux build.
2. Open the terminal twice from the installed app and confirm both the earlier
   and newer browser tabs retain account and trading access.
3. Confirm that disabling or restarting rejects new REST requests immediately
   and closes the browser WebSocket within about one second. A REST request that
   was already authorized may finish, preserving its durable outcome handling.
4. Inspect browser storage, URLs and network responses. Each expected tab proof
   may appear once in the ticket-redeem response, then only in `sessionStorage`
   and its request header; confirm that neither Binance credentials nor the
   native service capability appear.
5. Consider an explicit workspace import/synchronization design only if using
   separate native and browser layouts becomes a real product problem.
6. Review the lifecycle and credential-store boundary separately before adding
   Browser access to any operating system other than Linux.
