/**
 * Whether an error message indicates the target order simply no longer
 * exists on Binance - already filled, already cancelled, or already
 * replaced by a reprice/reduce-edit elsewhere (a cancel-and-replace under
 * the hood, so the id changes every time) - as opposed to a genuine
 * validation failure (bad quantity, wrong side, insufficient size, etc.)
 * that the user could actually do something about.
 *
 * Covers both the layer that can report this: Binance's own matching
 * engine directly ("-2013 Order does not exist", "-2011 Unknown order
 * sent") and this app's own backend, which double-checks against a fresh
 * live query before acting and returns its own plain-English "open order
 * {id} not found" when Binance's own current order list doesn't have it.
 *
 * Used consistently across every action that can hit a stale order id
 * (cancel, reprice, reduce-percent edit) so they all agree on what counts
 * as "this is fine, the order's just gone" versus "this is a real error to
 * show the user as-is".
 */
export function isStaleOrderError(message: string): boolean {
  const lower = message.toLowerCase();

  return (
    message.includes("-2013") ||
    message.includes("-2011") ||
    lower.includes("order does not exist") ||
    lower.includes("unknown order") ||
    (lower.includes("open order") && lower.includes("not found"))
  );
}
