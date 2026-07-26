import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  startRun,
  recordStepReport,
  prepareStep,
  getRun,
  summarizeRun,
  listRuns,
} from "../supervisor/index.js";
import { listCheckpointsForRun } from "../checkpoints/index.js";
import { getRecentExplanations } from "./ws-hub.js";
import { parseStepReport } from "../types/step-report.js";
import {
  searchFlights,
  selectFlight,
  confirmDetails,
  bookFlight,
} from "./mocks.js";
import { runDemoSequence } from "../executor/demo-sequence.js";
import { getRecoveryProcessMetrics } from "../recovery/process-metrics.js";
import { config } from "../config/index.js";

const StartRunBody = z.object({
  task: z
    .string()
    .min(1)
    .default("Find and book a flight from SFO to LAX under $400"),
});

const DemoRunBody = StartRunBody.extend({
  injectDrift: z.boolean().default(false),
});

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  app.get("/", async () => ({
    ok: true,
    service: "nights-watch",
    phase: 6,
    hint: "API only — UI is on the dashboard (e.g. http://localhost:5173). Try GET /health, /runs, /explanations, or WS /ws.",
  }));

  app.get("/health", async () => ({
    ok: true,
    service: "nights-watch",
    phase: 6,
  }));

  /** Policy thresholds for dashboard timeline reference lines. */
  app.get("/config/thresholds", async () => ({
    pause: config.pauseThreshold,
    rollback: config.rollbackThreshold,
    hardStop: config.hardStopThreshold,
  }));

  /** Process-local recovery aggregates (reset on backend restart). */
  app.get("/metrics/recovery", async () => getRecoveryProcessMetrics());

  /** Recent explanation feed (also pushed live on /ws). */
  app.get("/explanations", async () => ({
    explanations: getRecentExplanations(),
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

  /**
   * Dashboard / CLI demo: start run and drive the shared sequence in background.
   * Returns immediately; live progress streams on /ws.
   */
  app.post("/runs/demo", async (req, reply) => {
    const body = DemoRunBody.parse(req.body ?? {});
    const run = await startRun(body.task);
    void runDemoSequence(run.runId, {
      injectDrift: body.injectDrift,
      paceMs: 1000,
      log: (m) => req.log.info({ demo: true }, m),
    }).catch((err) => {
      req.log.error({ err, runId: run.runId }, "demo sequence failed");
    });
    return reply.code(202).send(run);
  });

  /**
   * Call immediately before an irreversible Executor step (e.g. book).
   * Creates a pre_irreversible checkpoint when the plan step is tagged
   * constraints.irreversible; no-op otherwise.
   */
  app.post<{ Params: { runId: string } }>(
    "/runs/:runId/prepare-step",
    async (req, reply) => {
      const body = z.object({ stepId: z.string().min(1) }).parse(req.body ?? {});
      try {
        const run = await prepareStep(req.params.runId, body.stepId);
        return { ok: true, run };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const code = message.includes("Unknown runId") ? 404 : 400;
        return reply.code(code).send({ error: message });
      }
    },
  );

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
