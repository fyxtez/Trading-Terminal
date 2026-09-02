import type { DrawingTool } from "../../types/drawing";
import "./DrawingToolbar.css";

type DrawingToolbarProps = {
  tool: DrawingTool;
  onSetTool: (tool: DrawingTool) => void;
  onUndo: () => void;
  onRedo: () => void;
  isHotkeysOpen: boolean;
  onToggleHotkeys: () => void;
  onCollapseToolbar: () => void;
  /**
   * Whether the toolbar should be visually collapsed (width animated to 0
   * via CSS). The component stays mounted either way - see the
   * `.drawing-panel.collapsed` rule in DrawingToolbar.css. Keeping it
   * mounted (instead of conditionally rendering <DrawingToolbar /> in
   * App.tsx) is what lets the width change animate smoothly through the
   * chart's ResizeObserver instead of jumping in one abrupt layout pass.
   */
  isCollapsed: boolean;
};

export default function DrawingToolbar({
  tool,
  onSetTool,
  onUndo,
  onRedo,
  isHotkeysOpen,
  onToggleHotkeys,
  onCollapseToolbar,
  isCollapsed,
}: DrawingToolbarProps) {
  /*
   * Clicking a tool button that's already active toggles back to the
   * cursor instead of re-arming the same tool. This matters most for
   * Pen: since it deliberately stays active across multiple strokes
   * (writing a word takes several pen-up/pen-down lifts - see the note
   * in useDrawingCanvas.ts), there needs to be one obvious, deliberate
   * way to leave pen mode once you're done, without that exit
   * interrupting a multi-stroke drawing in progress the way an
   * automatic per-stroke exit would. Escape still works too; this is
   * just a second, more discoverable way out via the same button that
   * turned it on.
   */
  const toggleTool = (target: DrawingTool) => {
    onSetTool(tool === target ? "cursor" : target);
  };

  return (
    <div
      className={`drawing-panel ${isCollapsed ? "collapsed" : ""}`}
      aria-hidden={isCollapsed}
    >
      <button
        className="tool-button"
        title="Hide toolbar"
        tabIndex={isCollapsed ? -1 : undefined}
        onClick={onCollapseToolbar}
      >
        «
      </button>

      <div className="tool-separator" />

      <button
        className={`tool-button ${tool === "cursor" ? "active" : ""}`}
        title="Cursor / select"
        tabIndex={isCollapsed ? -1 : undefined}
        onClick={() => onSetTool("cursor")}
      >
        ↖
      </button>

      <button
        className={`tool-button ${tool === "text" ? "active" : ""}`}
        title="Text (click chart to place; Alt+C)"
        tabIndex={isCollapsed ? -1 : undefined}
        onClick={() => toggleTool("text")}
      >
        T
      </button>

      <button
        className={`tool-button ${tool === "pen" ? "active" : ""}`}
        title="Pen / freehand (click again or press Esc to exit)"
        tabIndex={isCollapsed ? -1 : undefined}
        onClick={() => toggleTool("pen")}
      >
        ✎
      </button>

      <button
        className={`tool-button ${tool === "trend" ? "active" : ""}`}
        title="Trend line (click again or press Esc to exit)"
        tabIndex={isCollapsed ? -1 : undefined}
        onClick={() => toggleTool("trend")}
      >
        ╱
      </button>

      <button
        className={`tool-button ${tool === "box" ? "active" : ""}`}
        title="Purple box (click again or press Esc to exit)"
        tabIndex={isCollapsed ? -1 : undefined}
        onClick={() => toggleTool("box")}
      >
        ▭
      </button>

      {/* FEATURE: dashed marquee selects every drawing whose on-screen bounds
          intersect the user-drawn rectangle; Alt+G activates the same tool. */}
      <button
        className={`tool-button group-select-tool ${
          tool === "group-select" ? "active" : ""
        }`}
        title="Group selection marquee (click, move, click; Alt+G)"
        tabIndex={isCollapsed ? -1 : undefined}
        onClick={() => toggleTool("group-select")}
      >
        <span aria-hidden="true" />
      </button>

      <button
        className={`tool-button ${tool === "horizontal" ? "active" : ""}`}
        title="Horizontal line (click again or press Esc to exit)"
        tabIndex={isCollapsed ? -1 : undefined}
        onClick={() => toggleTool("horizontal")}
      >
        ─
      </button>

      <button
        className={`tool-button ${tool === "vertical" ? "active" : ""}`}
        title="Vertical line (click again or press Esc to exit)"
        tabIndex={isCollapsed ? -1 : undefined}
        onClick={() => toggleTool("vertical")}
      >
        │
      </button>

      <button
        className={`tool-button ruler-tool ${tool === "ruler" ? "active" : ""}`}
        title="Percentage ruler (click, move, click; Alt+R)"
        tabIndex={isCollapsed ? -1 : undefined}
        onClick={() => toggleTool("ruler")}
      >
        <span aria-hidden="true">↕</span>
        <span className="ruler-percent">%</span>
      </button>

      <div className="tool-separator" />

      <button
        className="tool-button"
        title="Undo"
        tabIndex={isCollapsed ? -1 : undefined}
        onClick={onUndo}
      >
        ↶
      </button>

      <button
        className="tool-button"
        title="Redo"
        tabIndex={isCollapsed ? -1 : undefined}
        onClick={onRedo}
      >
        ↷
      </button>

      <div className="tool-spacer" />

      {/*
       * NOTE: the backend/websocket connection status indicators that
       * used to live here (connection-status-stack) have moved to the
       * Topbar - see Topbar.tsx. This toolbar is collapsed to width:0 by
       * default (see .drawing-panel.collapsed in DrawingToolbar.css), so
       * anything shown only here required opening the toolbar first to
       * check connection health. The Topbar is never collapsed, so the
       * status is now visible at all times.
       */}

      <button
        className={`tool-button hotkeys-button ${isHotkeysOpen ? "active" : ""}`}
        title="Keyboard shortcuts"
        tabIndex={isCollapsed ? -1 : undefined}
        onClick={(event) => {
          event.stopPropagation();
          onToggleHotkeys();
        }}
      >
        ?
      </button>
    </div>
  );
}
