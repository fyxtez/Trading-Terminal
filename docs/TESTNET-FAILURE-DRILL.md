# Binance Testnet failure drill

The drill exercises failure handling against the same Binance Futures Testnet
credentials selected in desktop Settings. It never accepts API keys on the
command line or through environment variables.

## Safety gates

The command exits before any trading mutation unless all of these are true:

- the stored desktop network is exactly `testnet` (`DEMO` in the UI);
- Testnet credentials exist in the OS credential store;
- `--execute` and `--confirm-testnet-mutations` are both present; and
- the selected symbol has no position and no open orders.

The mutating drill creates one minimum-notional post-only BUY limit below the
market. It records a unique client order ID, reconciles it after an injected
lost response, then cancels it. Since the clean-symbol gate proved there were
no pre-existing orders, final cleanup may safely cancel any residual orders on
that symbol. If an extreme move fills the drill order, cleanup submits only the
reduce-only quantity needed to return to the flat baseline.

Mainnet is rejected in code even when the confirmation flags are present.

## Run

Close the desktop application first so the drill is the only process using the
Testnet credentials. Start with the read-only preflight:

```bash
./run.sh testnet-drill
```

Run the complete drill and keep a JSON report outside the repository:

```bash
./run.sh testnet-drill \
  --execute \
  --confirm-testnet-mutations \
  --soak-seconds 60 \
  --report /tmp/fyxtez-testnet-drill.json
```

Use `--symbol BTCUSDT` to select another flat Binance Futures symbol. The soak
duration is optional and capped at one hour.

## Covered scenarios

- authoritative REST preflight;
- duplicate retry of an in-progress intent fails closed;
- isolated-margin verification before any valid order submission;
- deterministic exchange rejection for an invalid quantity;
- accepted limit submission followed by a simulated lost local response;
- recovery of that order by its preassigned client order ID;
- reconstruction from a fresh backend Binance client;
- forced 24-hour timestamp skew and normal Binance `-1021` resynchronization;
- forced private user-stream disconnect, bounded reconnect and snapshot refresh;
- accepted cancellation followed by a simulated lost local response;
- authoritative cancel confirmation and cleanup; and
- optional repeated account, position-risk and open-order snapshots.

The injected REST failures happen immediately after Binance has returned a
successful response to the drill boundary. This deterministically represents
the important ambiguous-outcome state without changing the production HTTP
timeouts or using an unreliable external proxy.

A `PASS` means every required step succeeded and final Binance state matches the
flat starting state. `SKIP` is used only for mutation/soak phases that were not
requested. Any `FAIL` makes the process exit non-zero.

Partial fills remain a manual Testnet scenario because a deterministic partial
fill cannot be safely forced on a public order book. The owner previously
completed that manual flow; the accepted automated run below covers the
remaining deterministic failure and reconciliation cases.

## Latest accepted run

The complete BTCUSDT execute-mode drill passed on 2026-09-05. All 15 reported
steps passed, final cleanup found no remaining order or exposure, and the
60-second soak produced 27 clean authoritative snapshots. The redacted report
is stored in
[`test-results/testnet-drill-2026-09-05.json`](test-results/testnet-drill-2026-09-05.json).
