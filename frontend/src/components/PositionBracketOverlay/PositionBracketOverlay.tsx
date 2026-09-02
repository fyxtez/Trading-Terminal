import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type { IChartApi, ISeriesApi, UTCTimestamp } from "lightweight-charts";
import { intervalSeconds, type Interval } from "../../config/constants";
import {
  closePositionMarket,
  executePositionIntent,
  getPositions,
  type OpenPosition,
} from "../../trading/api/positions";
import {
  cancelConditionalOrder,
  placeFullStopLoss,
} from "../../trading/api/orders";
import {
  loadSavedStop,
  saveStop,
  type SavedStop,
} from "../../trading/stopLoss";
import type { TradeMarker, TradeSide, TradeToastState } from "../../trading/types";
import {
  areTpSlControlsVisible,
  setTpSlControlsVisible,
  TP_SL_CONTROLS_VISIBILITY_EVENT,
} from "../../trading/tpSlControlsVisibility";
import { startPacedLoop } from "../../utils/pacedLoop";
import "./PositionBracketOverlay.css";

type DragKind = "TAKE_PROFIT" | "STOP_LOSS";
// Only the right edge is resizable now - the zone's left edge is pinned
// exactly to the entry anchor and can no longer be extended backward in
// time (see the zone-edge-handle section below for why).
type EdgeDragKind = "ZONE_RIGHT";

type ZonePad = {
  // FIX: store the zone extent as real elapsed time, not as a count of bars.
  // A bar count only survives zoom while the timeframe stays the same; when
  // switching 1m -> 1h, e.g. 40 bars suddenly means 40 HOURS instead of the
  // original 40 minutes, which made the SL/TP rectangle explode across the
  // chart. Seconds preserve the same absolute right-edge time on every TF.
  rightSeconds: number | null;
};

type PositionBracketOverlayProps = {
  /**
   * The currently selected trading symbol (e.g. "BTCUSDT", "SOLUSDT").
   * EVERYTHING in this component - the open position lookup, the saved
   * stop-loss, and the persisted entry-anchor candle - is scoped to
   * this one symbol. The parent (ChartPanel) renders this component with
   * `key={symbol}`, so a symbol switch fully remounts it instead of
   * needing every ref/state below reset by hand; `symbol` is still
   * threaded through explicitly (rather than left as a stale closure)
   * for correctness even if that key ever gets removed.
   */
  symbol: string;
  /** Active chart timeframe; used to keep the TP/SL zone's real time span stable across TF switches. */
  interval: Interval;
  chartWrapRef: MutableRefObject<HTMLDivElement | null>;
  chartRef: MutableRefObject<IChartApi | null>;
  candleRef: MutableRefObject<ISeriesApi<"Candlestick"> | null>;
  lastDataTimeRef: MutableRefObject<UTCTimestamp | null>;
  /**
   * The real, live traded market price for `symbol` - NOT wherever the
   * mouse happens to be hovering. Used to validate that a dragged SL/TP
   * price is on the correct side of the current market.
   */
  marketPriceRef: MutableRefObject<number | null>;
  /**
   * Price of the confirmed 100%-reduce (full take-profit) limit order, if
   * any - sourced from open orders in App.tsx. Drives the persistent green
   * profit-zone rectangle between entry and TP, and hides the TP FULL
   * button once one already exists.
   */
  fullTakeProfitPrice: number | null;
  /**
   * Real Binance orderId of the confirmed full-TP order, if any. Clicking
   * that order's row in PositionsPanel's Open Orders tab sets
   * highlightedOrderIdRef to this same value - matched below to blink the
   * TP zone the same way the SL zone already blinks for its own
   * (synthetic, negated-algoId) row.
   */
  fullTakeProfitOrderId: string | null;
  /**
   * Converts a real bar timestamp into its current on-screen X coordinate
   * (native lookup + calibrated fallback, same as drawings use). Needed so
   * the TP/SL zone can be pinned to the candle the trade was actually
   * opened on, rather than to whatever the latest candle happens to be.
   */
  coordTimeToX: (time: UTCTimestamp) => number | null;
  /**
   * Set by App.tsx's focusOrderLine when an order row is clicked in
   * PositionsPanel. PositionsPanel's synthetic stop-loss row passes its
   * negated algoId as its orderId (see buildSyntheticStopOrder there) -
   * this component checks for that same negated value to know when the
   * stop-loss specifically (as opposed to some other order) should
   * blink.
   */
  highlightedOrderIdRef: MutableRefObject<string | null>;
  highlightedOrderUntilRef: MutableRefObject<number>;
  /**
   * Set by App.tsx's focusPosition whenever a row in the Positions tab
   * (as opposed to Open Orders) is clicked. A position has no single
   * Binance orderId to match against - there's only ever one open
   * position per symbol - so this is a bare timestamp rather than an
   * id+timestamp pair like highlightedOrderIdRef/highlightedOrderUntilRef
   * above. When active, it blinks the entry line together with
   * whichever TP/SL zones currently exist, in addition to (not instead
   * of) their own individual order-level highlighting.
   */
  highlightedPositionUntilRef: MutableRefObject<number>;
  /**
   * WHICH position ("SYMBOL-SIDE") is currently highlighted - see the
   * comment on this same ref in useChartRefs.ts. Without this, ANY
   * position row clicked in the (account-wide) Positions panel - for
   * ANY symbol - would blink whichever chart happened to be on screen,
   * regardless of whether it was actually that position.
   */
  highlightedPositionKeyRef: MutableRefObject<string | null>;
  /**
   * The same trade-marker list the chart canvas already renders its "B"/"S"
   * fill badges from (see useTradeMarkers/useDrawingCanvas). Used to anchor
   * the TP/SL zone to the candle the position was ACTUALLY filled on,
   * instead of "whichever candle happened to be latest" at the moment our
   * 1s position poll first noticed the new position - polling lag meant
   * that could already be one or more candles later than the real entry.
   */
  tradeMarkersRef: MutableRefObject<TradeMarker[]>;
  /**
   * Decimal precision for the active symbol's real tick size (see
   * trading/api/exchangeInfo.ts / useMarketData.ts). Used for every price
   * shown by this overlay - the drag preview, the SL FULL label, and the
   * placement confirmation toasts - so a symbol needing several decimals
   * (XRP, for instance) doesn't get every price rounded down to 1
   * decimal, which made it impossible to tell where the SL/TP actually
   * was while placing it.
   */
  pricePrecision: number;
  /**
   * Pushes a submitting/success/error message into the shared TradeToast
   * (rendered once, bottom-center of the canvas, by ChartPanel) instead of
   * this component showing its own separate confirmation box - keeps
   * SL/TP submission feedback visually and mechanically unified with every
   * other trade notification rather than being a second, differently
   * styled toast. Live drag-validation hints (e.g. "must be above current
   * price") stay local since they're tied directly to the in-progress
   * drag, not a one-shot event.
   */
  onToast: (toast: TradeToastState | null) => void;
  /**
   * Notifies the parent when the quick-close X (next to the TP FULL /
   * STOP LOSS buttons - see closePositionNow below) actually closes the
   * position, so it can record the trade marker/clear the PNL card the
   * same way PositionsPanel's own Market-close button already does.
   * Same signature, same shared handler in App.tsx.
   */
  onPositionClosed: (side: TradeSide, symbol: string, price?: number) => void;
};

// If the saved stop-loss line renders within this many pixels of the entry
// line, its label/cancel button are flipped to sit below the line instead
// of above it, so they never collide with the entry row's TP FULL / STOP
// LOSS buttons that always float above the entry line.
const STOP_LABEL_COLLISION_THRESHOLD_PX = 34;

// FEATURE: make break-even a deliberate, reachable SL target instead of asking
// the user to hit the entry price's exact floating-point value with the mouse.
// Eight pixels is large enough to catch the entry line reliably, but small
// enough that dragging away immediately releases the snap and restores normal
// stop-loss movement in either valid direction.
const BREAK_EVEN_SNAP_THRESHOLD_PX = 8;

// FEATURE: TP/SL boundaries use one visible price increment instead of the
// old hardcoded 0.1, which was suitable for BTC but far too large for cheap
// symbols. Exchange-derived display precision gives us the smallest price
// increment this chart can faithfully place and display.
function priceBoundaryEpsilon(pricePrecision: number): number {
  return 10 ** -Math.max(0, pricePrecision);
}

// Safety net: if the confirmed TP order never shows up in open orders
// (e.g. the "trading-state-changed" refresh is unusually slow or fails
// silently), stop showing the optimistic zone as "pending" after this long
// so it doesn't look stuck forever. It stays visible either way - this
// only affects the pending/dashed styling.
const OPTIMISTIC_TAKE_PROFIT_TIMEOUT_MS = 8_000;

// How long a settled status message (a placement/cancel confirmation or
// error) stays visible before it clears itself. Live validation feedback
// shown while actively placing a TP/SL is exempt - see the effect below.
const MESSAGE_AUTO_DISMISS_MS = 4_000;

// FEATURE: Plain positions now open with a visual risk bracket even before any
// TP/SL order exists. Half a percent above/below entry keeps the initial bracket
// compact enough to stay useful at normal chart zoom while preserving a symmetric
// 1R canvas. The real TP/SL is still created only after the user moves and confirms
// the corresponding draft line.
const DEFAULT_BRACKET_DISTANCE_PCT = 0.005;

// Default rightward extent of the zone on first render. This is only used to
// derive an initial logical-bar span from the CURRENT bar spacing; after that
// the stored extent lives in bar space so X-axis zoom scales it naturally.
const DEFAULT_ZONE_RIGHT_PAD_PX = 220;

// Width/height of the pixel handles used to resize the zone horizontally.
const ZONE_EDGE_HANDLE_WIDTH_PX = 6;

// When a position is first detected, only trust a trade marker as "the"
// entry fill if it landed within this many seconds of right now. Without
// a bound, a stale marker from an old (already-closed) position sitting
// in the 3-day marker retention window could otherwise get picked up as
// if it were this new position's entry.
const ENTRY_MARKER_LOOKBACK_SECONDS = 120;

const POSITION_ANCHOR_STORAGE_PREFIX = "fyxtez:position-anchor-v2:";
const POSITION_ZONE_PAD_STORAGE_PREFIX = "fyxtez:position-zone-pad-v1:";

type SavedPositionAnchor = {
  symbol: string;
  side: "LONG" | "SHORT";
  time: number;
};

type SavedPositionZonePad = {
  symbol: string;
  side: "LONG" | "SHORT";
  anchorTime: number;
  rightSeconds: number;
};

function positionAnchorStorageKey(symbol: string): string {
  return `${POSITION_ANCHOR_STORAGE_PREFIX}${symbol.toUpperCase()}`;
}

function loadPositionAnchor(
  symbol: string,
  side: "LONG" | "SHORT",
): UTCTimestamp | null {
  try {
    const raw = localStorage.getItem(positionAnchorStorageKey(symbol));
    if (!raw) return null;

    const parsed = JSON.parse(raw) as Partial<SavedPositionAnchor>;
    const time = Number(parsed.time);

    if (
      parsed.symbol !== symbol.toUpperCase() ||
      parsed.side !== side ||
      !Number.isFinite(time) ||
      time <= 0
    ) {
      return null;
    }

    return time as UTCTimestamp;
  } catch {
    return null;
  }
}

function savePositionAnchor(
  symbol: string,
  side: "LONG" | "SHORT",
  time: UTCTimestamp,
): void {
  const value: SavedPositionAnchor = {
    symbol: symbol.toUpperCase(),
    side,
    time: Number(time),
  };

  localStorage.setItem(positionAnchorStorageKey(symbol), JSON.stringify(value));
}

function clearPositionAnchor(symbol: string): void {
  localStorage.removeItem(positionAnchorStorageKey(symbol));
}

