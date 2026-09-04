import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { UTCTimestamp } from "lightweight-charts";
import ContextMenu from "./ContextMenu";

describe("ContextMenu dormant price alerts", () => {
  it("does not expose alert creation while keeping normal chart actions", () => {
    render(
      <ContextMenu
        contextMenu={{
          x: 10,
          y: 10,
          drawingId: null,
          price: 76_500,
          time: 1_725_000_000 as UTCTimestamp,
        }}
        hasPenDrawings={false}
        hasDrawings={false}
        hasTradeMarkers={false}
        drawingCountsByTimeframe={{}}
        targetDrawing={null}
        onDeleteDrawing={vi.fn()}
        onChangeColor={vi.fn()}
        onChangeAlign={vi.fn()}
        onStraightenOnXAxis={vi.fn()}
        onStraightenSelectionOnXAxis={vi.fn()}
        onResetView={vi.fn()}
        onDeleteAllPen={vi.fn()}
        onDeleteAllDrawings={vi.fn()}
        onDeleteDrawingsByTimeframe={vi.fn()}
        onDeleteAllTradeMarkers={vi.fn()}
        priceAlertsEnabled={false}
        onCreateAlert={vi.fn()}
        onCreateCoordinateMarker={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "Reset chart view" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Create crosshair marker" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Create alert" })).not.toBeInTheDocument();
  });
});
