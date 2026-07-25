/**
 * Phase 1–5 happy-path / drift+recovery harness.
 * Run:
 *   npm run happy-path
 *   npm run happy-path:drift   # $1200 upgrade → policy → rollback → replan → complete
 */
import { initOtel, shutdownOtel } from "../otel/index.js";
import { config } from "../config/index.js";

const BASE = `http://127.0.0.1:${config.port}`;
const INJECT_DRIFT =
  process.env.NW_INJECT_DRIFT === "1" || process.argv.includes("--drift");

type RunState = {
  status: string;
  lastPolicyScore?: number;
  completedSteps?: string[];
  artifacts?: Record<string, unknown>;
  recoveryCount?: number;
  recovered?: boolean;
  lastRecoveryDetail?: string;
  lastExplanation?: {
    text: string;
    mcpInvoked: boolean;
    mcpOk: boolean;
    source: string;
  };
  plan?: { maxBudget: number; origin?: string; destination?: string };
};

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
}): Promise<RunState> {
  const out = await postJson<{ ok: boolean; run: RunState }>(
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
    `[happy-path] reported step ${input.stepId} (${input.tool}) status=${out.run.status} score=${out.run.lastPolicyScore} recoveries=${out.run.recoveryCount ?? 0}`,
  );
  if (out.run.lastRecoveryDetail) {
    console.log(`[happy-path] recovery: ${out.run.lastRecoveryDetail}`);
  }
  const expl = out.run.lastExplanation;
  // Only print on the violating step (score still elevated in the response).
  if (expl?.text && (out.run.lastPolicyScore ?? 0) >= config.pauseThreshold) {
    console.log(
      `[happy-path] explanation mcpInvoked=${expl.mcpInvoked} mcpOk=${expl.mcpOk}: ${expl.text}`,
    );
  }
  return out.run;
}

function pickInBudget(
  options: Array<{ id: string; priceUsd: number; airline: string }>,
  maxBudget: number,
): { id: string; priceUsd: number; airline: string } {
  const inBudget = options
    .filter((o) => o.priceUsd <= maxBudget && o.id !== "flt-upgrade-1200")
    .sort((a, b) => a.priceUsd - b.priceUsd);
  const selected = inBudget[0];
  if (!selected) throw new Error("No in-budget flight after recovery");
  return selected;
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
    console.log(`[happy-path] stopped early after search`);
    await finish(run.runId, state);
    return;
  }

  // 2) select — drift first picks upgrade; after recovery, pick in-budget
  let selected = INJECT_DRIFT
    ? search.options.find((o) => o.id === "flt-upgrade-1200") ??
      [...search.options].sort((a, b) => b.priceUsd - a.priceUsd)[0]
    : pickInBudget(search.options, run.plan.maxBudget);
  if (!selected) throw new Error("No flight to select");

  console.log(`[happy-path] selecting ${selected.id} at $${selected.priceUsd}`);
  let selectRes = await postJson<{ selected: { id: string; priceUsd: number } }>(
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

  // After drift, supervisor should auto-rollback+replan and return status=running
  if (INJECT_DRIFT && state.status === "running" && state.recovered) {
    console.log(
      `[happy-path] post-recovery resume; completedSteps=${(state.completedSteps ?? []).join(",")}`,
    );
    const searchArtifact = state.artifacts?.search as
      | { options?: Array<{ id: string; priceUsd: number; airline: string }> }
      | undefined;
    const options = searchArtifact?.options ?? search.options;
    selected = pickInBudget(options, run.plan.maxBudget);
    console.log(
      `[happy-path] re-selecting in-budget ${selected.id} at $${selected.priceUsd}`,
    );
    selectRes = await postJson<{ selected: { id: string; priceUsd: number } }>(
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
  }

  if (state.status !== "running") {
    console.log(
      `[happy-path] stopped after select: status=${state.status} score=${state.lastPolicyScore}`,
    );
    await finish(run.runId, state);
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
    console.log(`[happy-path] stopped after confirm`);
    await finish(run.runId, state);
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

  console.log(
    `[happy-path] booked ${bookRes.booking.bookingId} for $${bookRes.booking.priceUsd}`,
  );
  await finish(run.runId, state);
}

async function finish(runId: string, state: RunState): Promise<void> {
  console.log(
    `[happy-path] done — run.id=${runId} status=${state.status} recoveries=${state.recoveryCount ?? 0} recovered=${state.recovered ?? false}`,
  );
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
