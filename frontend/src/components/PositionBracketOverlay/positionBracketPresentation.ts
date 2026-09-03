import type { OpenPosition } from "../../trading/api/positions";
import {
  STOP_LABEL_COLLISION_THRESHOLD_PX,
  formatRMultiple,
  priceBoundaryEpsilon,
} from "./positionBracketModel";

export type DragKind = "TAKE_PROFIT" | "STOP_LOSS";

export type BracketCoordinates = {
  entryY: number;
  previewY: number;
  stopY: number;
  takeProfitY: number;
  liquidationY: number | null;
  liquidationLineWidth: number;
  paneLeft: number;
  paneWidth: number;
  paneHeight: number;
  entryLineWidth: number;
  ready: boolean;
  isStopHighlighted: boolean;
  isTakeProfitHighlighted: boolean;
  isPositionHighlighted: boolean;
};

type PresentationInput = {
  position: OpenPosition | null;
  coordinates: BracketCoordinates;
  dragKind: DragKind | null;
  previewPrice: number | null;
  displayedStopPrice: number | null;
  displayedTakeProfitPrice: number | null;
  isTakeProfitDraft: boolean;
  isStopDraft: boolean;
  pricePrecision: number;
};

/** Pure display model for the bracket's zones, labels, and collision classes. */
export function deriveBracketPresentation({
  position,
  coordinates,
  dragKind,
  previewPrice,
  displayedStopPrice,
  displayedTakeProfitPrice,
  isTakeProfitDraft,
  isStopDraft,
  pricePrecision,
}: PresentationInput) {
  const preview =
    position && dragKind && previewPrice != null
      ? {
          top: Math.min(coordinates.entryY, coordinates.previewY),
          height: Math.abs(coordinates.previewY - coordinates.entryY),
          labelTop: coordinates.previewY - Math.min(coordinates.entryY, coordinates.previewY),
          distancePct:
            position.entry_price > 0
              ? ((previewPrice - position.entry_price) / position.entry_price) * 100
              : 0,
        }
      : null;

  const rStopPrice =
    dragKind === "STOP_LOSS" && previewPrice != null ? previewPrice : displayedStopPrice;
  const rTakeProfitPrice =
    dragKind === "TAKE_PROFIT" && previewPrice != null ? previewPrice : displayedTakeProfitPrice;
  const riskDistance =
    position && rStopPrice != null ? Math.abs(position.entry_price - rStopPrice) : 0;
  const takeProfitR =
    position && rTakeProfitPrice != null && riskDistance > priceBoundaryEpsilon(pricePrecision)
      ? Math.abs(rTakeProfitPrice - position.entry_price) / riskDistance
      : null;

  const isStopProtectingProfit =
    position != null &&
    displayedStopPrice != null &&
    (position.side === "LONG"
      ? displayedStopPrice > position.entry_price
      : displayedStopPrice < position.entry_price);

  const stopControlsNearEntry =
    coordinates.ready &&
    displayedStopPrice != null &&
    Math.abs(coordinates.stopY - coordinates.entryY) < STOP_LABEL_COLLISION_THRESHOLD_PX;
  const stopControlsAbove = stopControlsNearEntry && coordinates.stopY < coordinates.entryY;
  const stopControlsBelow = stopControlsNearEntry && coordinates.stopY >= coordinates.entryY;

  const showTakeProfitZone = displayedTakeProfitPrice != null && dragKind !== "TAKE_PROFIT";
  const showStopZone = displayedStopPrice != null && dragKind !== "STOP_LOSS";
  const showTakeProfitDraftLine = isTakeProfitDraft && showTakeProfitZone;
  const showEdgeHandles = coordinates.ready && (showTakeProfitZone || showStopZone);

  let edgeHandleBounds: { top: number; height: number } | null = null;
  if (showEdgeHandles) {
    const ys = [coordinates.entryY];
    if (showTakeProfitZone) ys.push(coordinates.takeProfitY);
    if (showStopZone) ys.push(coordinates.stopY);
    const top = Math.min(...ys);
    edgeHandleBounds = {
      top,
      height: Math.max(2, Math.max(...ys) - top),
    };
  }

  return {
    preview,
    takeProfitRLabel: formatRMultiple(takeProfitR),
    isStopProtectingProfit,
    stopControlsAbove,
    stopControlsBelow,
    showTakeProfitZone,
    showStopZone,
    showStopLine: showStopZone,
    showTakeProfitDraftLine,
    hasDraftProtection: isTakeProfitDraft || isStopDraft,
    showEdgeHandles,
    edgeHandleBounds,
  };
}
