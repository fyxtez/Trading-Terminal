/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Bearer token sent with every order request. Required. */
  readonly VITE_TRADING_API_TOKEN: string;
  readonly VITE_NTFY_URL?: string;
  /** Hosted fallback backend. Defaults to https://terminal.fyxtez.com. */
  readonly VITE_TRADING_API_URL?: string;
  /** Local backend checked first. Defaults to http://127.0.0.1:8657. */
  readonly VITE_TRADING_LOCAL_API_URL?: string;
  /** FEATURE: public chart base used by ntfy deep links. Defaults to the demo site. */
  readonly VITE_PUBLIC_TERMINAL_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
