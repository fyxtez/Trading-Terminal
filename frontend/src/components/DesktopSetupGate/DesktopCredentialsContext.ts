import { createContext, useContext } from "react";
import type { DesktopConnection, DesktopCredentialStatus } from "../../desktop/credentials";
import type { TradingRuntimeMode } from "../../config/constants";

export type DesktopCredentialsContextValue = {
  isDesktop: boolean;
  runtimeMode: TradingRuntimeMode;
  canTrade: boolean;
  status: DesktopCredentialStatus;
  openSetup: (connection?: DesktopConnection) => void;
  disconnectBinance: () => Promise<void>;
};

export const DesktopCredentialsContext = createContext<DesktopCredentialsContextValue>({
  isDesktop: false,
  runtimeMode: "public-browser",
  canTrade: false,
  status: {
    binanceConfigured: false,
    binanceNetwork: null,
    ntfyConfigured: false,
    telegramConfigured: false,
  },
  openSetup: () => {},
  disconnectBinance: () => Promise.resolve(),
});

export const useDesktopCredentials = () => useContext(DesktopCredentialsContext);
