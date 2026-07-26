/**
 * Same-origin (Docker nginx / Vite proxy): `/api/*` and `/ws`.
 * Split hosting (Vercel + Render): set VITE_API_URL to the backend origin.
 */

function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

/** Base URL for REST (no trailing slash). Empty = same-origin `/api` prefix. */
export function apiBase(): string {
  const raw = import.meta.env.VITE_API_URL;
  return typeof raw === "string" && raw.trim() ? trimSlash(raw.trim()) : "";
}

/** Absolute or relative path for a backend route like `/runs` or `/health`. */
export function apiUrl(path: string): string {
  const p = path.startsWith("/") ? path : `/${path}`;
  const base = apiBase();
  return base ? `${base}${p}` : `/api${p}`;
}

/** WebSocket URL for the live dashboard hub. */
export function wsUrl(): string {
  const explicit = import.meta.env.VITE_WS_URL;
  if (typeof explicit === "string" && explicit.trim()) {
    return explicit.trim();
  }
  const base = apiBase();
  if (base) {
    const u = new URL(base);
    u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
    u.pathname = "/ws";
    u.search = "";
    u.hash = "";
    return u.toString();
  }
  const proto = window.location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${window.location.host}/ws`;
}
