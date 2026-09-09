import { lazy, Suspense, useSyncExternalStore, type ComponentProps } from "react";
import type PositionsPanelComponent from "../PositionsPanel/PositionsPanel";

const PositionsPanel = lazy(() => import("../PositionsPanel/PositionsPanel"));
type PanelProps = ComponentProps<typeof PositionsPanelComponent>;
export type PanePositionBindings = Omit<
  PanelProps,
  "isOpen" | "onClose" | "height" | "onHeightChange"
>;

/** Chart callbacks update the shared dock without rerendering the chart workspace. */
export function createPositionBindingsStore() {
  const panes = new Map<string, PanePositionBindings>();
  const listeners = new Set<() => void>();
  return {
    get: (id: string) => panes.get(id),
    set: (id: string, bindings: PanePositionBindings) => {
      panes.set(id, bindings);
      listeners.forEach((notify) => notify());
    },
    remove: (id: string) => {
      panes.delete(id);
      listeners.forEach((notify) => notify());
    },
    subscribe: (notify: () => void) => {
      listeners.add(notify);
      return () => {
        listeners.delete(notify);
      };
    },
  };
}
export type PositionBindingsStore = ReturnType<typeof createPositionBindingsStore>;

export function SharedPositionsPanel({
  store,
  activeId,
  ...controls
}: {
  store: PositionBindingsStore;
  activeId: string;
} & Pick<PanelProps, "isOpen" | "onClose" | "height" | "onHeightChange">) {
  const bindings = useSyncExternalStore(store.subscribe, () => store.get(activeId));
  if (!bindings) return null;
  return (
    <Suspense
      fallback={
        <div className="lazy-panel-loading positions-panel-loading" role="status">
          Loading positions…
        </div>
      }
    >
      <PositionsPanel {...bindings} {...controls} />
    </Suspense>
  );
}
