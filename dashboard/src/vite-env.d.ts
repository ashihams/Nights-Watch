/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Backend origin for split deploy (e.g. https://nights-watch.onrender.com). Empty = same-origin `/api`. */
  readonly VITE_API_URL?: string;
  /** Optional override for WS (defaults from VITE_API_URL → wss://…/ws). */
  readonly VITE_WS_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
