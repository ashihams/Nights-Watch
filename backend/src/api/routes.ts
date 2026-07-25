import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  startRun,
  recordStepReport,
  getRun,
  summarizeRun,
  listRuns,
} from "../supervisor/index.js";
import { listCheckpointsForRun } from "../checkpoints/index.js";
import { parseStepReport } from "../types/step-report.js";
import {
  searchFlights,
  selectFlight,
  confirmDetails,
  bookFlight,
} from "./mocks.js";

const StartRunBody = z.object({
  task: z
    .string()
    .min(1)
    .default("Find and book a flight from SFO to LAX under $400"),
});

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  app.get("/health", async () => ({
    ok: true,
    service: "nights-watch",
    phase: 3,
  }));

  app.get("/runs", async () => ({
    runs: listRuns().map(summarizeRun),
  }));

  app.get<{ Params: { runId: string } }>("/runs/:runId", async (req, reply) => {
    const run = getRun(req.params.runId);
    if (!run) return reply.code(404).send({ error: "run not found" });
    return summarizeRun(run);
  });

  /** Local SQLite checkpoints for a run (source of truth for rollback). */
  app.get<{ Params: { runId: string } }>(
    "/runs/:runId/checkpoints",
    async (req, reply) => {
      const checkpoints = listCheckpointsForRun(req.params.runId);
      if (checkpoints.length === 0) {
        const run = getRun(req.params.runId);
        if (!run) return reply.code(404).send({ error: "run not found" });
      }
      return { runId: req.params.runId, checkpoints };
    },
  );

  /** Create plan + open run trace. Executor (n8n or happy-path harness) drives steps. */
  app.post("/runs/start", async (req, reply) => {
    const body = StartRunBody.parse(req.body ?? {});
    const run = await startRun(body.task);
    return reply.code(201).send(run);
  });

  /** n8n / Executor step-completion callback. */
  app.post("/webhooks/n8n/step", async (req, reply) => {
    try {
      const report = parseStepReport(req.body);
      const run = await recordStepReport(report);
      return { ok: true, run };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      req.log.error({ err }, "step report failed");
      return reply.code(400).send({ error: message });
    }
  });

  // --- Mock travel APIs (called by n8n or happy-path harness) ---

  app.post("/mocks/search", async (req) => {
    const body = z
      .object({
        origin: z.string().optional(),
        destination: z.string().optional(),
        maxPrice: z.number().optional(),
        injectDrift: z.boolean().optional(),
      })
      .parse(req.body ?? {});
    return searchFlights(body);
  });

  app.post("/mocks/select", async (req, reply) => {
    const body = z.object({ flightId: z.string() }).parse(req.body ?? {});
    try {
      return selectFlight(body.flightId);
    } catch (err) {
      return reply.code(404).send({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.post("/mocks/confirm", async (req) => {
    const body = z
      .object({
        flightId: z.string(),
        passengerName: z.string().default("Demo Traveler"),
      })
      .parse(req.body ?? {});
    return confirmDetails(body);
  });

  app.post("/mocks/book", async (req) => {
    const body = z
      .object({
        flightId: z.string(),
        passengerName: z.string().default("Demo Traveler"),
      })
      .parse(req.body ?? {});
    return bookFlight(body);
  });
}
