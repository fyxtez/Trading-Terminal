import { describe, expect, it } from "vitest";
import { isEventInChartWorkspace } from "./chartWorkspaceEvents";
describe("chart gesture ownership", () => {
  it("accepts clicks in its own pane and rejects the other pane before confirmation", () => {
    const root = document.createElement("div");
    root.innerHTML =
      '<div class="chart-workspace-pane"><div class="chart"></div><button>Left</button></div><div class="chart-workspace-pane"><button>Right</button></div>';
    const chart = root.querySelector<HTMLElement>(".chart")!;
    const [left, right] = root.querySelectorAll("button");
    let accepted = false;
    root.addEventListener("pointerdown", (event) => {
      accepted = isEventInChartWorkspace(event, chart);
    });
    left.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(accepted).toBe(true);
    right.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(accepted).toBe(false);
  });
});
