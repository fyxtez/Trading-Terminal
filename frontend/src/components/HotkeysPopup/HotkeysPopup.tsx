import "../../styles/floatingPanel.css";
import "./HotkeysPopup.css";

type HotkeysPopupProps = {
  onClose: () => void;
};

export default function HotkeysPopup({ onClose }: HotkeysPopupProps) {
  return (
    <div className="hotkeys-popup" onClick={(event) => event.stopPropagation()}>
      <div className="hotkeys-header">
        <div>Keyboard shortcuts</div>

        <button className="hotkeys-close" title="Close" onClick={onClose}>
          ×
        </button>
      </div>

      <div className="hotkeys-list">
        <div>
          {/* Ctrl+W is browser-reserved in Chromium/Brave, so Alt+W
              provides a dependable close-active-symbol-tab shortcut instead. */}
          <kbd>Alt</kbd> + <kbd>W</kbd>
          <span>Close active symbol tab</span>
        </div>
        <div>
          <kbd>Alt</kbd> + <kbd>←</kbd>
          <span>Previous symbol tab</span>
        </div>
        <div>
          <kbd>Alt</kbd> + <kbd>→</kbd>
          <span>Next symbol tab</span>
        </div>
        <div>
          <kbd>Alt</kbd> + <kbd>V</kbd>
          <span>Vertical line</span>
        </div>
        <div>
          <kbd>Alt</kbd> + <kbd>H</kbd>
          <span>Horizontal line</span>
        </div>
        <div>
          <kbd>Alt</kbd> + <kbd>B</kbd>
          <span>Box</span>
        </div>
        <div>
          <kbd>Alt</kbd> + <kbd>C</kbd>
          <span>Text at crosshair</span>
        </div>
        <div>
          <kbd>Alt</kbd> + <kbd>T</kbd>
          <span>Trend line</span>
        </div>
        <div>
          <kbd>Alt</kbd> + <kbd>N</kbd>
          <span>Pen</span>
        </div>
        <div>
          <kbd>Alt</kbd> + <kbd>R</kbd>
          <span>Percentage ruler</span>
        </div>
        <div className="hotkeys-group-row">
          <kbd>Alt</kbd> + <kbd>G</kbd>
          <span>Group select</span>
        </div>
        <div className="hotkeys-group-row">
          <kbd>Shift</kbd> + <kbd>Click</kbd>
          <span>Remove from group</span>
        </div>
        <div className="hotkeys-gesture-row">
          {/* one combined gesture badge leaves a real description column;
              three independent keycaps previously squeezed this text into a
              narrow, awkward three-line stack. */}
          <kbd>Click → Move → Click</kbd>
          <span>Draw marquee or move group</span>
        </div>
        <div>
          <kbd>Ctrl</kbd> + <kbd>C</kbd>
          <span>Copy selected drawing</span>
        </div>
        <div>
          <kbd>Ctrl</kbd> + <kbd>V</kbd>
          <span>Paste drawing with offset</span>
        </div>
        <div>
          <kbd>Ctrl</kbd> + <kbd>Z</kbd>
          <span>Undo</span>
        </div>
        <div>
          <kbd>Ctrl</kbd> + <kbd>Y</kbd>
          <span>Redo</span>
        </div>
        <div>
          <kbd>Ctrl</kbd> + <kbd>Wheel</kbd>
          <span>Scale price axis</span>
        </div>
        <div>
          <kbd>Delete</kbd>
          <span>Delete selected drawing or group</span>
        </div>
        <div>
          <kbd>Esc</kbd>
          <span>Cancel / return to cursor</span>
        </div>
      </div>
    </div>
  );
}
