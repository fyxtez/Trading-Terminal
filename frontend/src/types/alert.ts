/**
 * The price-action context this alert is flagging, e.g. "this is where
 * I expect a breakout" - picked from a small fixed menu (see
 * AlertLinesOverlay.tsx's pattern button/popover). "none" is the
 * default and means no extra text gets added to the notification (see
 * sendPriceAlertNotification in utils/alerts.ts) - purely a label, same
 * as `side` below, it never affects the alert's price or firing.
 */
export type AlertPattern =
  | "none"
  | "breakout"
  | "breakdown"
  | "support"
  | "resistance"
  | "retest"
  | "sweep";

/**
 * A price level the user wants to be notified about via a right-click
 * "Create alert" on the chart (see ContextMenu.tsx / usePriceAlerts.ts).
 *
 * There is deliberately no backend concept of an alert - see the long
 * comment above sendPriceAlertNotification in utils/alerts.ts for why
 * this fires straight to ntfy.sh from the browser instead of round
 * tripping through a server that doesn't otherwise need to exist.
 */
export type PriceAlert = {
  id: string;
  price: number;
  createdAt: number;
  /**
   * Which setup this alert is flagging - determined automatically at
   * creation time from whether the alert's price sits below ("LONG") or
   * above ("SHORT") the market price at that moment (see addAlert in
   * usePriceAlerts.ts), and freely flippable afterwards by clicking the
   * LONG/SHORT button on the line itself (see AlertLinesOverlay.tsx).
   * Purely a label for the notification/line - it doesn't place or
   * affect any real order.
   */
  side: "LONG" | "SHORT";
  /** See AlertPattern above. Defaults to "none". */
  pattern: AlertPattern;
  /**
   * FEATURE: optional user-written context shown in the alert-line editor and
   * appended to the notification only when it contains non-whitespace text.
   */
  additionalInfo: string;
  /** Prevents every alert interaction except unlocking it. */
  locked: boolean;
  /** Dims the entire alert line and label without disabling the alert. */
  hidden: boolean;
};

/**
 * Undo/redo entry for price alerts (see usePriceAlerts.ts's undo/redo
 * and useHotkeys.ts's Ctrl+Z/Ctrl+Y handling) - same shape and same
 * shared `seq` numbering as drawing/types/drawing.ts's HistoryAction,
 * so the two independent undo stacks (alerts and drawings) can be
 * compared and interleaved correctly by whichever action actually
 * happened most recently, rather than one always taking priority.
 */
export type AlertHistoryAction = (
  | {
      type: "add";
      alert: PriceAlert;
    }
  | {
      type: "delete";
      alert: PriceAlert;
    }
  | {
      type: "update";
      before: PriceAlert;
      after: PriceAlert;
    }
) & {
  seq: number;
};
