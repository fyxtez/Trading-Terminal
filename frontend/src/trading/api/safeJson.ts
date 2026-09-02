/**
 * Parses a JSON response body while preserving `orderId`/`algoId` values
 * as exact strings instead of letting the browser's native `JSON.parse`
 * silently corrupt them.
 *
 * THE BUG THIS FIXES: Binance's order IDs are large integers (18-19
 * digits) that routinely exceed `Number.MAX_SAFE_INTEGER` (2^53 - 1).
 * JavaScript's `number` type is an IEEE-754 double, which can only
 * represent integers exactly up to that point - beyond it, distinct
 * integers get silently rounded to the same nearest representable
 * double. E.g. 8389766241265026948 and 8389766241265027000 are
 * DIFFERENT numbers, but `JSON.parse` converts both to the exact same
 * double, and printing that double back out (e.g. in a template literal
 * building a URL) produces "8389766241265027000" regardless of which of
 * the two was the real one. If the real ID wasn't that exact value,
 * every subsequent action using it (cancel, reprice, reduce-edit) then
 * targets an order id Binance has never heard of - which is exactly the
 * "-2011 Unknown order sent" / "order not found" family of errors seen
 * throughout this app.
 *
 * The backend's own JSON text is NOT the problem - Rust's own integer
 * handling has no such limit, so the raw response text already contains
 * the exact correct digits. The corruption happens purely on this side,
 * at the moment `JSON.parse` converts a bare numeric literal into a
 * `number`. Rewriting `"orderId":8389766241265026948` to
 * `"orderId":"8389766241265026948"` in the raw text BEFORE handing it to
 * `JSON.parse` means it becomes a JS *string* instead - preserved
 * character-for-character, with none of the precision loss a `number`
 * would introduce.
 *
 * Every order id in this app should be treated as a string end to end
 * (comparisons and template-literal URL-building both work identically
 * whether it's a string or a number, so this is a safe, low-risk
 * direction to standardize on) - never re-parsed back into a `number`.
 */
export function parseOrderJsonText(text: string): unknown {
  const withStringIds = text.replace(
    /"(orderId|algoId|order_id|old_order_id|chased_order_id)":\s*(-?\d+)(?!["\d.])/g,
    '"$1":"$2"',
  );

  return JSON.parse(withStringIds);
}

/**
 * Same fix as parseOrderJsonText, applied directly to a fetch Response -
 * the common case, since almost every call site just wants
 * `await response.json()` with this same precision-preserving behavior.
 */
export async function parseOrderJsonResponse(
  response: Response,
): Promise<unknown> {
  return parseOrderJsonText(await response.text());
}
