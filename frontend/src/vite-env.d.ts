/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Temporary local-development bearer token. Must match backend SERVICE_API_TOKEN. */
  readonly VITE_TRADING_API_TOKEN: string;
  /** Hosted/fallback backend base URL. */
  readonly VITE_TRADING_API_URL?: string;
  /** Local backend checked first. Defaults to http://127.0.0.1:8657. */
  readonly VITE_TRADING_LOCAL_API_URL?: string;
  /** Public chart base used in alert deep links. */
  readonly VITE_PUBLIC_TERMINAL_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
