# Drawing canvas modules

`useDrawingCanvas.ts` is the React-facing orchestrator for the chart drawing
overlay. Keep its returned API compatible with the facade in
`../useDrawingCanvas.ts`; `App.tsx` should not need to know how drawing
interactions are implemented.

The implementation is split by responsibility:

- `canvasRenderer.ts` paints one frame from the current refs and editor state.
- `canvasPrimitives.ts` contains reusable low-level canvas drawing functions.
- `drawingGeometry.ts` contains chart/screen geometry, marquee intersection,
  translation, and resize calculations.
- `pendingOrderLayout.ts` measures pending-order controls and performs their
  hit-testing.
- `useArmedDrawingInteractions.ts` owns click-move-click interactions for order
  lines, trends, boxes, and group selection.
- `types.ts` contains UI state shared by the hook and renderer.

## Invariants

- Binance order drawings remain visible and interactive when regular user
  drawings are hidden.
- Exchange mutations happen through the existing trading API modules, never
  directly in the renderer.
- A canvas frame may fail without stopping subsequent frames.
- Mutable chart data needed by the long-lived paint loop must be read from refs
  or passed into `drawCanvasFrame` for each frame.
- Pure geometry and layout changes should be implemented outside the React
  orchestrator whenever possible.
