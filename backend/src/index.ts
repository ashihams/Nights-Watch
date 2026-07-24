/**
 * Nights Watch Backend — Phase 0 scaffold.
 * Fastify server only; feature modules land in later phases.
 */
import Fastify from "fastify";
import { config } from "./config/index.js";
import { initOtel, shutdownOtel } from "./otel/index.js";

async function main(): Promise<void> {
  initOtel();

  const app = Fastify({ logger: true });

  app.get("/health", async () => ({
    ok: true,
    service: "nights-watch",
    phase: 0,
  }));

  const shutdown = async () => {
    await app.close();
    await shutdownOtel();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  await app.listen({ port: config.port, host: "0.0.0.0" });
  console.log(`[backend] listening on :${config.port}`);
}

main().catch((err) => {
  console.error("[backend] failed to start:", err);
  process.exit(1);
});