function positionZonePadStorageKey(symbol: string): string {
  return `${POSITION_ZONE_PAD_STORAGE_PREFIX}${symbol.toUpperCase()}`;
}

function loadPositionZonePad(
  symbol: string,
  side: "LONG" | "SHORT",
  anchorTime: UTCTimestamp | null,
): ZonePad | null {
  if (anchorTime == null) return null;

  try {
    const raw = localStorage.getItem(positionZonePadStorageKey(symbol));
    if (!raw) return null;

    const parsed = JSON.parse(raw) as Partial<SavedPositionZonePad>;
    const savedAnchorTime = Number(parsed.anchorTime);
    const rightSeconds = Number(parsed.rightSeconds);

    if (
      parsed.symbol !== symbol.toUpperCase() ||
      parsed.side !== side ||
      savedAnchorTime !== Number(anchorTime) ||
      !Number.isFinite(rightSeconds) ||
      rightSeconds < 0
    ) {
      return null;
    }

    return { rightSeconds };
  } catch {
    return null;
  }
}

function savePositionZonePad(
  symbol: string,
  side: "LONG" | "SHORT",
  anchorTime: UTCTimestamp | null,
  rightSeconds: number | null,
): void {
  if (anchorTime == null || rightSeconds == null || !Number.isFinite(rightSeconds)) {
    return;
  }

  const value: SavedPositionZonePad = {
    symbol: symbol.toUpperCase(),
    side,
    anchorTime: Number(anchorTime),
    rightSeconds,
  };

  localStorage.setItem(positionZonePadStorageKey(symbol), JSON.stringify(value));
}

