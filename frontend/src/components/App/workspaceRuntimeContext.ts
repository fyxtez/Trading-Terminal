import type { PositionBindingsStore } from "./sharedPositions";
import type { MarketOrderFill } from "../../trading/types";
import { createContext, type MutableRefObject } from "react";
import type { ConnectionState } from "../../hooks/useTradingStream";
import type { OperationalDiagnostics } from "../../hooks/useOperationalDiagnostics";
export const WorkspaceRuntimeContext = createContext<{
  topbarHost: HTMLDivElement | null;
  positions: {
    isOpen: boolean;
    setOpen: (open: boolean | ((open: boolean) => boolean)) => void;
    store: PositionBindingsStore;
  };
  localMarketFills: MutableRefObject<MarketOrderFill[]>;
  backend: ConnectionState;
  stream: ConnectionState;
  diagnostics: OperationalDiagnostics;
} | null>(null);
export const WORKSPACE_ORDER_EVENT = "terminal:workspace-order";
