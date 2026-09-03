import { useEffect, useRef, useState } from "react";
import type { UTCTimestamp } from "lightweight-charts";
import type { BoxDrawing, Drawing, HorizontalDrawing, TrendDrawing } from "../../types/drawing";
import { modifyLimitOrder, repriceReduceOrder } from "../../trading/api/orders";
import { isStaleOrderError } from "../../trading/errors";
import { cloneDrawing } from "../../utils/drawings";
import type { ChartRefs } from "../useChartRefs";
import type { CoordinateMapping } from "../useCoordinateMapping";
import type { DrawingsApi } from "../useDrawings";
import type { MarketDataApi } from "../useMarketData";
import type { TradeMenuApi } from "../useTradeMenu";
import {
  computeBoxResize,
  drawingIntersectsMarquee,
  isOrderDrawing,
  reduceOrderBoundaryStep,
  translateDrawing,
  type BoxHandleMode,
} from "./drawingGeometry";

export function useArmedDrawingInteractions(
  refs: ChartRefs,
  coord: CoordinateMapping,
  drawingsApi: DrawingsApi,
  marketData: MarketDataApi,
  tradeMenuApi: TradeMenuApi,
) {
  const [armedGroupMove, setArmedGroupMove] = useState<{
    pointerStart: { time: UTCTimestamp; price: number };
    before: Drawing[];
  } | null>(null);
  const [isGroupMarqueeActive, setIsGroupMarqueeActive] = useState(false);
  const [armedOrderLineId, setArmedOrderLineId] = useState<string | null>(null);
  const armedOrderLineBeforeRef = useRef<HorizontalDrawing | null>(null);
  const [armedTrendEndpoint, setArmedTrendEndpoint] = useState<{
    drawingId: string;
    end: "start" | "end";
  } | null>(null);
  const armedTrendEndpointBeforeRef = useRef<TrendDrawing | null>(null);
  const [armedTrendMove, setArmedTrendMove] = useState<{
    drawingId: string;
    pointerStart: { time: UTCTimestamp; price: number };
  } | null>(null);
  const armedTrendMoveBeforeRef = useRef<TrendDrawing | null>(null);
  const [armedBoxHandle, setArmedBoxHandle] = useState<{
    drawingId: string;
    mode: BoxHandleMode;
  } | null>(null);
  const armedBoxHandleBeforeRef = useRef<BoxDrawing | null>(null);

  const armOrderLineMove = (drawing: HorizontalDrawing) => {
    armedOrderLineBeforeRef.current = cloneDrawing(drawing) as HorizontalDrawing;
    setArmedOrderLineId(drawing.id);
    drawingsApi.setSelectedId(drawing.id);
    drawingsApi.setContextMenu(null);
  };

  const armTrendEndpointMove = (drawing: TrendDrawing, end: "start" | "end") => {
    armedTrendEndpointBeforeRef.current = cloneDrawing(drawing) as TrendDrawing;
    setArmedTrendEndpoint({ drawingId: drawing.id, end });
    drawingsApi.setSelectedId(drawing.id);
    drawingsApi.setContextMenu(null);
  };

  const cancelTrendEndpointMove = () => {
    const before = armedTrendEndpointBeforeRef.current;

    if (before) {
      drawingsApi.replaceDrawingWithoutHistory(before.id, before);
    }

    armedTrendEndpointBeforeRef.current = null;
    setArmedTrendEndpoint(null);
  };

  const armTrendMove = (
    drawing: TrendDrawing,
    pointerStart: { time: UTCTimestamp; price: number },
  ) => {
    armedTrendMoveBeforeRef.current = cloneDrawing(drawing) as TrendDrawing;
    setArmedTrendMove({ drawingId: drawing.id, pointerStart });
    drawingsApi.setSelectedId(drawing.id);
    drawingsApi.setContextMenu(null);
  };

  const cancelTrendMove = () => {
    const before = armedTrendMoveBeforeRef.current;

    if (before) {
      drawingsApi.replaceDrawingWithoutHistory(before.id, before);
    }

    armedTrendMoveBeforeRef.current = null;
    setArmedTrendMove(null);
  };

  const armBoxHandleMove = (drawing: BoxDrawing, mode: BoxHandleMode) => {
    armedBoxHandleBeforeRef.current = cloneDrawing(drawing) as BoxDrawing;
    setArmedBoxHandle({ drawingId: drawing.id, mode });
    drawingsApi.setSelectedId(drawing.id);
    drawingsApi.setContextMenu(null);
  };

  const cancelBoxHandleMove = () => {
    const before = armedBoxHandleBeforeRef.current;

    if (before) {
      drawingsApi.replaceDrawingWithoutHistory(before.id, before);
    }

    armedBoxHandleBeforeRef.current = null;
    setArmedBoxHandle(null);
  };

  const cancelOrderLineMove = () => {
    const before = armedOrderLineBeforeRef.current;

    if (before) {
      drawingsApi.replaceDrawingWithoutHistory(before.id, before);
    }

    armedOrderLineBeforeRef.current = null;
    setArmedOrderLineId(null);
  };

  const submitOrderLineMove = (before: HorizontalDrawing, nextPrice: number) => {
    if (
      before.orderSide === undefined ||
      before.orderId === undefined ||
      before.orderSymbol === undefined ||
      before.orderQuantity === undefined
    ) {
      drawingsApi.replaceDrawingWithoutHistory(before.id, before);
      return;
    }

    // Never send a non-finite/zero/negative drag result to the backend.
    // Besides avoiding a guaranteed HTTP 400, restoring the confirmed drawing
    // here prevents TP zones from disappearing while an invalid request fails.
    if (!Number.isFinite(nextPrice) || nextPrice <= 0) {
      drawingsApi.replaceDrawingWithoutHistory(before.id, {
        ...before,
        orderPricePending: false,
      });
      tradeMenuApi.setTradeToast({
        kind: "error",
        message: "Order price must stay above zero",
      });
      return;
    }

    if (nextPrice === before.price) {
      drawingsApi.replaceDrawingWithoutHistory(before.id, {
        ...before,
        orderPricePending: false,
      });
      return;
    }

    const sideLabel = before.orderSide === "BUY" ? "Long" : "Short";
    const isReduceOrder =
      before.orderIntent === "REDUCE" || before.clientOrderId?.startsWith("fe-red-") === true;
    const isFullTakeProfit =
      isReduceOrder && (before.orderReducePct === 100 || before.orderRemainingPct === 0);
    const orderLabel = isFullTakeProfit
      ? "Full TP"
      : isReduceOrder
        ? "Take profit"
        : before.orderIntent === "ADD"
          ? `${sideLabel} add`
          : `${sideLabel} limit`;

    if (isReduceOrder) {
      const marketPrice = refs.liveMarketPriceRef.current ?? marketData.lastPrice;

      if (marketPrice != null) {
        const invalidDirection =
          (before.orderSide === "SELL" && nextPrice <= marketPrice) ||
          (before.orderSide === "BUY" && nextPrice >= marketPrice);

        if (invalidDirection) {
          drawingsApi.replaceDrawingWithoutHistory(before.id, before);

          tradeMenuApi.setTradeToast({
            kind: "error",
            message:
              before.orderSide === "SELL"
                ? "Take profit must stay above the current price"
                : "Take profit must stay below the current price",
          });

          return;
        }
      }
    }

    const moved: HorizontalDrawing = {
      ...before,
      price: nextPrice,
      orderPricePending: true,
    };

    drawingsApi.replaceDrawingWithoutHistory(moved.id, moved);

    tradeMenuApi.setTradeToast({
      kind: "success",
      message: `Updating ${orderLabel.toLowerCase()}…`,
    });

    const request = isReduceOrder
      ? repriceReduceOrder(before.orderSymbol!, before.orderId!, {
          price: nextPrice,
          client_order_id: before.clientOrderId,
          reduce_pct: before.orderReducePct,
        })
      : modifyLimitOrder(before.orderSymbol!, before.orderId!, {
          side: before.orderSide!,
          quantity: before.orderQuantity!,
          price: nextPrice,
          time_in_force: before.timeInForce ?? "GTC",
        });

    void request
      .then((result) => {
        const confirmed: HorizontalDrawing = {
          ...moved,
          price: result.submitted_price,
          orderId: typeof result.order?.orderId === "string" ? result.order.orderId : moved.orderId,
          clientOrderId: result.order?.clientOrderId ?? moved.clientOrderId,
          orderQuantity: result.submitted_quantity,
          orderPricePending: true,
        };

        drawingsApi.replaceDrawingWithoutHistory(confirmed.id, confirmed);
        drawingsApi.pushHistory({
          type: "update",
          before,
          after: cloneDrawing(confirmed),
        });

        tradeMenuApi.setTradeToast({
          kind: "success",
          message: `${orderLabel} moved to ${confirmed.price.toFixed(marketData.pricePrecision)}`,
        });
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : "Failed to modify limit order";
        const staleOrder = isStaleOrderError(message);
        /*
         * Binance's own matching engine rejects a reduce-only order that
         * sits on the far side of other pending same-side orders it
         * would have to pass through first (see the -2022 code) -
         * because if those other orders filled first, the position
         * could already be flat/flipped by the time this one's price is
         * reached, which a reduce-only order can never be allowed to do.
         * This is a genuine exchange-side constraint, not a bug in
         * either this app's frontend or backend - translating the raw
         * code into what it actually means is just kinder than showing
         * "-2022: ReduceOnly Order is rejected." verbatim.
         */
        const reduceOnlyBlocked =
          message.includes("-2022") ||
          message.toLowerCase().includes("reduceonly order is rejected");

        drawingsApi.replaceDrawingWithoutHistory(before.id, {
          ...before,
          orderPricePending: false,
        });
        window.dispatchEvent(new Event("orders-state-changed"));

        tradeMenuApi.setTradeToast({
          kind: "error",
          message: staleOrder
            ? "The live take-profit order could not be resolved. Open Orders was refreshed."
            : reduceOnlyBlocked
              ? "Can't rest this order there - other pending orders on the same side would need to fill first, which could exceed your position size before this price is reached. Move it closer, or cancel/reduce those orders."
              : message,
        });
      });
  };

  useEffect(() => {
    if (!armedOrderLineId) return;

    const handlePointerMove = (event: PointerEvent) => {
      const wrap = refs.chartWrapRef.current;
      if (!wrap) return;

      const rect = wrap.getBoundingClientRect();
      const chartPoint = coord.screenToChartPoint(
        event.clientX - rect.left,
        event.clientY - rect.top,
      );

      if (!chartPoint) return;

      const current = refs.drawingsRef.current.find((drawing) => drawing.id === armedOrderLineId);

      if (!current || current.type !== "horizontal") return;

      let nextPrice = chartPoint.price;

      const isReduceOrder =
        current.orderIntent === "REDUCE" || current.clientOrderId?.startsWith("fe-red-") === true;

      if (isReduceOrder && current.orderSide) {
        const marketPrice = refs.liveMarketPriceRef.current ?? marketData.lastPrice;

        if (marketPrice != null && Number.isFinite(marketPrice) && marketPrice > 0) {
          const boundaryStep = reduceOrderBoundaryStep(
            marketPrice,
            marketData.tickSize,
            marketData.pricePrecision,
          );
          nextPrice =
            current.orderSide === "SELL"
              ? Math.max(nextPrice, marketPrice + boundaryStep)
              : Math.max(boundaryStep, Math.min(nextPrice, marketPrice - boundaryStep));
        }
      }

      drawingsApi.replaceDrawingWithoutHistory(current.id, {
        ...current,
        price: nextPrice,
        orderPricePending: true,
      });
    };

    const handleConfirmClick = (event: PointerEvent) => {
      if (event.button !== 0) return;

      const before = armedOrderLineBeforeRef.current;
      const current = refs.drawingsRef.current.find((drawing) => drawing.id === armedOrderLineId);

      armedOrderLineBeforeRef.current = null;
      setArmedOrderLineId(null);

      if (!before || !current || current.type !== "horizontal") return;

      submitOrderLineMove(before, current.price);
    };

    const handleCancelKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      cancelOrderLineMove();
    };

    const handleCancelContextMenu = (event: MouseEvent) => {
      event.preventDefault();
      cancelOrderLineMove();
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerdown", handleConfirmClick, {
      once: true,
    });
    window.addEventListener("keydown", handleCancelKey);
    window.addEventListener("contextmenu", handleCancelContextMenu);

    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerdown", handleConfirmClick);
      window.removeEventListener("keydown", handleCancelKey);
      window.removeEventListener("contextmenu", handleCancelContextMenu);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [armedOrderLineId]);

  useEffect(() => {
    if (!armedTrendEndpoint) return;

    const handlePointerMove = (event: PointerEvent) => {
      const wrap = refs.chartWrapRef.current;
      if (!wrap) return;

      const rect = wrap.getBoundingClientRect();
      const chartPoint = coord.screenToChartPoint(
        event.clientX - rect.left,
        event.clientY - rect.top,
      );

      if (!chartPoint) return;

      const current = refs.drawingsRef.current.find(
        (drawing) => drawing.id === armedTrendEndpoint.drawingId,
      );

      if (!current || current.type !== "trend") return;

      drawingsApi.replaceDrawingWithoutHistory(current.id, {
        ...current,
        [armedTrendEndpoint.end]: { ...chartPoint },
      });
    };

    const handleConfirmClick = (event: PointerEvent) => {
      if (event.button !== 0) return;

      const before = armedTrendEndpointBeforeRef.current;
      const current = refs.drawingsRef.current.find(
        (drawing) => drawing.id === armedTrendEndpoint.drawingId,
      );

      armedTrendEndpointBeforeRef.current = null;
      setArmedTrendEndpoint(null);

      if (!before || !current || current.type !== "trend") return;

      drawingsApi.pushHistory({
        type: "update",
        before: cloneDrawing(before),
        after: cloneDrawing(current),
      });
    };

    const handleCancelKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      cancelTrendEndpointMove();
    };

    const handleCancelContextMenu = (event: MouseEvent) => {
      event.preventDefault();
      cancelTrendEndpointMove();
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerdown", handleConfirmClick, {
      once: true,
    });
    window.addEventListener("keydown", handleCancelKey);
    window.addEventListener("contextmenu", handleCancelContextMenu);

    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerdown", handleConfirmClick);
      window.removeEventListener("keydown", handleCancelKey);
      window.removeEventListener("contextmenu", handleCancelContextMenu);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [armedTrendEndpoint]);

  useEffect(() => {
    if (!isGroupMarqueeActive) return;

    const handlePointerMove = (event: PointerEvent) => {
      const wrap = refs.chartWrapRef.current;
      const marquee = refs.groupSelectionBoxRef.current;
      if (!wrap || !marquee) return;
      const rect = wrap.getBoundingClientRect();
      marquee.end = {
        x: event.clientX - rect.left,
        y: event.clientY - rect.top,
      };
    };

    const finishMarquee = (event: PointerEvent) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();

      const box = refs.groupSelectionBoxRef.current;
      refs.groupSelectionBoxRef.current = null;
      setIsGroupMarqueeActive(false);
      if (!box) return;

      const marquee = {
        left: Math.min(box.start.x, box.end.x),
        right: Math.max(box.start.x, box.end.x),
        top: Math.min(box.start.y, box.end.y),
        bottom: Math.max(box.start.y, box.end.y),
      };
      const selected = refs.drawingsRef.current.filter(
        (drawing) =>
          !isOrderDrawing(drawing) && drawingIntersectsMarquee(drawing, marquee, refs, coord),
      );

      refs.groupSelectedIdsRef.current.clear();
      selected.forEach((drawing) => refs.groupSelectedIdsRef.current.add(drawing.id));
      drawingsApi.setSelectedId(null);
      drawingsApi.setContextMenu(null);
    };

    const cancelMarquee = (event: Event) => {
      event.preventDefault();
      event.stopPropagation();
      refs.groupSelectionBoxRef.current = null;
      setIsGroupMarqueeActive(false);
    };

    const handleCancelKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") cancelMarquee(event);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerdown", finishMarquee, {
      once: true,
      capture: true,
    });
    window.addEventListener("keydown", handleCancelKey, true);
    window.addEventListener("contextmenu", cancelMarquee, true);

    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerdown", finishMarquee, true);
      window.removeEventListener("keydown", handleCancelKey, true);
      window.removeEventListener("contextmenu", cancelMarquee, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isGroupMarqueeActive]);

  useEffect(() => {
    if (!armedGroupMove) return;

    const handlePointerMove = (event: PointerEvent) => {
      const wrap = refs.chartWrapRef.current;
      if (!wrap) return;

      const rect = wrap.getBoundingClientRect();
      const chartPoint = coord.screenToChartPoint(
        event.clientX - rect.left,
        event.clientY - rect.top,
      );
      if (!chartPoint) return;

      const timeDelta = Number(chartPoint.time) - Number(armedGroupMove.pointerStart.time);
      const priceDelta = chartPoint.price - armedGroupMove.pointerStart.price;
      const translated = new Map(
        armedGroupMove.before.map((drawing) => [
          drawing.id,
          translateDrawing(drawing, timeDelta, priceDelta),
        ]),
      );

      // update the full group in one sync per pointer frame. Calling
      // replaceDrawingWithoutHistory once per member would persist several
      // partial intermediate group positions and cause avoidable re-renders.
      drawingsApi.syncDrawings(
        refs.drawingsRef.current.map((drawing) => translated.get(drawing.id) ?? drawing),
      );
    };

    const finishGroupMove = () => {
      const before = armedGroupMove.before;
      const currentById = new Map(refs.drawingsRef.current.map((drawing) => [drawing.id, drawing]));

      before.forEach((original) => {
        const current = currentById.get(original.id);
        if (!current || JSON.stringify(original) === JSON.stringify(current)) {
          return;
        }
        drawingsApi.pushHistory({
          type: "update",
          before: cloneDrawing(original),
          after: cloneDrawing(current),
        });
      });
      setArmedGroupMove(null);
    };

    const cancelGroupMove = () => {
      const originalById = new Map(armedGroupMove.before.map((drawing) => [drawing.id, drawing]));
      drawingsApi.syncDrawings(
        refs.drawingsRef.current.map((drawing) => originalById.get(drawing.id) ?? drawing),
      );
      setArmedGroupMove(null);
    };

    const handleConfirmClick = (event: PointerEvent) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      finishGroupMove();
    };

    const handleCancelKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      cancelGroupMove();
    };

    const handleCancelContextMenu = (event: MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      cancelGroupMove();
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerdown", handleConfirmClick, {
      once: true,
      capture: true,
    });
    window.addEventListener("keydown", handleCancelKey, true);
    window.addEventListener("contextmenu", handleCancelContextMenu, true);

    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerdown", handleConfirmClick, true);
      window.removeEventListener("keydown", handleCancelKey, true);
      window.removeEventListener("contextmenu", handleCancelContextMenu, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [armedGroupMove]);

  useEffect(() => {
    if (!armedTrendMove) return;

    const handlePointerMove = (event: PointerEvent) => {
      const wrap = refs.chartWrapRef.current;
      const before = armedTrendMoveBeforeRef.current;
      if (!wrap || !before) return;

      const rect = wrap.getBoundingClientRect();
      const chartPoint = coord.screenToChartPoint(
        event.clientX - rect.left,
        event.clientY - rect.top,
      );
      if (!chartPoint) return;

      const timeDelta = Number(chartPoint.time) - Number(armedTrendMove.pointerStart.time);
      const priceDelta = chartPoint.price - armedTrendMove.pointerStart.price;

      drawingsApi.replaceDrawingWithoutHistory(before.id, {
        ...before,
        start: {
          time: Math.round(Number(before.start.time) + timeDelta) as UTCTimestamp,
          price: before.start.price + priceDelta,
        },
        end: {
          time: Math.round(Number(before.end.time) + timeDelta) as UTCTimestamp,
          price: before.end.price + priceDelta,
        },
      });
    };

    const handleConfirmClick = (event: PointerEvent) => {
      if (event.button !== 0) return;

      // the drop click belongs only to the armed trendline. Capturing
      // and consuming it prevents the same click from selecting a different
      // drawing, panning the chart, or activating a trade control underneath.
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();

      const before = armedTrendMoveBeforeRef.current;
      const current = refs.drawingsRef.current.find(
        (drawing) => drawing.id === armedTrendMove.drawingId,
      );

      armedTrendMoveBeforeRef.current = null;
      setArmedTrendMove(null);

      if (!before || !current || current.type !== "trend") return;

      if (JSON.stringify(before) !== JSON.stringify(current)) {
        drawingsApi.pushHistory({
          type: "update",
          before: cloneDrawing(before),
          after: cloneDrawing(current),
        });
      }
    };

    const handleCancelKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      cancelTrendMove();
    };

    const handleCancelContextMenu = (event: MouseEvent) => {
      event.preventDefault();
      cancelTrendMove();
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerdown", handleConfirmClick, {
      once: true,
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
  }, [armedTrendMove]);

  useEffect(() => {
    if (!armedBoxHandle) return;

    const handlePointerMove = (event: PointerEvent) => {
      const wrap = refs.chartWrapRef.current;
      if (!wrap) return;

      const rect = wrap.getBoundingClientRect();
      const chartPoint = coord.screenToChartPoint(
        event.clientX - rect.left,
        event.clientY - rect.top,
      );

      if (!chartPoint) return;

      const current = refs.drawingsRef.current.find(
        (drawing) => drawing.id === armedBoxHandle.drawingId,
      );

      if (!current || current.type !== "box") return;

      const next = computeBoxResize(current, armedBoxHandle.mode, chartPoint);

      drawingsApi.replaceDrawingWithoutHistory(current.id, {
        ...current,
        start: next.start,
        end: next.end,
      });
    };

    const handleConfirmClick = (event: PointerEvent) => {
      if (event.button !== 0) return;

      const before = armedBoxHandleBeforeRef.current;
      const current = refs.drawingsRef.current.find(
        (drawing) => drawing.id === armedBoxHandle.drawingId,
      );

      armedBoxHandleBeforeRef.current = null;
      setArmedBoxHandle(null);

      if (!before || !current || current.type !== "box") return;

      drawingsApi.pushHistory({
        type: "update",
        before: cloneDrawing(before),
        after: cloneDrawing(current),
      });
    };

    const handleCancelKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      cancelBoxHandleMove();
    };

    const handleCancelContextMenu = (event: MouseEvent) => {
      event.preventDefault();
      cancelBoxHandleMove();
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerdown", handleConfirmClick, {
      once: true,
    });
    window.addEventListener("keydown", handleCancelKey);
    window.addEventListener("contextmenu", handleCancelContextMenu);

    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerdown", handleConfirmClick);
      window.removeEventListener("keydown", handleCancelKey);
      window.removeEventListener("contextmenu", handleCancelContextMenu);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [armedBoxHandle]);
  return {
    armedGroupMove,
    setArmedGroupMove,
    setIsGroupMarqueeActive,
    armedOrderLineId,
    armedTrendEndpoint,
    armedTrendMove,
    armedBoxHandle,
    armOrderLineMove,
    armTrendEndpointMove,
    armTrendMove,
    armBoxHandleMove,
    submitOrderLineMove,
  };
}
