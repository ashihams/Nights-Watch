import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      // Backend routes are unprefixed (/runs, /health, …) — strip /api.
      "/api": {
        target: "http://localhost:3001",
        rewrite: (path) => path.replace(/^\/api/, "") || "/",
      },
      "/ws": { target: "ws://localhost:3001", ws: true },
    },
  },
});
