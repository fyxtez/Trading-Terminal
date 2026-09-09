/** Global gesture listeners must never confirm an action in another chart pane. */
export function isEventInChartWorkspace(event: Event, chart: HTMLElement | null): boolean {
  const pane = chart?.closest(".chart-workspace-pane");
  if (!pane) return true;
  return event.target instanceof Node && pane.contains(event.target);
}
