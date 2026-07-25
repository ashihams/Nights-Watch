/**
 * Nights Watch Backend — Phase 3: Policy Engine + checkpoints + executor wiring.
 */
import Fastify from "fastify";
import { config } from "./config/index.js";
import { initOtel, shutdownOtel } from "./otel/index.js";
import { registerRoutes } from "./api/routes.js";

async function main(): Promise<void> {
  initOtel();

  const app = Fastify({ logger: true });
  await registerRoutes(app);

  const shutdown = async () => {
    await app.close();
    await shutdownOtel();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  await app.listen({ port: config.port, host: "0.0.0.0" });
  console.log(`[backend] phase=3 listening on :${config.port}`);
}

main().catch((err) => {
  console.error("[backend] failed to start:", err);
  process.exit(1);
});
