/**
 * Phase 1–3 happy-path / drift harness — simulates the n8n Executor locally.
 * Run:
 *   npm run happy-path
 *   npm run happy-path:drift   # inject $1200 upgrade → expect high policy score
 */
import { initOtel, shutdownOtel } from "../otel/index.js";
import { config } from "../config/index.js";

const BASE = `http://127.0.0.1:${config.port}`;
const INJECT_DRIFT =
  process.env.NW_INJECT_DRIFT === "1" || process.argv.includes("--drift");

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
}): Promise<Record<string, unknown>> {
  const out = await postJson<{ ok: boolean; run: Record<string, unknown> }>(
    "/webhooks/n8n/step",
    {
      runId: input.runId,
      stepId: input.stepId,
      tool: input.tool,
      status: "success",
      result: input.result,
      costUsd: input.costUsd ?? 0,
    },
  );
  console.log(
    `[happy-path] reported step ${input.stepId} (${input.tool}) status=${out.run.status} score=${out.run.lastPolicyScore}`,
  );
  return out.run;
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

  console.log(
    `[happy-path] starting run for: ${task} injectDrift=${INJECT_DRIFT}`,
  );
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
    // On drift path, do NOT filter by maxPrice so the $1200 option survives.
    maxPrice: INJECT_DRIFT ? undefined : run.plan.maxBudget,
    injectDrift: INJECT_DRIFT,
  });
  console.log(
    `[happy-path] search → ${search.options.length} options`,
    search.options.map((o) => `${o.id}=$${o.priceUsd}`).join(", "),
  );
  let state = await reportStep({
    runId: run.runId,
    stepId: "search",
    tool: "search_flights",
    result: { options: search.options },
  });
  if (state.status !== "running") {
    console.log(`[happy-path] stopped early after search: ${JSON.stringify(state)}`);
    await finish(run.runId);
    return;
  }

  // 2) select — drift picks the $1200 upgrade; happy path picks cheapest in-budget
  const selected = INJECT_DRIFT
    ? search.options.find((o) => o.id === "flt-upgrade-1200") ??
      [...search.options].sort((a, b) => b.priceUsd - a.priceUsd)[0]
    : [...search.options].sort((a, b) => a.priceUsd - b.priceUsd)[0];
  if (!selected) throw new Error("No flight to select");
  console.log(
    `[happy-path] selecting ${selected.id} at $${selected.priceUsd}`,
  );
  const selectRes = await postJson<{ selected: { id: string; priceUsd: number } }>(
    "/mocks/select",
    { flightId: selected.id },
  );
  state = await reportStep({
    runId: run.runId,
    stepId: "select",
    tool: "select_flight",
    result: { selected: selectRes.selected },
    costUsd: selectRes.selected.priceUsd,
  });
  if (state.status !== "running") {
    console.log(
      `[happy-path] stopped after select (expected on drift): status=${state.status} score=${state.lastPolicyScore}`,
    );
    await finish(run.runId);
    return;
  }

  // 3) confirm
  const confirmRes = await postJson<{ confirmation: Record<string, unknown> }>(
    "/mocks/confirm",
    { flightId: selected.id, passengerName: "Demo Traveler" },
  );
  state = await reportStep({
    runId: run.runId,
    stepId: "confirm",
    tool: "confirm_details",
    result: { confirmation: confirmRes.confirmation },
  });
  if (state.status !== "running") {
    console.log(`[happy-path] stopped after confirm: ${JSON.stringify(state)}`);
    await finish(run.runId);
    return;
  }

  // 4) book
  const bookRes = await postJson<{
    booking: { bookingId: string; priceUsd: number };
  }>("/mocks/book", {
    flightId: selected.id,
    passengerName: "Demo Traveler",
  });
  state = await reportStep({
    runId: run.runId,
    stepId: "book",
    tool: "book_flight",
    result: { booking: bookRes.booking },
    costUsd: bookRes.booking.priceUsd,
  });

  console.log(`[happy-path] booked ${bookRes.booking.bookingId} for $${bookRes.booking.priceUsd}`);
  await finish(run.runId);
}

async function finish(runId: string): Promise<void> {
  console.log(`[happy-path] done — run.id=${runId}`);
  console.log(`[happy-path] local checkpoints: npm run checkpoints:list -- ${runId}`);
  console.log(`[happy-path] ClickHouse spans:  npm run spans:verify -- ${runId}`);
  await new Promise((r) => setTimeout(r, 2500));
  await shutdownOtel();
}

main().catch(async (err) => {
  console.error("[happy-path] failed:", err);
  await shutdownOtel().catch(() => undefined);
  process.exit(1);
});
