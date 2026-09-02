import { createContext, useContext } from "react";
import type {
  DesktopConnection,
  DesktopCredentialStatus,
} from "../../desktop/credentials";

export type DesktopCredentialsContextValue = {
  isDesktop: boolean;
  status: DesktopCredentialStatus;
  openSetup: (connection?: DesktopConnection) => void;
};

export const DesktopCredentialsContext = createContext<DesktopCredentialsContextValue>({
  isDesktop: false,
  status: {
    binanceConfigured: false,
    binanceNetwork: null,
    ntfyConfigured: false,
    telegramConfigured: false,
  },
  openSetup: () => {},
});

export const useDesktopCredentials = () => useContext(DesktopCredentialsContext);
