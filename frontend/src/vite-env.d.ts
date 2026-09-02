/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Bearer token sent with every order request. Required. */
  readonly VITE_TRADING_API_TOKEN: string;
  readonly VITE_NTFY_URL?: string;
  /** Overrides the default http://127.0.0.1:8657 trading API base URL. */
  readonly VITE_TRADING_API_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
