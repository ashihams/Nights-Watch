/**
 * Nights Watch Backend — Phase 4+5: Explanation, Recovery, Policy, Checkpoints.
 */
import Fastify from "fastify";
import { config } from "./config/index.js";
import { initOtel, shutdownOtel } from "./otel/index.js";
import { registerRoutes } from "./api/routes.js";
import { attachDashboardWs } from "./api/ws-hub.js";

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
  const server = app.server;
  attachDashboardWs(server);
  console.log(`[backend] phase=6 listening on :${config.port} (ws=/ws)`);
}

main().catch((err) => {
  console.error("[backend] failed to start:", err);
  process.exit(1);
});