function clearPositionZonePad(symbol: string): void {
  localStorage.removeItem(positionZonePadStorageKey(symbol));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function getDefaultBracketPrices(position: OpenPosition): {
  takeProfit: number;
  stopLoss: number;
} {
  const distance = position.entry_price * DEFAULT_BRACKET_DISTANCE_PCT;

  // FEATURE: The draft bracket is directional: LONG profit lives above entry
  // and risk below it, while SHORT reverses those sides. Keeping both exactly
  // 0.5% from entry makes the initial rectangles equal-height in price terms and
  // therefore starts the visual R:R at 1R : -1R.
  return position.side === "LONG"
    ? {
        takeProfit: position.entry_price + distance,
        stopLoss: position.entry_price - distance,
      }
    : {
        takeProfit: position.entry_price - distance,
        stopLoss: position.entry_price + distance,
      };
}

function formatRMultiple(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "—R";

  // FEATURE: Keep R labels compact enough to sit inside the bracket while still
  // preserving useful precision for ratios such as 2.5R or 2.33R.
  const rounded = value.toFixed(2).replace(/\.00$/, "").replace(/(\.\d)0$/, "$1");
  return `${rounded}R`;
}

export default function PositionBracketOverlay({
  symbol,
  interval,
  chartWrapRef,
  chartRef,
  candleRef,
  lastDataTimeRef,
  marketPriceRef,
  fullTakeProfitPrice,
  fullTakeProfitOrderId,
  coordTimeToX,
  highlightedOrderIdRef,
  highlightedOrderUntilRef,
  highlightedPositionUntilRef,
  highlightedPositionKeyRef,
  tradeMarkersRef,
  pricePrecision,
  onToast,
  onPositionClosed,
}: PositionBracketOverlayProps) {
  const [position, setPosition] = useState<OpenPosition | null>(null);
  const [isClosingPosition, setIsClosingPosition] = useState(false);
  // FEATURE: The chart-side X used to submit a market close immediately, which
  // made an accidental click irreversible. Keep confirmation local to this
  // overlay so YES reuses the existing close flow while NO cancels without an
  // API request or any change to the live position.
  const [isCloseConfirmationVisible, setIsCloseConfirmationVisible] =
    useState(false);

  useEffect(() => {
    // FIX: Confirmation belongs only to the position/symbol where X was
    // clicked; clear it when navigation or a position update changes that
    // context so a stale YES can never close a different trade.
    setIsCloseConfirmationVisible(false);
  }, [symbol, position?.side, position?.quantity, position?.entry_price]);

  // FEATURE: Long-held positions can hide the chart-side TP FULL / STOP LOSS
  // / quick-close controls together with the dashed entry line, while keeping
  // the position itself, liquidation line, and any already-placed TP/SL zones.
  // This preference is per-symbol and shared with PositionsPanel through the
  // small storage/event helper.
  const [areEntryControlsVisible, setAreEntryControlsVisible] = useState(() =>
    areTpSlControlsVisible(symbol),
  );

  // FEATURE: The whole chart-side position action row (HIDE / TP FULL /
  // STOP LOSS / X) can be picked up with its own arrow and repositioned like
  // the candle-close timer. Keep the offset relative to the entry-line origin
  // so the controls continue following the live chart while preserving the
  // user's chosen nearby placement.
  const [entryControlsOffset, setEntryControlsOffset] = useState({ x: 0, y: 0 });
  const [isEntryControlsMoving, setIsEntryControlsMoving] = useState(false);
  const entryControlsRef = useRef<HTMLDivElement | null>(null);
  const entryControlsGrabOffsetRef = useRef({ x: 0, y: 0 });

  useEffect(() => {
    const handleVisibilityChange = (event: Event) => {
      const detail = (event as CustomEvent<{ symbol?: string; visible?: boolean }>).detail;
      if (detail?.symbol !== symbol.toUpperCase()) return;
      setAreEntryControlsVisible(detail.visible !== false);
    };

    window.addEventListener(TP_SL_CONTROLS_VISIBILITY_EVENT, handleVisibilityChange);
    return () =>
      window.removeEventListener(
        TP_SL_CONTROLS_VISIBILITY_EVENT,
        handleVisibilityChange,
      );
  }, [symbol]);
  const [dragKind, setDragKind] = useState<DragKind | null>(null);
  const [previewPrice, setPreviewPrice] = useState<number | null>(null);
  const [savedStop, setSavedStop] = useState<SavedStop | null>(() =>
    loadSavedStop(symbol),
  );

  // Optimistic placements: set the instant a TP/SL submission starts, so
  // the zone/line stays visible through the network round-trip instead of
  // disappearing until the request resolves. Cleared immediately on
  // failure (reverting to nothing); for stop-loss, cleared on success too
  // since savedStop takes over at that point. For take-profit, cleared
  // once the real order price arrives via the fullTakeProfitPrice prop
  // (or the timeout above, as a safety net).
  const [optimisticTakeProfit, setOptimisticTakeProfit] = useState<
    number | null
  >(null);
  const [optimisticStopLoss, setOptimisticStopLoss] = useState<number | null>(
    null,
  );

  // Manually adjustable horizontal extent of the TP/SL zone, stored as real
  // elapsed seconds from the position entry. This keeps the selected right
  // edge attached to the same moment in time across both X-axis zoom AND
  // timeframe changes (1m -> 1h, 1h -> 4h, etc.).
  const [zonePad, setZonePad] = useState<ZonePad>({
    rightSeconds: null,
  });
  const zonePadRef = useRef<ZonePad>(zonePad);
  zonePadRef.current = zonePad;

  const [edgeDrag, setEdgeDrag] = useState<EdgeDragKind | null>(null);
  const edgeDragRef = useRef<EdgeDragKind | null>(null);
  const edgeDragStartRef = useRef<{
    pointerX: number;
    padSeconds: number;
    barSpacing: number;
    intervalSeconds: number;
  } | null>(null);

  const [coordinates, setCoordinates] = useState({
    entryY: 0,
    previewY: 0,
    stopY: 0,
    takeProfitY: 0,
    liquidationY: null as number | null,
    liquidationLineWidth: 0,
    paneLeft: 0,
    paneWidth: 0,
    paneHeight: 0,
    // Width of the entry line itself. Unlike paneWidth (the TP/SL zone's
    // own manually-resizable width, driven by zonePad), this always
    // reaches whichever candle is CURRENTLY the latest one - see the
    // "entry line width" section inside recomputeCoordinates below.
    entryLineWidth: 0,
    ready: false,
    isStopHighlighted: false,
    isTakeProfitHighlighted: false,
    isPositionHighlighted: false,
  });
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const dragKindRef = useRef<DragKind | null>(null);
  const previewPriceRef = useRef<number | null>(null);
  const positionRef = useRef<OpenPosition | null>(null);
  const savedStopRef = useRef<SavedStop | null>(savedStop);

  /*
   * FIX (TP FULL / STOP LOSS / close-X reappearing for a few seconds
   * after a successful close): closePositionNow optimistically calls
   * setPosition(null) the instant the market-close order confirms, but
   * refreshPosition below always trusts whatever getPositions() returns
   * - and Binance's own account/position data takes a beat to actually
   * reflect a fill that was JUST placed. So the very next poll (either
   * the self-heal interval or an account-state-changed burst) could
   * re-fetch, still see the position "open" from Binance's own
   * perspective, and overwrite the optimistic null right back to the
   * old position - reviving the TP FULL/STOP LOSS/close buttons for
   * however long that lag lasts. The existing request-id guard in
   * refreshPosition only protects against responses resolving out of
   * order; it does nothing here, since each poll's response is
   * genuinely the latest one, just still factually stale relative to
   * an order we KNOW just filled. This tracks "we just confirmed this
   * position closed, ignore contrary poll results until" - refreshPosition
   * treats the position as gone regardless of what a poll returns until
   * this window passes, then trusts Binance's data normally again.
   */
  const suppressReviveUntilRef = useRef(0);
  const fullTakeProfitPriceRef = useRef<number | null>(fullTakeProfitPrice);
  const fullTakeProfitOrderIdRef = useRef<string | null>(fullTakeProfitOrderId);
  const optimisticTakeProfitRef = useRef<number | null>(optimisticTakeProfit);
  const optimisticStopLossRef = useRef<number | null>(optimisticStopLoss);

  // The candle time the currently open position was detected on. Captured
  // once when a position first appears, and cleared when it closes - the
  // zone's left edge is pinned to this, never to "whatever the latest
  // candle is right now".
  const entryAnchorTimeRef = useRef<UTCTimestamp | null>(null);

  // Last successfully-resolved on-screen X for the anchor candle. Held
  // onto across frames where coordTimeToX momentarily can't resolve one
  // (e.g. right after switching timeframe, while candle data reloads) so
  // the zone holds its position instead of flashing to pane-center.
  const lastKnownAnchorXRef = useRef<number | null>(null);

  // Same purpose as lastKnownAnchorXRef above, but tracks the on-screen X
  // of whichever candle is CURRENTLY the latest one, used to size the
  // entry line's own width (see recomputeCoordinates below). Kept
  // separate from lastKnownAnchorXRef since the two can legitimately
  // resolve on different frames (e.g. right after a timeframe switch, one
  // may resolve before the other).
  const lastKnownLatestXRef = useRef<number | null>(null);

  positionRef.current = position;
  savedStopRef.current = savedStop;
  fullTakeProfitPriceRef.current = fullTakeProfitPrice;
  fullTakeProfitOrderIdRef.current = fullTakeProfitOrderId;
  optimisticTakeProfitRef.current = optimisticTakeProfit;
  optimisticStopLossRef.current = optimisticStopLoss;

  // A stop created by another workflow (notably AUTO MARKET) is persisted
  // through trading/stopLoss.ts and followed by a trading-state-changed event.
  // Reload it here immediately so this mounted overlay shows the red SL zone
  // and hides the create STOP LOSS button without requiring a page refresh.
  useEffect(() => {
    const refreshSavedStop = () => {
      setSavedStop(loadSavedStop(symbol));
    };

    window.addEventListener("trading-state-changed", refreshSavedStop);
    window.addEventListener("storage", refreshSavedStop);

    return () => {
      window.removeEventListener("trading-state-changed", refreshSavedStop);
      window.removeEventListener("storage", refreshSavedStop);
    };
  }, [symbol]);

  // FIX (snap-back bug, take-profit): same root cause as the stop-loss fix
  // below - `fullTakeProfitPrice ?? optimisticTakeProfit` meant that while
  // MOVING an already-placed take-profit, the `??` never reached
  // optimisticTakeProfit at all, since fullTakeProfitPrice was still the
  // OLD (pre-move) confirmed price for the whole cancel+replace round-trip.
  // The zone snapped back to the old price the instant the drag was
  // released, then jumped to the new price once the open-orders refresh
  // finally caught up. Prioritizing optimisticTakeProfit whenever it's set
  // keeps the zone exactly where it was dropped the whole time; see the
  // matching fix in the clear-it-out effect below, which used to drop
  // optimisticTakeProfit the instant *any* confirmed price existed rather
  // than waiting for it to actually match the moved-to price.
  const defaultBracketPrices = position ? getDefaultBracketPrices(position) : null;

  // FEATURE: Missing protection orders are represented by non-submitted draft
  // prices instead of collapsing back to the entry-row TP FULL / STOP LOSS
  // buttons. As soon as the user confirms a draft move, the optimistic/confirmed
  // order price takes precedence and the draft automatically disappears.
  const displayedTakeProfitPrice =
    optimisticTakeProfit ??
    fullTakeProfitPrice ??
    defaultBracketPrices?.takeProfit ??
    null;

  // FIX (snap-back bug): previously this was
  //   savedStop?.triggerPrice ?? optimisticStopLoss
  // which meant that while MOVING an already-existing stop loss, the
  // `??` never reached optimisticStopLoss at all - savedStop was still
  // the OLD (pre-move) confirmed stop for the entire cancel+replace
  // network round-trip, so the line snapped back to the old price the
  // instant you released the drag, then jumped to the new price once the
  // request finally resolved. Prioritizing optimisticStopLoss whenever
  // it's set (i.e. a placement/move is in flight) means the line stays
  // exactly where you dropped it the whole time; savedStop only takes
  // over again once the optimistic value is cleared (on success or
  // failure - see finishDrag below).
  const displayedStopPrice =
    optimisticStopLoss ??
    savedStop?.triggerPrice ??
    defaultBracketPrices?.stopLoss ??
    null;

  // These flags distinguish a purely visual 0.5% planning line from a real or
  // in-flight exchange order. They drive both the line controls and the moment
  // at which the normal yellow TP order drawing is allowed to take over.
  const isTakeProfitDraft =
    position != null &&
    optimisticTakeProfit == null &&
    fullTakeProfitPrice == null;
  const isStopDraft =
    position != null && optimisticStopLoss == null && savedStop == null;

  // FIX (snap-back bug, same pattern as isStopPending below): previously
  // `fullTakeProfitPrice == null && optimisticTakeProfit != null`, which
  // only ever counted as "pending" for a brand-new TP placement (no prior
  // fullTakeProfitPrice). Moving an existing TP also goes through the
  // optimistic phase, so the dashed "pending" styling should show then
  // too - it's simply "is an optimistic TP currently in flight".
  const isTakeProfitPending = optimisticTakeProfit != null;

  // FIX: previously `savedStop == null && optimisticStopLoss != null`,
  // which only ever counted as "pending" for a brand-new stop-loss
  // placement (no prior savedStop). Moving an existing stop also goes
  // through the optimistic phase (cancel old -> place new), so the
  // dashed "pending" styling should show then too - it's simply "is an
  // optimistic stop currently in flight".
  const isStopPending = optimisticStopLoss != null;

  const findBestEntryMarker = useCallback(
    (currentPosition: OpenPosition, recentOnly: boolean): TradeMarker | null => {
      const entrySide = currentPosition.side === "LONG" ? "BUY" : "SELL";
      const nowSeconds = Date.now() / 1000;

      const candidates = tradeMarkersRef.current.filter((marker) => {
        if (marker.side !== entrySide) return false;

        const markerTime = Number(marker.time);
        if (!Number.isFinite(markerTime) || markerTime > nowSeconds + 5) {
          return false;
        }

        return !recentOnly || nowSeconds - markerTime <= ENTRY_MARKER_LOOKBACK_SECONDS;
      });

      if (candidates.length === 0) return null;

      // On a reload there may be several retained B/S markers. The original
      // entry fill is normally the marker whose fill price is closest to the
      // position's current average entry price. Use time as the tie-breaker.
      return candidates
        .slice()
        .sort((left, right) => {
          const leftDistance = Math.abs(left.price - currentPosition.entry_price);
          const rightDistance = Math.abs(right.price - currentPosition.entry_price);

          if (leftDistance !== rightDistance) {
            return leftDistance - rightDistance;
          }

          return Number(left.time) - Number(right.time);
        })[0];
    },
    [tradeMarkersRef],
  );

  const persistEntryAnchor = useCallback(
    (currentPosition: OpenPosition, time: UTCTimestamp) => {
      entryAnchorTimeRef.current = time;
      lastKnownAnchorXRef.current = null;
      savePositionAnchor(symbol, currentPosition.side, time);
    },
    [symbol],
  );

  // FIX (stale close/reopen race - the actual bug behind "TP FULL / STOP
  // LOSS buttons missing until page refresh"):
  //
  // refreshPosition is invoked from an "account-state-changed" listener
  // that debounces bursts of events into a single call 100ms later (see
  // the effect below) - but nothing here has EVER guarded against two
  // overlapping refreshPosition CALLS resolving out of order. Closing a
  // position and opening a new one within a couple of seconds (e.g.
  // AUTO MARKET -> close -> plain MARKET, as reported) fires two
  // separate "account-state-changed" bursts close together. If the
  // slower of the two network round-trips (typically the one checking
  // whether the OLD position closed) resolves AFTER the faster one that
  // already reflects the NEW position, it would silently clobber
  // `position` back to null and wipe savedStop/optimistic TP-SL state
  // for the position that is actually still open right now - and
  // nothing re-runs to fix it until a full page reload re-reads
  // everything from scratch (which is exactly why refreshing "fixed"
  // it). A monotonically increasing request id - the same pattern this
  // codebase already uses elsewhere (usePositions.ts, useTradeMenu.ts) -
  // makes sure only the MOST RECENTLY ISSUED call is allowed to commit
  // state, so a stale response is simply discarded instead of undoing
  // more current, correct state.
  const positionRequestIdRef = useRef(0);

  const refreshPosition = useCallback(async (force = false) => {
    const requestId = ++positionRequestIdRef.current;

    try {
      const positions = await getPositions(undefined, force);

      if (requestId !== positionRequestIdRef.current) {
        // A newer refreshPosition call has already started (or
        // finished) since this one began - this response is stale and
        // must not overwrite whatever more current state exists.
        return;
      }

      const fetchedNext =
        positions.find(
          (item) => item.symbol.toUpperCase() === symbol.toUpperCase(),
        ) ?? null;

      const next =
        fetchedNext && Date.now() < suppressReviveUntilRef.current
          ? null
          : fetchedNext;

      if (next && !positionRef.current) {
        // Restore the original entry candle after a page refresh. Previously
        // this component always started with an empty ref, and if the marker
        // was not available on that exact poll it permanently fell back to
        // lastDataTimeRef (the newest candle), relocating both rectangles.
        const persistedAnchor = loadPositionAnchor(symbol, next.side);
        const entryMarker =
          persistedAnchor == null ? findBestEntryMarker(next, true) : null;
        const restoredMarker =
          persistedAnchor == null && entryMarker == null
            ? findBestEntryMarker(next, false)
            : null;
        const markerTime = entryMarker?.time ?? restoredMarker?.time ?? null;
        const anchorTime =
          persistedAnchor ??
          (markerTime == null ? null : (markerTime as UTCTimestamp)) ??
          lastDataTimeRef.current;

        if (anchorTime != null) {
          persistEntryAnchor(next, anchorTime);
        }

        // FIX: a brand-new position must never inherit stale in-flight
        // TP/SL placeholder state left over from whichever position
        // previously occupied this symbol. Normally the `!next` branch
        // below already clears these the moment the old position
        // closes - but if that detection got raced/skipped (see the big
        // comment above), these would otherwise sit non-null forever
        // and keep the TP FULL / STOP LOSS buttons hidden. Reloading
        // savedStop straight from localStorage (rather than trusting
        // whatever this component's React state currently holds) is
        // what actually self-heals the reported bug without requiring a
        // page reload.
        setOptimisticTakeProfit(null);
        setOptimisticStopLoss(null);
        setSavedStop(loadSavedStop(symbol));

        // FIX: a manual TP/SL zone width used to live only in React state, so
        // every page reload rebuilt the default ~220px width and made a resized
        // SL rectangle jump back to a different right edge. Restore the saved
        // elapsed-time width only when it belongs to this exact position anchor;
        // otherwise clear stale data so a later trade on the same symbol cannot
        // inherit the previous trade's geometry.
        const restoredZonePad = loadPositionZonePad(
          symbol,
          next.side,
          entryAnchorTimeRef.current,
        );
        const nextZonePad = restoredZonePad ?? { rightSeconds: null };
        zonePadRef.current = nextZonePad;
        setZonePad(nextZonePad);
        if (!restoredZonePad) {
          clearPositionZonePad(symbol);
        }
      }

      setPosition(next);

      if (!next) {
        entryAnchorTimeRef.current = null;
        lastKnownAnchorXRef.current = null;
        lastKnownLatestXRef.current = null;
        clearPositionAnchor(symbol);
        // FIX: the persisted width belongs to one concrete open trade, not the
        // symbol forever. Once the account is confirmed flat, discard it so the
        // next position starts with the normal default width.
        clearPositionZonePad(symbol);

        // FIX: TP/SL visibility used to persist only by symbol, so hiding one
        // completed trade also hid every later trade opened on that symbol.
        // Reset only after a flat position is confirmed; this preserves HIDE
        // across refreshes while the same trade is still open, but guarantees
        // the next newly opened trade starts with its controls visible.
        if (!areTpSlControlsVisible(symbol)) {
          setTpSlControlsVisible(symbol, true);
        }

        // A close can happen while a TP/SL placement is armed or while a
        // success/error message is still visible. Clear every position-scoped
        // interaction immediately so stale TP FULL / STOP LOSS controls and
        // "no open position" errors cannot survive after the position is gone.
        dragKindRef.current = null;
        previewPriceRef.current = null;
        setDragKind(null);
        setPreviewPrice(null);
        setMessage(null);
        setIsSubmitting(false);

        if (savedStopRef.current) {
          setSavedStop(null);
          // FIX: this used to be `saveStop(null)` with NO symbol
          // argument - stopLoss.ts's old default parameter silently
          // fell back to DEFAULT_SYMBOL ("BTCUSDT"), so closing a
          // position on any OTHER symbol cleared BTCUSDT's saved stop
          // instead of this symbol's. `symbol` is now required, so this
          // must (and does) pass it explicitly.
          saveStop(null, symbol);

          // PositionsPanel keeps its own independent copy of the saved
          // stop-loss (read from the same localStorage key). The native
          // `storage` event does NOT fire in the tab that made the write,
          // so without this, PositionsPanel would never learn the stop
          // was cleared here and would keep showing a synthetic "ghost"
          // SL row in Open Orders for a position that no longer exists.
          // Guarded on savedStopRef.current so this only fires once, on
          // the actual open->closed transition, not every poll tick.
          window.dispatchEvent(new Event("trading-state-changed"));
        }
        // The position is gone (closed) - drop any leftover optimistic
        // placements so they can't linger into a future position.
        setOptimisticTakeProfit(null);
        setOptimisticStopLoss(null);
      }
    } catch {
      // Connection indicators already surface backend failures.
    }
  }, [
    findBestEntryMarker,
    lastDataTimeRef,
    persistEntryAnchor,
    symbol,
  ]);

  useEffect(() => {
    void refreshPosition(true);

    let refreshTimers: number[] = [];

    const clearRefreshTimers = () => {
      refreshTimers.forEach((timer) => window.clearTimeout(timer));
      refreshTimers = [];
    };

    const handleTradingStateChanged = () => {
      clearRefreshTimers();

      // FIX: one debounced read could land after account_state contained the
      // new fill but before the separate positionRisk refresh supplied its
      // liquidationPrice. Nothing retried until the 4-second safety poll, so
      // the position appeared immediately while its red boundary arrived
      // 2-3 seconds later. This short event-driven reconciliation burst covers
      // that normal two-cache propagation window without increasing steady
      // background polling once the order has settled.
      [0, 180, 500, 1_000].forEach((delay) => {
        refreshTimers.push(
          window.setTimeout(() => {
            void refreshPosition(true);
          }, delay),
        );
      });
    };

    window.addEventListener("account-state-changed", handleTradingStateChanged);

    return () => {
      clearRefreshTimers();
      window.removeEventListener("account-state-changed", handleTradingStateChanged);
    };
  }, [refreshPosition]);

  // FIX: refreshPosition used to run ONLY in reaction to the
  // "account-state-changed" event above - if that event (or whatever
  // upstream it depends on: the local trading websocket, or the
  // backend's own connection to Binance's user-data stream) is ever
  // missed, this component had no other way to notice a position
  // opened, closed, or changed. This session has already confirmed real
  // network unreliability for persistent connections on this setup (the
  // chart's kline WebSocket silently dropped data; the backend logged
  // an outright failed Binance REST call) - the exact symptom reported
  // ("Binance shows 0 positions but the app still shows one open", and
  // separately "TP FULL / STOP LOSS buttons missing until refresh") is
  // consistent with a missed update somewhere in that chain. A quiet
  // periodic poll, independent of any push notification, guarantees
  // this overlay can never drift out of sync with reality for more than
  // one poll interval - the same fix already applied to the chart's own
  // live price feed (see useMarketData.ts) and to usePositions.ts /
  // useOpenOrders.ts.
  useEffect(() => {
    const intervalId = window.setInterval(() => {
      void refreshPosition();
    }, 4_000);

    return () => window.clearInterval(intervalId);
  }, [refreshPosition]);

  // Once the real take-profit order price shows up (via open orders) AND
  // it actually matches the price we optimistically set, the placeholder
  // has served its purpose - drop it so displayedTakeProfitPrice reads
  // from the confirmed source only.
  //
  // FIX (snap-back bug): previously this cleared as soon as
  // `fullTakeProfitPrice != null`, with no check that it matched. That's
  // fine for a brand-new placement (fullTakeProfitPrice starts null), but
  // when MOVING an existing take-profit, fullTakeProfitPrice is already
  // non-null (the OLD, pre-move price) the instant optimisticTakeProfit is
  // set - so this effect fired immediately and cleared the optimistic
  // value before the open-orders refresh had even landed, and
  // displayedTakeProfitPrice fell back to the stale confirmed price for
  // the rest of the round-trip (the actual snap-back the user saw).
  // Waiting for the two to match keeps the optimistic price displayed
  // until the confirmed data has genuinely caught up.
  useEffect(() => {
    if (optimisticTakeProfit == null) return;

    if (
      fullTakeProfitPrice != null &&
      fullTakeProfitPrice.toFixed(pricePrecision) ===
        optimisticTakeProfit.toFixed(pricePrecision)
    ) {
      setOptimisticTakeProfit(null);
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setOptimisticTakeProfit(null);
    }, OPTIMISTIC_TAKE_PROFIT_TIMEOUT_MS);

    return () => window.clearTimeout(timeoutId);
  }, [optimisticTakeProfit, fullTakeProfitPrice, pricePrecision]);

  // Auto-dismiss a settled status message after a few seconds. Skipped
  // while a TP/SL placement is actively in progress (dragKind set), since
  // that's when `message` is being used for live validation feedback
  // ("must be above current price" etc.) that should stay up until the
  // placement itself changes or ends, not clear itself out from under the
  // user mid-placement.
  useEffect(() => {
    if (!message || dragKind) return;

    const timeoutId = window.setTimeout(() => {
      setMessage(null);
    }, MESSAGE_AUTO_DISMISS_MS);

    return () => window.clearTimeout(timeoutId);
  }, [message, dragKind]);

  // Computes entryY/previewY/stopY/takeProfitY plus the zone's horizontal
  // extent (paneLeft/paneWidth), and commits them to state. Called from
  // the RAF render loop every frame (so the zone tracks price changes and
  // pans/zooms smoothly), AND synchronously from a layout effect whenever
  // a value that should be reflected *immediately* changes (see below) -
  // without the layout-effect call, those changes would render one frame
  // late using stale coordinates, which is what caused the TP/SL zone to
  // visibly snap to the wrong spot for a frame right after a placement
  // was confirmed.
  const recomputeCoordinates = useCallback(() => {
    const wrap = chartWrapRef.current;
    const chart = chartRef.current;
    const series = candleRef.current;
    const currentPosition = positionRef.current;

    if (!wrap || !chart || !series || !currentPosition) {
      setCoordinates((current) =>
        current.ready ? { ...current, ready: false } : current,
      );
      return;
    }

    const entryY = series.priceToCoordinate(currentPosition.entry_price);
    const targetPreviewPrice = previewPriceRef.current;
    const previewY =
      targetPreviewPrice == null
        ? null
        : series.priceToCoordinate(targetPreviewPrice);

    // FIX (snap-back bug, take 2): this is the ACTUAL calculation that
    // drives the rectangle's on-screen top/height (via coordinates.stopY
    // below) - the `displayedStopPrice` fix elsewhere in this file only
    // controls label text / show-hide, not positioning. This had its own
    // separate copy of the same stale-priority bug: while moving an
    // existing stop loss, `savedStopRef.current` is still the OLD
    // confirmed stop for the entire cancel+replace network round-trip, so
    // `??` never reached the new optimistic price and the zone rendered
    // at the OLD position the whole time, then jumped once savedStop
    // finally updated. Prioritizing the optimistic price whenever one is
    // in flight fixes the actual rendered position, not just the label.
    const draftBracketPrices = getDefaultBracketPrices(currentPosition);
    const effectiveStopPrice =
      optimisticStopLossRef.current ??
      savedStopRef.current?.triggerPrice ??
      draftBracketPrices.stopLoss;
    const stopY =
      effectiveStopPrice == null
        ? null
        : series.priceToCoordinate(effectiveStopPrice);

    // FIX (snap-back bug, take 2 - take-profit): same stale-priority bug
    // as effectiveStopPrice above, just on the take-profit side. While
    // moving an existing TP, fullTakeProfitPriceRef.current is still the
    // OLD confirmed price for the whole cancel+replace round-trip, so `??`
    // never reached the new optimistic price and the zone rendered at the
    // OLD position until fullTakeProfitPrice finally updated.
    const effectiveTakeProfitPrice =
      optimisticTakeProfitRef.current ??
      fullTakeProfitPriceRef.current ??
      draftBracketPrices.takeProfit;
    const takeProfitY =
      effectiveTakeProfitPrice == null
        ? null
        : series.priceToCoordinate(effectiveTakeProfitPrice);

    // FEATURE: liquidation comes from the live position snapshot, not a
    // draggable/saved drawing. Calculating it in the same render loop as
    // entry/TP/SL keeps the danger line aligned while zooming or panning.
    const liquidationY =
      currentPosition.liquidation_price == null
        ? null
        : series.priceToCoordinate(currentPosition.liquidation_price);

    if (entryY == null) return;

    const paneSize = chart.paneSize();
    const paneWidth = paneSize.width;

    // Late recovery path: markers can become available after the first
    // position poll during page startup. Prefer the real fill marker and
    // persist it before resorting to the newest candle.
    if (entryAnchorTimeRef.current == null) {
      const persistedAnchor = loadPositionAnchor(symbol, currentPosition.side);
      const entryMarker = findBestEntryMarker(currentPosition, false);
      const recoveredTime =
        persistedAnchor ??
        (entryMarker?.time as UTCTimestamp | undefined) ??
        lastDataTimeRef.current;

      if (recoveredTime != null) {
        persistEntryAnchor(currentPosition, recoveredTime);
      }
    }

    const anchorTime = entryAnchorTimeRef.current;
    const resolvedAnchorX = anchorTime != null ? coordTimeToX(anchorTime) : null;

    // coordTimeToX briefly returns null right after switching timeframe
    // (the chart's candle data is momentarily empty while the new
    // interval reloads) or in other transient states. Hold the last
    // successfully-resolved position instead of defaulting to pane
    // center in that gap - otherwise the zone visibly flashes to the
    // middle of the screen for a frame during every timeframe switch.
    const anchorX =
      resolvedAnchorX ?? lastKnownAnchorXRef.current ?? paneWidth * 0.5;

    if (resolvedAnchorX != null) {
      lastKnownAnchorXRef.current = resolvedAnchorX;
    }

    const currentBarSpacing = Math.max(0.01, chart.timeScale().options().barSpacing);
    const currentIntervalSeconds = intervalSeconds[interval];
    const pad = zonePadRef.current;

    // FIX (timeframe-switch width bug): a logical BAR count is not a stable
    // duration when the timeframe changes. Convert the initial 220px default
    // to elapsed seconds once, then convert seconds -> bars -> pixels using the
    // CURRENT timeframe on every render. The same SL/TP zone therefore keeps
    // the exact same real-world duration on 1m, 1h, 4h, etc.
    const rightSeconds =
      pad.rightSeconds ??
      (DEFAULT_ZONE_RIGHT_PAD_PX / currentBarSpacing) * currentIntervalSeconds;

    if (pad.rightSeconds == null) {
      const initializedPad = { rightSeconds };
      zonePadRef.current = initializedPad;
      setZonePad(initializedPad);
    }

    const anchoredX = anchorX;
    // The left edge is always pinned exactly to the anchor now - the zone can
    // never extend backward past the candle the trade actually opened on.
    const rawLeft = anchoredX;
    const rightBarsOnCurrentTimeframe = rightSeconds / currentIntervalSeconds;
    const rawRight =
      anchoredX + rightBarsOnCurrentTimeframe * currentBarSpacing;

    // Deliberately NOT clamped into [0, paneWidth]. Zooming/panning can
    // legitimately move the anchor candle off either edge of the visible
    // pane - clamping used to forcibly pin the zone to whichever edge it
    // crossed instead of letting it continue scrolling off-canvas, which
    // looked like the zone randomly relocating itself on every zoom.
    // .position-bracket-overlay already has `overflow: hidden`, so an
    // off-screen zone is simply clipped, exactly like every other
    // off-screen drawing on this chart already behaves.
    const paneLeft = rawLeft;
    const bracketWidth = Math.max(0, rawRight - rawLeft);

    // The entry line's width is intentionally independent of the TP/SL
    // zone's own resizable width (logical zonePad/bracketWidth above) - it should
    // always reach whichever candle is CURRENTLY the latest one, growing
    // on its own as new candles print, rather than stopping at a
    // manually-set (or default) pad. Same "hold the last known position
    // across a transient resolve miss" pattern as anchorX above, so a
    // timeframe switch doesn't collapse/flicker the line for a frame.
    const latestTime = lastDataTimeRef.current;
    const resolvedLatestX =
      latestTime != null ? coordTimeToX(latestTime) : null;
    const latestX =
      resolvedLatestX ?? lastKnownLatestXRef.current ?? rawRight;

    if (resolvedLatestX != null) {
      lastKnownLatestXRef.current = resolvedLatestX;
    }

    const entryLineWidth = Math.max(0, latestX - anchoredX);

    // PositionsPanel's synthetic stop-loss row passes
    // `synthetic-stop-${algoId}` as its orderId (see
    // buildSyntheticStopOrder in PositionsPanel.tsx - it used to be
    // -algoId, a negative-number trick, back when orderId was still a
    // number; now that every order id is a string end to end, a
    // non-numeric string prefix serves the same "can never collide with
    // a real orderId" purpose). Clicking that row sets these same refs
    // that real chart drawings already use for their own blink - match
    // against that same prefixed id to know it's specifically the
    // stop-loss being pinged.
    const currentSavedStop = savedStopRef.current;
    const isStopHighlighted =
      currentSavedStop != null &&
      highlightedOrderIdRef.current === `synthetic-stop-${currentSavedStop.algoId}` &&
      Date.now() < highlightedOrderUntilRef.current;

    const isTakeProfitHighlighted =
      fullTakeProfitOrderIdRef.current != null &&
      highlightedOrderIdRef.current === fullTakeProfitOrderIdRef.current &&
      Date.now() < highlightedOrderUntilRef.current;

    // Set by App.tsx's focusPosition when a row in the Positions tab
    // (rather than Open Orders) is clicked. Unlike the two checks above,
    // this isn't tied to any specific order id - a position has no
    // single Binance orderId, so it's matched by "SYMBOL-SIDE" instead.
    //
    // FIX: this used to be `Date.now() < highlightedPositionUntilRef.current`
    // with no symbol/side check at all - so clicking ANY position row in
    // the (now account-wide) Positions panel, for ANY symbol, blinked
    // whichever chart happened to be open, regardless of whether that
    // was actually the position that was clicked. Comparing against
    // highlightedPositionKeyRef (set to the clicked row's own
    // "SYMBOL-SIDE") is what scopes the blink to the position it
    // actually belongs to.
    const isPositionHighlighted =
      highlightedPositionKeyRef.current ===
        `${symbol}-${currentPosition.side}` &&
      Date.now() < highlightedPositionUntilRef.current;

    const nextCoordinates = {
      entryY,
      previewY: previewY ?? entryY,
      stopY: stopY ?? entryY,
      takeProfitY: takeProfitY ?? entryY,
      liquidationY,
      // FIX: the overlay wrapper also covers Lightweight Charts' right-hand
      // price scale. Restrict the danger line to the actual pane width so its
      // label can never cover the exchange price marker on that scale.
      liquidationLineWidth: paneWidth,
      paneLeft,
      paneWidth: bracketWidth,
      // FIX: the DOM overlay used to cover the complete chart widget,
      // including Lightweight Charts' time scale. Keeping the real plot-pane
      // height in state lets the wrapper clip TP/SL zones and lines before
      // they can paint over the X-axis labels.
      paneHeight: paneSize.height,
      entryLineWidth,
      ready: true,
      isStopHighlighted,
      isTakeProfitHighlighted,
      isPositionHighlighted,
    };

    setCoordinates((current) => {
      const unchanged =
        current.ready === nextCoordinates.ready &&
        Math.abs(current.entryY - nextCoordinates.entryY) <= 0.25 &&
        Math.abs(current.previewY - nextCoordinates.previewY) <= 0.25 &&
        Math.abs(current.stopY - nextCoordinates.stopY) <= 0.25 &&
        Math.abs(current.takeProfitY - nextCoordinates.takeProfitY) <= 0.25 &&
        (current.liquidationY === nextCoordinates.liquidationY ||
          (current.liquidationY != null &&
            nextCoordinates.liquidationY != null &&
            Math.abs(current.liquidationY - nextCoordinates.liquidationY) <=
              0.25)) &&
        Math.abs(
          current.liquidationLineWidth - nextCoordinates.liquidationLineWidth,
        ) <= 0.25 &&
        Math.abs(current.paneLeft - nextCoordinates.paneLeft) <= 0.25 &&
        Math.abs(current.paneWidth - nextCoordinates.paneWidth) <= 0.25 &&
        Math.abs(current.paneHeight - nextCoordinates.paneHeight) <= 0.25 &&
        Math.abs(current.entryLineWidth - nextCoordinates.entryLineWidth) <= 0.25 &&
        current.isStopHighlighted === nextCoordinates.isStopHighlighted &&
        current.isTakeProfitHighlighted === nextCoordinates.isTakeProfitHighlighted &&
        current.isPositionHighlighted === nextCoordinates.isPositionHighlighted;

      return unchanged ? current : nextCoordinates;
    });
  }, [
    chartWrapRef,
    chartRef,
    candleRef,
    lastDataTimeRef,
    coordTimeToX,
    findBestEntryMarker,
    persistEntryAnchor,
    highlightedOrderIdRef,
    highlightedOrderUntilRef,
    highlightedPositionUntilRef,
    highlightedPositionKeyRef,
    interval,
    symbol,
  ]);

  useEffect(() => {
    return startPacedLoop(recomputeCoordinates);
  }, [recomputeCoordinates]);

  // Force an immediate, synchronous recompute the instant any of these
  // change, instead of waiting for the next RAF tick. This is what
  // eliminates the one-frame "snap to old position, then snap to correct
  // position" glitch when a TP/SL placement is confirmed (dragKind flips
  // to null and optimisticTakeProfit/optimisticStopLoss are set in the
  // same React commit).
  useLayoutEffect(() => {
    recomputeCoordinates();
  }, [
    dragKind,
    optimisticTakeProfit,
    optimisticStopLoss,
    savedStop,
    fullTakeProfitPrice,
    previewPrice,
    zonePad,
    recomputeCoordinates,
  ]);

  const getPriceFromClientY = useCallback(
    (clientY: number): number | null => {
      const wrap = chartWrapRef.current;
      const series = candleRef.current;
      if (!wrap || !series) return null;

      const rect = wrap.getBoundingClientRect();
      const paneHeight = chartRef.current?.paneSize().height ?? rect.height;
      const localY = clamp(clientY - rect.top, 0, Math.max(0, paneHeight - 1));
      const price = series.coordinateToPrice(localY);

      return price != null && Number.isFinite(price) ? price : null;
    },
    [chartWrapRef, chartRef, candleRef],
  );

  const validatePrice = useCallback(
    (kind: DragKind, price: number): string | null => {
      const currentPosition = positionRef.current;
      if (!currentPosition) return "No open position";

      const market =
        marketPriceRef.current ??
        currentPosition.mark_price;
      const liquidation = currentPosition.liquidation_price;

      if (currentPosition.side === "LONG") {
        if (kind === "TAKE_PROFIT" && price <= market) {
          return "LONG full TP must be above current price";
        }
        if (kind === "STOP_LOSS" && price >= market) {
          return "LONG stop loss must be below current price";
        }
        if (
          kind === "STOP_LOSS" &&
          liquidation != null &&
          price <= liquidation
        ) {
          return "LONG stop loss must stay above liquidation price";
        }
      } else {
        if (kind === "TAKE_PROFIT" && price >= market) {
          return "SHORT full TP must be below current price";
        }
        if (kind === "STOP_LOSS" && price <= market) {
          return "SHORT stop loss must be above current price";
        }
        if (
          kind === "STOP_LOSS" &&
          liquidation != null &&
          price >= liquidation
        ) {
          return "SHORT stop loss must stay below liquidation price";
        }
      }

      return null;
    },
    [marketPriceRef],
  );

  const finishDrag = useCallback(async () => {
    const kind = dragKindRef.current;
    const price = previewPriceRef.current;
    const currentPosition = positionRef.current;

    dragKindRef.current = null;
    setDragKind(null);
    setPreviewPrice(null);
    previewPriceRef.current = null;

    if (!kind || price == null || !currentPosition) return;

    const validationError = validatePrice(kind, price);
    if (validationError) {
      setMessage(validationError);
      return;
    }

    setIsSubmitting(true);
    setMessage(null);
    onToast({ kind: "pending", message: "Submitting…" });

    // Show the placement optimistically right away, before the network
    // call resolves - the preview rectangle/line the user just confirmed
    // stays visible (now in a "pending" style) through the round-trip
    // instead of blanking out while waiting on Binance. Reverted in the
    // catch block below if the request actually fails.
    if (kind === "TAKE_PROFIT") {
      setOptimisticTakeProfit(price);
    } else {
      setOptimisticStopLoss(price);
    }

    // Let React paint the confirmed state before starting the network call.
    // This keeps the chart feeling immediate even when the backend is slow.
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => resolve()),
    );

    try {
      if (kind === "TAKE_PROFIT") {
        await executePositionIntent({
          symbol: currentPosition.symbol,
          intent: "REDUCE",
          orderType: "LIMIT",
          price,
          reducePct: 100,
        });

        // Keep optimisticTakeProfit displayed - it's cleared once the real
        // order price arrives via the fullTakeProfitPrice prop (see effect
        // above), which avoids a flicker between "optimistic" and
        // "confirmed" render.
        setMessage(null);
        onToast({
          kind: "success",
          message: `Full TP set @ ${price.toFixed(pricePrecision)}`,
        });

        // The order acknowledgement can arrive slightly before Binance's
        // open-orders snapshot exposes the new limit order. Refresh now and
        // once more after a short propagation delay so the Open Orders panel
        // updates without requiring a page reload. These are user-action-only
        // refreshes, not polling.
        window.dispatchEvent(new Event("orders-state-changed"));
        window.setTimeout(
          () => window.dispatchEvent(new Event("orders-state-changed")),
          350,
        );
        window.setTimeout(
          () => window.dispatchEvent(new Event("orders-state-changed")),
          900,
        );
      } else {
        // This same path handles both a brand-new stop-loss placement
        // (savedStop is null, so there's nothing to cancel) and moving an
        // existing one (savedStop already set - cancel it first, Binance
        // doesn't support amending a conditional order's trigger price in
        // place).
        const oldStop = savedStopRef.current;
        if (oldStop?.algoId) {
          try {
            await cancelConditionalOrder(
              oldStop.symbol,
              oldStop.algoId,
            );
          } catch {
            // Continue: Binance may already have removed/triggered it.
          }
        }

        const closeSide =
          currentPosition.side === "LONG" ? "SELL" : "BUY";
        const response = await placeFullStopLoss({
          symbol: currentPosition.symbol,
          side: closeSide,
          triggerPrice: price,
        });

        const algoId = response.algo.algoId;
        // FIX: this used to be `Number(response.algo.algoId)` - converting
        // the (now correctly string-typed) algoId through JS's Number()
        // would silently reintroduce the exact precision loss this whole
        // fix exists to prevent (see safeJson.ts's big comment). Validate
        // it's a well-formed positive integer string without ever
        // actually converting it to a number for storage.
        if (
          typeof algoId !== "string" ||
          !/^\d+$/.test(algoId) ||
          algoId === "0"
        ) {
          throw new Error("Binance did not return a valid stop-loss algo id");
        }

        const nextStop: SavedStop = {
          symbol: currentPosition.symbol.toUpperCase(),
          side: closeSide,
          triggerPrice: response.trigger_price,
          algoId,
        };

        setSavedStop(nextStop);
        // FIX: this used to be `saveStop(nextStop)` with no symbol
        // argument. With `stop` truthy this happened to still work
        // (the implementation keys off `stop.symbol`, not the missing
        // param), but stopLoss.ts's `symbol` is now a required
        // parameter, so every call site passes it explicitly rather
        // than relying on implementation details to paper over it.
        saveStop(nextStop, symbol);
        // savedStop now covers this price directly - no need to keep the
        // optimistic placeholder around.
        setOptimisticStopLoss(null);
        setMessage(null);
        onToast({
          kind: "success",
          message: `Stop loss set @ ${response.trigger_price.toFixed(pricePrecision)}`,
        });
      }

      window.dispatchEvent(new Event("trading-state-changed"));
    } catch (error) {
      // Revert: the submission failed, so nothing was actually placed (or
      // in the "move" case, the previous stop loss may have been
      // cancelled but the replacement failed - savedStop/localStorage
      // still reflects whatever was last confirmed, and a fresh
      // refreshPosition/openOrders cycle will reconcile it).
      setOptimisticTakeProfit(null);
      setOptimisticStopLoss(null);

      setMessage(null);

      const rawMessage =
        error instanceof Error
          ? error.message
          : "Unable to create protection order";
      /*
       * Same translation as useDrawingCanvas.ts's reprice-reduce catch -
       * see the comment there for the full explanation. Binance rejects
       * a reduce-only TP/SL that sits beyond other pending same-side
       * orders it would have to pass through first, since those filling
       * first could leave the position flat/flipped before this order's
       * price is ever reached. A genuine exchange constraint, not a bug.
       */
      const reduceOnlyBlocked =
        rawMessage.includes("-2022") ||
        rawMessage.toLowerCase().includes("reduceonly order is rejected");

      onToast({
        kind: "error",
        message: reduceOnlyBlocked
          ? "Can't rest this order there - other pending orders on the same side would need to fill first, which could exceed your position size before this price is reached. Move it closer, or cancel/reduce those orders."
          : rawMessage,
      });
    } finally {
      setIsSubmitting(false);
    }
  }, [validatePrice, pricePrecision, symbol]);

  // Explicit cancel path for the click-move-click placement flow below.
  // Since nothing is ever held down during a placement anymore, there's
  // no "just let go" gesture to abort with - Escape and right-click both
  // back out of an in-progress TP/SL placement without submitting
  // anything, restoring things to how they were before the first click.
  const cancelDrag = useCallback(() => {
    dragKindRef.current = null;
    setDragKind(null);
    setPreviewPrice(null);
    previewPriceRef.current = null;
    setMessage(null);
  }, []);

  useEffect(() => {
    if (!dragKind) return;

    const handlePointerMove = (event: PointerEvent) => {
      const rawPrice = getPriceFromClientY(event.clientY);
      if (rawPrice == null) return;

      const currentPosition = positionRef.current;
      const kind = dragKindRef.current;
      let nextPrice = rawPrice;

      // Hard-clamp the preview to the correct side of the current market
      // price while it's being placed, instead of letting it cross over
      // and only complaining once confirmed. A LONG's take profit (or a
      // SHORT's stop loss) simply can't be dragged below market, and
      // vice versa - it just stops following the cursor past that line,
      // same as this app already does for a plain reduce order line.
      if (currentPosition && kind) {
        const market = marketPriceRef.current ?? currentPosition.mark_price;
        const liquidation = currentPosition.liquidation_price;
        const boundaryEpsilon = priceBoundaryEpsilon(pricePrecision);

        // FEATURE: while moving/creating a stop loss, snap it exactly onto the
        // entry line when the pointer is close. The snap is recalculated on
        // every move (rather than stored as a locked mode), so an SL placed at
        // break-even can later be grabbed and moved back to any other valid
        // price. Round to the exchange-derived display precision before
        // submission so weighted-average entry prices do not leak unsupported
        // floating-point decimals into Binance's trigger_price.
        if (kind === "STOP_LOSS") {
          const series = candleRef.current;
          const entryY = series?.priceToCoordinate(currentPosition.entry_price);
          const wrap = chartWrapRef.current;

          if (entryY != null && wrap) {
            const pointerY = event.clientY - wrap.getBoundingClientRect().top;
            if (Math.abs(pointerY - entryY) <= BREAK_EVEN_SNAP_THRESHOLD_PX) {
              nextPrice = Number(
                currentPosition.entry_price.toFixed(pricePrecision),
              );
            }
          }
        }

        if (currentPosition.side === "LONG") {
          nextPrice =
            kind === "TAKE_PROFIT"
              ? Math.max(nextPrice, market + boundaryEpsilon)
              : Math.min(nextPrice, market - boundaryEpsilon);

          // FEATURE: a LONG stop below liquidation cannot protect the trade.
          // Clamp the preview one visible price increment above liquidation
          // so the cursor physically cannot cross the danger boundary.
          if (kind === "STOP_LOSS" && liquidation != null) {
            nextPrice = Math.max(nextPrice, liquidation + boundaryEpsilon);
          }
        } else {
          nextPrice =
            kind === "TAKE_PROFIT"
              ? Math.min(nextPrice, market - boundaryEpsilon)
              : Math.max(nextPrice, market + boundaryEpsilon);

          // FEATURE: SHORT liquidation sits above market, so its stop is
          // clamped one visible increment below that boundary instead.
          if (kind === "STOP_LOSS" && liquidation != null) {
            nextPrice = Math.min(nextPrice, liquidation - boundaryEpsilon);
          }
        }
      }

      previewPriceRef.current = nextPrice;
      setPreviewPrice(nextPrice);
      setMessage(validatePrice(dragKindRef.current!, nextPrice));
    };

    /*
     * Click-move-click placement, not press-and-hold-drag:
     *
     *   1. The user clicks TP FULL / STOP LOSS (or grabs the existing
     *      stop-loss line) - that pointerdown is what set dragKind and
     *      ran BEFORE this effect exists, so it's never seen here.
     *   2. The mouse is now free to move without any button held; the
     *      preview line/zone above tracks it via handlePointerMove.
     *   3. The *next* left click anywhere confirms the current preview price
     *      and submits the order. The listener stays installed until the
     *      placement finishes/cancels so unrelated mouse buttons cannot
     *      accidentally consume the confirmation path.
     *
     * Escape or a right-click cancels instead of confirming.
     */
    const handleConfirmClick = (event: PointerEvent) => {
      // FIX: a right-click used to consume the one-shot pointerdown listener
      // without confirming or cancelling the TP/SL placement. If the chart's
      // context-menu handler then stopped the later `contextmenu` event, the
      // placement stayed active but had no left-click listener anymore, so it
      // looked frozen until Escape/refresh. Cancel immediately on the secondary
      // pointerdown instead, while leaving the event untouched so the normal
      // chart context menu can still open.
      if (event.button === 2) {
        cancelDrag();
        return;
      }

      if (event.button !== 0) return;

      // FIX: TP/SL confirmation owns this pointerdown exclusively. This
      // listener runs on window in capture phase (before the chart wrapper's
      // drawing hit-test), then stops the event so a trendline, chart pan, or
      // trade control underneath the cursor cannot consume the same click and
      // move/select/execute accidentally while the stop is being trailed.
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      void finishDrag();
    };

    const handleCancelKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      cancelDrag();
    };

    const handleCancelContextMenu = (_event: MouseEvent) => {
      // FIX: keep `contextmenu` as a fallback cancellation path, but do not
      // prevent its default behavior here. Right-click is meant to both abort
      // TP/SL placement and continue into the app/browser context menu.
      cancelDrag();
    };

    window.addEventListener("pointermove", handlePointerMove);
    // FIX: do not use `once` here. A non-left pointerdown (especially the
    // right-click that opens the chart context menu) must never silently
    // remove the future left-click confirmation handler. The effect cleanup
    // removes this listener as soon as finishDrag/cancelDrag clears dragKind.
    window.addEventListener("pointerdown", handleConfirmClick, {
      capture: true,
    });
    window.addEventListener("keydown", handleCancelKey);
    window.addEventListener("contextmenu", handleCancelContextMenu);

    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerdown", handleConfirmClick, true);
      window.removeEventListener("keydown", handleCancelKey);
      window.removeEventListener("contextmenu", handleCancelContextMenu);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    dragKind,
    finishDrag,
    cancelDrag,
    getPriceFromClientY,
    validatePrice,
    pricePrecision,
  ]);

  /**
   * The X next to the TP FULL / STOP LOSS buttons - a shortcut to the
   * exact same market-close action as PositionsPanel's own "Market"
   * button (closePositionMarket under the hood), just reachable right
   * from the entry line instead of needing to open the Positions panel
   * first. Deliberately not wired through usePositions' own closeMarket
   * (that hook owns a whole live-polling positions list this component
   * doesn't need a second copy of) - calls the same underlying API
   * function directly instead.
   */
  const closePositionNow = async () => {
    if (isClosingPosition || !position) return;

    setIsClosingPosition(true);
    onToast({ kind: "pending", message: "Closing position…" });

    try {
      const result = await closePositionMarket(symbol);
      const avgPrice = Number(result?.order?.avgPrice);

      // See suppressReviveUntilRef's own comment above - this stops any
      // poll landing in the next few seconds from reviving the position
      // we just successfully closed, before Binance's own account data
      // has caught up to reflect it.
      suppressReviveUntilRef.current = Date.now() + 5_000;
      // FIX: HIDE is a preference for the position that was just closed, not
      // for every future trade on this symbol. Restore the shared chart/panel
      // controls immediately so a quickly reopened position cannot inherit
      // the old trade's hidden TP/SL state before the next account poll runs.
      if (!areTpSlControlsVisible(symbol)) {
        setTpSlControlsVisible(symbol, true);
      }
      setIsCloseConfirmationVisible(false);
      setPosition(null);
      onPositionClosed(
        result.side,
        symbol,
        Number.isFinite(avgPrice) && avgPrice > 0 ? avgPrice : undefined,
      );

      onToast({ kind: "success", message: "Position closed" });

      // FIX: this only ever dispatched "trading-state-changed", which
      // useOpenOrders.ts listens for - but usePositions.ts (the hook
      // behind PositionsPanel's own Positions table) listens for
      // "account-state-changed" specifically, a different event. So the
      // Positions table kept showing this position with its old data
      // for however long its own multi-second self-heal poll took to
      // notice on its own, instead of refreshing right away. Dispatching
      // both covers whichever hook is listening for which.
      window.dispatchEvent(new Event("account-state-changed"));
      window.dispatchEvent(new Event("trading-state-changed"));
    } catch (error) {
      onToast({
        kind: "error",
        message:
          error instanceof Error ? error.message : "Unable to close position",
      });
    } finally {
      setIsClosingPosition(false);
    }
  };

  const handleEntryControlsMovePointerDown = (
    event: ReactPointerEvent<HTMLButtonElement>,
  ) => {
    if (isSubmitting || dragKind !== null) return;

    event.preventDefault();
    event.stopPropagation();

    if (isEntryControlsMoving) {
      // FIX: exactly like the candle timer move arrow, pressing this arrow a
      // second time drops the action row immediately instead of starting a new
      // placement cycle.
      setIsEntryControlsMoving(false);
      return;
    }

    const wrap = chartWrapRef.current;
    const controls = entryControlsRef.current;
    if (wrap === null || controls === null) return;

    const controlsRect = controls.getBoundingClientRect();
    entryControlsGrabOffsetRef.current = {
      x: event.clientX - controlsRect.left,
      y: event.clientY - controlsRect.top,
    };

    // FEATURE: clicking the arrow is both the unlock and pick-up action, so
    // the HIDE / TP FULL / STOP LOSS / X row starts following the pointer
    // immediately without requiring another click on the controls themselves.
    setIsEntryControlsMoving(true);
  };

  useEffect(() => {
    if (!isEntryControlsMoving) return;

    const handlePointerMove = (event: PointerEvent) => {
      const wrap = chartWrapRef.current;
      if (wrap === null) return;

      const rect = wrap.getBoundingClientRect();
      const desiredLeft =
        event.clientX - rect.left - entryControlsGrabOffsetRef.current.x;
      const desiredTop =
        event.clientY - rect.top - entryControlsGrabOffsetRef.current.y;

      /*
       * FEATURE: keep the position controls close to their entry-line anchor,
       * mirroring the candle timer's constrained movement. This gives enough
       * room to clear candles/labels without letting trade actions get lost
       * elsewhere on the chart.
       */
      setEntryControlsOffset({
        x: Math.max(-120, Math.min(120, Math.round(desiredLeft - coordinates.paneLeft))),
        y: Math.max(
          -80,
          Math.min(80, Math.round(desiredTop - (coordinates.entryY - 11))),
        ),
      });
    };

    const handlePlacementPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest(".position-entry-controls-move-button")
      ) {
        return;
      }

      // FIX: the first click after picking the row up is reserved for dropping
      // it. Consuming the event prevents an accidental TP/SL/close/chart action
      // from firing underneath the placement click.
      event.preventDefault();
      event.stopPropagation();
      setIsEntryControlsMoving(false);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerdown", handlePlacementPointerDown, true);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerdown", handlePlacementPointerDown, true);
    };
  }, [
    chartWrapRef,
    coordinates.entryY,
    coordinates.paneLeft,
    isEntryControlsMoving,
  ]);

  const beginDrag = (
    event: ReactPointerEvent<HTMLElement>,
    kind: DragKind,
    initialPrice?: number,
  ) => {
    if (isSubmitting || !position) return;

    // Already armed - this button shouldn't normally still be under the
    // cursor (it stays in a fixed spot on the entry line), but guard it
    // anyway rather than restarting the placement.
    if (dragKindRef.current) return;

    event.preventDefault();
    event.stopPropagation();

    dragKindRef.current = kind;
    setDragKind(kind);
    setMessage(null);

    // FEATURE: Draft TP/SL lines begin at their visible 0.5% boundary rather than
    // snapping back to entry on the first click. Existing callers can still omit
    // the seed and retain the historical entry-price behavior.
    const seedPrice = initialPrice ?? position.entry_price;
    previewPriceRef.current = seedPrice;
    setPreviewPrice(seedPrice);
  };

  // Grabbing the already-placed stop-loss line/badge itself, instead of
  // the STOP LOSS button on the entry row. Starts the same click-move-
  // click flow as beginDrag, but seeded from the stop's current price
  // instead of entry price, so the line doesn't jump before you've moved
  // the mouse.
  const beginMoveStop = (event: ReactPointerEvent<HTMLElement>) => {
    if (isSubmitting || !position || displayedStopPrice == null) return;

    // FEATURE: The same red boundary is now usable before an SL exists and
    // after one exists. A draft click creates the first STOP_MARKET order; a
    // confirmed-stop click reuses the existing cancel-and-replace move flow.
    beginDrag(event, "STOP_LOSS", displayedStopPrice);
  };

  const beginMoveTakeProfitDraft = (event: ReactPointerEvent<HTMLElement>) => {
    if (
      isSubmitting ||
      !position ||
      !isTakeProfitDraft ||
      displayedTakeProfitPrice == null
    ) {
      return;
    }

    // FEATURE: TP starts as a green planning boundary. Its first confirmed move
    // submits the real 100%-reduce LIMIT order; after Binance exposes that order,
    // the existing yellow open-order drawing becomes the authoritative TP line.
    beginDrag(event, "TAKE_PROFIT", displayedTakeProfitPrice);
  };

  const cancelStop = async (
    event: ReactPointerEvent<HTMLButtonElement>,
  ) => {
    event.preventDefault();
    event.stopPropagation();

    const stop = savedStopRef.current;
    if (!stop || isSubmitting) return;

    setIsSubmitting(true);
    setMessage(null);
    onToast({ kind: "pending", message: "Submitting…" });

    // Let React paint the released drag state before starting the network call.
    // This keeps the chart feeling immediate even when the backend is slow.
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => resolve()),
    );

    try {
      await cancelConditionalOrder(stop.symbol, stop.algoId);
      setSavedStop(null);
      saveStop(null, symbol);
      setMessage(null);
      onToast({ kind: "success", message: "Stop loss cancelled" });
      window.dispatchEvent(new Event("trading-state-changed"));
    } catch (error) {
      setMessage(null);
      onToast({
        kind: "error",
        message:
          error instanceof Error ? error.message : "Unable to cancel stop loss",
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  // --- Zone edge (width) resize handle ----------------------------------
  // Purely horizontal: only ever mutates zonePad.rightSeconds. Pixel movement
  // is translated through the CURRENT bar spacing + timeframe duration into
  // elapsed seconds, so a manually chosen right edge survives both zoom and
  // later timeframe changes without being reinterpreted as a different time.
  // entryY/stopY/takeProfitY are derived from price alone and are never
  // touched by this. Only the right edge is
  // resizable - the left edge is permanently pinned to the entry anchor
  // (see ZonePad/EdgeDragKind above), so there's nothing to arm there.
  // Same click-move-click flow as TP/SL placement above, for
  // consistency: the first click arms the handle, the zone edge tracks
  // the mouse with nothing held down, and the next click anywhere
  // confirms the new width. Escape or a right-click cancels back to the
  // width it had before this handle was grabbed.
  const beginEdgeDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!position) return;

    // While the handle is already armed, its own position keeps tracking
    // the mouse every frame (that's how the moving preview works) - so
    // the confirm click almost always lands right back on top of this
    // same element. Without this guard, that click's pointerdown would
    // re-run beginEdgeDrag and call stopPropagation() below, which stops
    // the event from ever reaching the window-level listener that was
    // supposed to confirm the resize - it would look like the edge got
    // permanently stuck to the cursor, re-arming forever instead of ever
    // finishing. Bailing out here (without stopPropagation) lets that
    // click bubble up to the confirm listener normally instead.
    if (edgeDragRef.current) return;

    event.preventDefault();
    event.stopPropagation();

    edgeDragRef.current = "ZONE_RIGHT";
    setEdgeDrag("ZONE_RIGHT");
    const barSpacing = Math.max(
      0.01,
      chartRef.current?.timeScale().options().barSpacing ?? 1,
    );
    const currentIntervalSeconds = intervalSeconds[interval];
    const padSeconds =
      zonePadRef.current.rightSeconds ??
      (DEFAULT_ZONE_RIGHT_PAD_PX / barSpacing) * currentIntervalSeconds;

    edgeDragStartRef.current = {
      pointerX: event.clientX,
      padSeconds,
      barSpacing,
      intervalSeconds: currentIntervalSeconds,
    };
  };

  const cancelEdgeDrag = useCallback(() => {
    const start = edgeDragStartRef.current;

    if (start) {
      setZonePad((current) => ({
        ...current,
        rightSeconds: start.padSeconds,
      }));
    }

    edgeDragRef.current = null;
    edgeDragStartRef.current = null;
    setEdgeDrag(null);
  }, []);

  useEffect(() => {
    if (!edgeDrag) return;

    const handleMove = (event: PointerEvent) => {
      const start = edgeDragStartRef.current;
      if (!start) return;

      const deltaPixels = event.clientX - start.pointerX;
      const deltaBars = deltaPixels / start.barSpacing;
      const deltaSeconds = deltaBars * start.intervalSeconds;
      const nextPadSeconds = Math.max(0, start.padSeconds + deltaSeconds);

      // FIX: keep the ref in sync in the same pointermove tick. The confirm
      // click can arrive before React commits the state update, and persistence
      // must store the final cursor position rather than the previous frame.
      const nextPad = {
        ...zonePadRef.current,
        rightSeconds: nextPadSeconds,
      };
      zonePadRef.current = nextPad;
      setZonePad(nextPad);
    };

    const handleConfirmClick = (event: PointerEvent) => {
      if (event.button !== 0) return;

      // FIX: persist the manually chosen width when click-move-click finishes.
      // The width is stored as elapsed seconds and tied to the position's saved
      // entry anchor, so reloads preserve the same real right-edge time without
      // leaking that geometry into a future trade on the same symbol.
      if (positionRef.current) {
        savePositionZonePad(
          symbol,
          positionRef.current.side,
          entryAnchorTimeRef.current,
          zonePadRef.current.rightSeconds,
        );
      }

      edgeDragRef.current = null;
      edgeDragStartRef.current = null;
      setEdgeDrag(null);
    };

    const handleCancelKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      cancelEdgeDrag();
    };

    const handleCancelContextMenu = (event: MouseEvent) => {
      event.preventDefault();
      cancelEdgeDrag();
    };

    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerdown", handleConfirmClick, {
      once: true,
    });
    window.addEventListener("keydown", handleCancelKey);
    window.addEventListener("contextmenu", handleCancelContextMenu);

    return () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerdown", handleConfirmClick);
      window.removeEventListener("keydown", handleCancelKey);
      window.removeEventListener("contextmenu", handleCancelContextMenu);
    };
  }, [edgeDrag, cancelEdgeDrag, symbol]);

  const preview = useMemo(() => {
    if (!position || !dragKind || previewPrice == null) return null;

    const top = Math.min(coordinates.entryY, coordinates.previewY);
    const height = Math.abs(coordinates.previewY - coordinates.entryY);
    const distancePct =
      position.entry_price > 0
        ? ((previewPrice - position.entry_price) /
            position.entry_price) *
          100
        : 0;

    return {
      top,
      height,
      // FIX: keep the live label attached to the actual dragged price line.
      // The old fixed `top: 5px` placed it at the zone's upper edge, so a
      // stop below entry appeared to jump all the way up when move mode began
      // even though its numeric price had not changed.
      labelTop: coordinates.previewY - top,
      distancePct,
      valid: validatePrice(dragKind, previewPrice) == null,
    };
  }, [
    position,
    dragKind,
    previewPrice,
    coordinates.entryY,
    coordinates.previewY,
    validatePrice,
  ]);

  // FEATURE: R is always normalized against the current SL distance. The SL
  // rectangle itself is therefore -1R by definition, while TP expands/contracts
  // live as either boundary is moved. During an active move we use previewPrice
  // so the number changes under the cursor before the backend request is sent.
  const rStopPrice =
    dragKind === "STOP_LOSS" && previewPrice != null
      ? previewPrice
      : displayedStopPrice;
  const rTakeProfitPrice =
    dragKind === "TAKE_PROFIT" && previewPrice != null
      ? previewPrice
      : displayedTakeProfitPrice;
  const riskDistance =
    position != null && rStopPrice != null
      ? Math.abs(position.entry_price - rStopPrice)
      : 0;
  const takeProfitR =
    position != null &&
    rTakeProfitPrice != null &&
    riskDistance > priceBoundaryEpsilon(pricePrecision)
      ? Math.abs(rTakeProfitPrice - position.entry_price) / riskDistance
      : null;
  const takeProfitRLabel = formatRMultiple(takeProfitR);

  // FEATURE: a stop-loss that has crossed the entry into locked-in profit is
  // no longer pure downside risk. Mark that SL zone separately so the chart can
  // render it with a neutral/profit-protection color between the normal red SL
  // and green TP themes (LONG: stop > entry, SHORT: stop < entry).
  const isStopProtectingProfit =
    position != null &&
    displayedStopPrice != null &&
    (position.side === "LONG"
      ? displayedStopPrice > position.entry_price
      : displayedStopPrice < position.entry_price);

  // FIX: when the saved stop-loss line is close to entry, push its badge/X
  // AWAY from the entry controls instead of always pushing them downward.
  // A profitable LONG stop sits above entry, so the old `controls-below`
  // behavior moved `SL FULL · price` directly into HIDE/TP/X at some zoom
  // levels. Stops above entry now move their controls above the SL line;
  // stops below entry move them below it.
  const stopControlsNearEntry =
    coordinates.ready &&
    displayedStopPrice != null &&
    Math.abs(coordinates.stopY - coordinates.entryY) <
      STOP_LABEL_COLLISION_THRESHOLD_PX;
  const stopControlsAbove =
    stopControlsNearEntry && coordinates.stopY < coordinates.entryY;
  const stopControlsBelow =
    stopControlsNearEntry && coordinates.stopY >= coordinates.entryY;

  // Hide the confirmed/optimistic/draft zone and stop-line while that same kind
  // is actively being placed - the live preview below already shows the
  // in-progress position, so showing both at once would just be two
  // overlapping rectangles/lines for the same bracket.
  const showTakeProfitZone =
    displayedTakeProfitPrice != null && dragKind !== "TAKE_PROFIT";
  const showStopZone = displayedStopPrice != null && dragKind !== "STOP_LOSS";
  const showStopLine = displayedStopPrice != null && dragKind !== "STOP_LOSS";
  const showTakeProfitDraftLine =
    isTakeProfitDraft &&
    displayedTakeProfitPrice != null &&
    dragKind !== "TAKE_PROFIT";

  // FEATURE: TP FULL / STOP LOSS no longer live as creation buttons on the
  // entry line. Missing orders are represented by their 0.5% draft boundaries,
  // while the entry row retains only position-level actions (HIDE / quick close).
  const hasDraftProtection = isTakeProfitDraft || isStopDraft;

  // Edge handles are only meaningful once at least one zone actually has
  // width to resize.
  const showEdgeHandles =
    coordinates.ready && (showTakeProfitZone || showStopZone);

  const edgeHandleBounds = useMemo(() => {
    if (!showEdgeHandles) return null;

    const ys = [coordinates.entryY];
    if (showTakeProfitZone) ys.push(coordinates.takeProfitY);
    if (showStopZone) ys.push(coordinates.stopY);

    const top = Math.min(...ys);
    const bottom = Math.max(...ys);

    return { top, height: Math.max(2, bottom - top) };
  }, [
    showEdgeHandles,
    showTakeProfitZone,
    showStopZone,
    coordinates.entryY,
    coordinates.takeProfitY,
    coordinates.stopY,
  ]);

  if (!position || !coordinates.ready) return null;

  return (
    <div
      className="position-bracket-overlay"
      aria-hidden="false"
      /* FIX: clip the DOM TP/SL overlay to Lightweight Charts' actual plot
          pane, not the full chart wrapper. The wrapper also contains the
          right price scale, so wide SL lines/badges used to paint over the
          native price labels on that scale. */
      style={{
        width: coordinates.liquidationLineWidth,
        height: coordinates.paneHeight,
      }}
    >
      {/* FEATURE: liquidation is an account-risk boundary rather than a
          movable order, so it spans the whole chart and has no pointer
          handler. This whole overlay unmounts when the position closes. */}
      {coordinates.liquidationY != null &&
        position.liquidation_price != null && (
          <div
            className="position-liquidation-line"
            style={{
              top: coordinates.liquidationY,
              width: coordinates.liquidationLineWidth,
            }}
          >
            <span>
              LIQUIDATION · {position.liquidation_price.toFixed(pricePrecision)}
            </span>
          </div>
        )}

      {showTakeProfitZone && (
        <div
          className={`position-bracket-zone profit persistent ${
            isTakeProfitDraft ? "draft" : ""
          } ${isTakeProfitPending ? "pending" : ""} ${
            coordinates.isTakeProfitHighlighted ||
            coordinates.isPositionHighlighted
              ? "highlighted"
              : ""
          }`}
          style={{
            left: coordinates.paneLeft,
            top: Math.min(coordinates.entryY, coordinates.takeProfitY),
            height: Math.max(
              2,
              Math.abs(coordinates.takeProfitY - coordinates.entryY),
            ),
            width: coordinates.paneWidth,
          }}
        >
          <div className="position-bracket-r-multiple">{takeProfitRLabel}</div>
        </div>
      )}

      {showStopZone && (
        <div
          className={`position-bracket-zone loss persistent ${
            isStopDraft ? "draft" : ""
          } ${isStopProtectingProfit ? "profit-protected" : ""} ${
            isStopPending ? "pending" : ""
          } ${
            coordinates.isStopHighlighted || coordinates.isPositionHighlighted
              ? "highlighted"
              : ""
          }`}
          style={{
            left: coordinates.paneLeft,
            top: Math.min(coordinates.entryY, coordinates.stopY),
            height: Math.max(
              2,
              Math.abs(coordinates.stopY - coordinates.entryY),
            ),
            width: coordinates.paneWidth,
          }}
        >
          <div className="position-bracket-r-multiple">-1R</div>
        </div>
      )}

      {preview && (
        <div
          className={`position-bracket-zone ${
            dragKind === "TAKE_PROFIT" ? "profit" : "loss"
          } ${
            // FEATURE: mirror the saved-zone profit-protection color while the
            // stop is being positioned, so the user sees the state before commit.
            dragKind === "STOP_LOSS" &&
            position &&
            previewPrice != null &&
            (position.side === "LONG"
              ? previewPrice > position.entry_price
              : previewPrice < position.entry_price)
              ? "profit-protected"
              : ""
          }`}
          style={{
            left: coordinates.paneLeft,
            top: preview.top,
            height: Math.max(2, preview.height),
            width: coordinates.paneWidth,
          }}
        >
          <span style={{ top: preview.labelTop - 11 }}>
            {dragKind === "TAKE_PROFIT" ? "FULL TP" : "STOP LOSS"}{" "}
            {previewPrice?.toFixed(pricePrecision)} ·{" "}
            {Math.abs(preview.distancePct).toFixed(2)}%
          </span>
          <div className="position-bracket-r-multiple">
            {dragKind === "TAKE_PROFIT" ? takeProfitRLabel : "-1R"}
          </div>
        </div>
      )}

      {showTakeProfitDraftLine && (
        <div
          className="position-take-profit-line draft"
          style={{
            left: coordinates.paneLeft,
            top: coordinates.takeProfitY,
            width: coordinates.paneWidth,
          }}
        >
          <div
            className="position-take-profit-grab"
            onPointerDown={beginMoveTakeProfitDraft}
            title="Click, move the mouse, then click again to place full take profit"
          />
          <span
            onPointerDown={beginMoveTakeProfitDraft}
            title="Click, move the mouse, then click again to place full take profit"
          >
            TP FULL · {displayedTakeProfitPrice.toFixed(pricePrecision)}
          </span>
        </div>
      )}

      {/* FIX: Hide the dashed entry line together with the TP/SL controls.
          Previously only the buttons were gated by areEntryControlsVisible,
          which left a stray dashed horizontal line on an otherwise-clean chart. */}
      {areEntryControlsVisible && (
        <div
          className={`position-entry-line ${
            coordinates.isPositionHighlighted ? "highlighted" : ""
          }`}
          style={{
            left: coordinates.paneLeft,
            top: coordinates.entryY,
            width: coordinates.entryLineWidth,
          }}
        >
          {hasDraftProtection && (
            <div
              ref={entryControlsRef}
              className={`position-entry-controls ${
                isEntryControlsMoving ? "moving" : ""
              }`}
              style={{
                transform: `translate(${entryControlsOffset.x}px, ${entryControlsOffset.y}px)`,
              }}
            >
              <div className="position-bracket-handles">
                {/* FEATURE: The chart itself only exposes HIDE. Once hidden, no
                    SHOW control remains on-chart; restoring these controls is
                    intentionally done from the Positions panel so long-held
                    positions can keep the chart completely clean. */}
                <button
                  className="position-bracket-visibility-toggle"
                  disabled={isSubmitting || dragKind !== null}
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    setTpSlControlsVisible(symbol, false);
                  }}
                  title="Hide TP/SL and quick-close controls for this position"
                >
                  HIDE
                </button>

                {position &&
                  (isCloseConfirmationVisible ? (
                    <div
                      className="position-bracket-close-confirmation"
                      role="group"
                      aria-label="Confirm market close"
                    >
                      <button
                        className="position-bracket-close-choice confirm"
                        disabled={isClosingPosition}
                        onClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          void closePositionNow();
                        }}
                        title="Yes, close this position at market"
                      >
                        {isClosingPosition ? "…" : "YES"}
                      </button>
                      <button
                        className="position-bracket-close-choice cancel"
                        disabled={isClosingPosition}
                        onClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          setIsCloseConfirmationVisible(false);
                        }}
                        title="No, keep this position open"
                      >
                        NO
                      </button>
                    </div>
                  ) : (
                    <button
                      className="position-bracket-close"
                      disabled={isClosingPosition}
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        setIsCloseConfirmationVisible(true);
                      }}
                      title="Close this position at market"
                    >
                      ×
                    </button>
                  ))}

                {/* FEATURE: Keep the move affordance at the far-right edge of
                    the action row. Placing it after the destructive close
                    control makes the stable order HIDE → X → MOVE and keeps
                    the arrow from visually leading the primary actions. */}
                <button
                  type="button"
                  className={`position-entry-controls-move-button ${
                    isEntryControlsMoving ? "active" : ""
                  }`}
                  disabled={isSubmitting || dragKind !== null}
                  aria-pressed={isEntryControlsMoving}
                  onPointerDown={handleEntryControlsMovePointerDown}
                  title={
                    isEntryControlsMoving
                      ? "Place position controls"
                      : "Move position controls"
                  }
                >
                  ↗
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {showStopLine && (
        <div
          className={`position-stop-line ${isStopDraft ? "draft" : ""} ${
            stopControlsAbove
              ? "controls-above"
              : stopControlsBelow
                ? "controls-below"
                : ""
          } ${isStopPending ? "pending" : ""} ${
            savedStop ? "draggable" : ""
          } ${
            coordinates.isStopHighlighted || coordinates.isPositionHighlighted
              ? "highlighted"
              : ""
          }`}
          style={{
            left: coordinates.paneLeft,
            top: coordinates.stopY,
            width: coordinates.paneWidth,
          }}
        >
          {(savedStop || isStopDraft) && !isSubmitting && (
            <div
              className="position-stop-grab"
              onPointerDown={beginMoveStop}
              title={
                savedStop
                  ? "Click, move the mouse, then click again to move the stop loss"
                  : "Click, move the mouse, then click again to place stop loss"
              }
            />
          )}

          {/* FEATURE: the visible SL badge is now the primary move handle.
              Previously only the thin invisible strip across the price line
              was interactive, so clicking the obvious "SL FULL · price"
              control did nothing. Both targets start the same cancel-and-
              replace flow, and the adjacent X remains cancel-only. */}
          <span
            className={
              (savedStop || isStopDraft) && !isSubmitting
                ? "move-handle"
                : undefined
            }
            onPointerDown={
              (savedStop || isStopDraft) && !isSubmitting
                ? beginMoveStop
                : undefined
            }
            title={
              savedStop
                ? "Click, move the mouse, then click again to move the stop loss"
                : isStopDraft
                  ? "Click, move the mouse, then click again to place stop loss"
                  : undefined
            }
          >
            SL FULL · {displayedStopPrice.toFixed(pricePrecision)}
          </span>

          {savedStop && (
            <button
              disabled={isSubmitting}
              onPointerDown={cancelStop}
              title="Cancel stop loss"
            >
              ×
            </button>
          )}
        </div>
      )}

      {showEdgeHandles && edgeHandleBounds && (
        <div
          className={`position-bracket-edge-handle right ${
            edgeDrag === "ZONE_RIGHT" ? "active" : ""
          }`}
          style={{
            left:
              coordinates.paneLeft +
              coordinates.paneWidth -
              ZONE_EDGE_HANDLE_WIDTH_PX / 2,
            top: edgeHandleBounds.top,
            height: edgeHandleBounds.height,
          }}
          onPointerDown={beginEdgeDrag}
          title="Click, move the mouse, then click again to resize the zone"
        />
      )}

      {message && (
        <div
          className={`position-bracket-message ${
            message.toLowerCase().includes("must") ||
            message.toLowerCase().includes("unable") ||
            message.toLowerCase().includes("error")
              ? "error"
              : ""
          }`}
        >
          {message}
        </div>
      )}
    </div>
  );
}
