/**
 * Phase 1 happy-path harness — simulates the n8n Executor locally.
 * Calls the same mock APIs + /webhooks/n8n/step callbacks the real workflow will use.
 * Run: npm run happy-path
 */
import { initOtel, shutdownOtel } from "../otel/index.js";
import { config } from "../config/index.js";

const BASE = `http://127.0.0.1:${config.port}`;

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${path} → ${res.status}: ${text}`);
  }
  return JSON.parse(text) as T;
}

async function reportStep(input: {
  runId: string;
  stepId: string;
  tool: string;
  result: Record<string, unknown>;
  costUsd?: number;
}): Promise<void> {
  await postJson("/webhooks/n8n/step", {
    runId: input.runId,
    stepId: input.stepId,
    tool: input.tool,
    status: "success",
    result: input.result,
    costUsd: input.costUsd ?? 0,
  });
  console.log(`[happy-path] reported step ${input.stepId} (${input.tool})`);
}

async function main(): Promise<void> {
  initOtel();

  const health = await fetch(`${BASE}/health`);
  if (!health.ok) {
    throw new Error(`Backend not healthy at ${BASE} — start it with npm run dev`);
  }

  const task =
    process.env.NW_TASK ??
    "Find and book a flight from SFO to LAX under $400";

  console.log(`[happy-path] starting run for: ${task}`);
  const run = await postJson<{
    runId: string;
    plan: {
      maxBudget: number;
      origin?: string;
      destination?: string;
      steps: Array<{ id: string; expectedTool: string }>;
    };
  }>("/runs/start", { task });

  console.log(`[happy-path] runId=${run.runId}`);
  console.log(`[happy-path] plan maxBudget=$${run.plan.maxBudget}`);

  // 1) search
  const search = await postJson<{
    options: Array<{ id: string; priceUsd: number; airline: string }>;
  }>("/mocks/search", {
    origin: run.plan.origin,
    destination: run.plan.destination,
    maxPrice: run.plan.maxBudget,
  });
  console.log(
    `[happy-path] search → ${search.options.length} options`,
    search.options.map((o) => `${o.id}=$${o.priceUsd}`).join(", "),
  );
  await reportStep({
    runId: run.runId,
    stepId: "search",
    tool: "search_flights",
    result: { options: search.options },
  });

  // 2) select cheapest in-budget
  const selected = [...search.options].sort((a, b) => a.priceUsd - b.priceUsd)[0];
  if (!selected) throw new Error("No flights under budget");
  const selectRes = await postJson<{ selected: { id: string; priceUsd: number } }>(
    "/mocks/select",
    { flightId: selected.id },
  );
  await reportStep({
    runId: run.runId,
    stepId: "select",
    tool: "select_flight",
    result: { selected: selectRes.selected },
    costUsd: selectRes.selected.priceUsd,
  });

  // 3) confirm
  const confirmRes = await postJson<{ confirmation: Record<string, unknown> }>(
    "/mocks/confirm",
    { flightId: selected.id, passengerName: "Demo Traveler" },
  );
  await reportStep({
    runId: run.runId,
    stepId: "confirm",
    tool: "confirm_details",
    result: { confirmation: confirmRes.confirmation },
  });

  // 4) book
  const bookRes = await postJson<{
    booking: { bookingId: string; priceUsd: number };
  }>("/mocks/book", {
    flightId: selected.id,
    passengerName: "Demo Traveler",
  });
  await reportStep({
    runId: run.runId,
    stepId: "book",
    tool: "book_flight",
    result: { booking: bookRes.booking },
    costUsd: bookRes.booking.priceUsd,
  });

  console.log(`[happy-path] booked ${bookRes.booking.bookingId} for $${bookRes.booking.priceUsd}`);
  console.log(`[happy-path] done — check SigNoz Traces for run.id=${run.runId}`);
  console.log(`[happy-path] expect 4 checkpoint.created spans + 4 executor.step children`);
  console.log(`[happy-path] inspect local store: npm run checkpoints:list -- ${run.runId}`);

  await new Promise((r) => setTimeout(r, 2000));
  await shutdownOtel();
}

main().catch(async (err) => {
  console.error("[happy-path] failed:", err);
  await shutdownOtel().catch(() => undefined);
  process.exit(1);
});
