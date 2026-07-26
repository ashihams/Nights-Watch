/**
 * Shared demo executor — one source of truth for travel-booking step sequence.
 * Used by POST /runs/demo (paced) and the happy-path CLI (unpaced via HTTP demo).
 */
import {
  searchFlights,
  selectFlight,
  confirmDetails,
  bookFlight,
} from "../api/mocks.js";
import {
  getRun,
  prepareStep,
  recordStepReport,
  summarizeRun,
} from "../supervisor/index.js";

export type DemoSequenceOptions = {
  injectDrift: boolean;
  /** Delay between steps for human-visible dashboard pacing (0 = none). */
  paceMs?: number;
  /** Max wait for human approve/reject (default 10 min). */
  approvalTimeoutMs?: number;
  log?: (msg: string) => void;
};

type RunState = ReturnType<typeof summarizeRun>;

/** True while the run is blocked on a human decision or in-flight recovery. */
function isApprovalGate(status: string): boolean {
  return status === "awaiting_approval" || status === "recovering";
}

/**
 * Block while medium-severity pause waits for dashboard/CLI decision,
 * and through any reject→rollback recovery that follows.
 */
async function waitWhileAwaitingApproval(
  runId: string,
  timeoutMs: number,
  log: (msg: string) => void,
): Promise<RunState> {
  const started = Date.now();
  let state = summarizeRun(getRun(runId)!);
  if (!isApprovalGate(state.status)) return state;

  if (state.status === "awaiting_approval") {
    log(
      `awaiting human approval on step=${state.pendingApproval?.stepId} score=${state.pendingApproval?.score} (approve/reject via dashboard or POST /runs/${runId}/decision)`,
    );
  }

  while (isApprovalGate(state.status)) {
    if (Date.now() - started > timeoutMs) {
      throw new Error(
        `Timed out waiting for human approval on ${runId} after ${timeoutMs}ms`,
      );
    }
    await sleep(250);
    const run = getRun(runId);
    if (!run) throw new Error(`Run ${runId} disappeared while awaiting approval`);
    state = summarizeRun(run);
  }

  log(
    `approval resolved decision=${state.lastHumanDecision ?? "?"} status=${state.status} recovered=${state.recovered}`,
  );
  return state;
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

async function sleep(ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise((r) => setTimeout(r, ms));
}

/**
 * Drive search → select → confirm → book against in-process mocks + supervisor.
 * Caller must have already started the run via startRun.
 */
export async function runDemoSequence(
  runId: string,
  options: DemoSequenceOptions,
): Promise<void> {
  const log = options.log ?? ((m: string) => console.log(`[demo] ${m}`));
  const paceMs = options.paceMs ?? 0;
  const run = getRun(runId);
  if (!run) throw new Error(`Unknown runId: ${runId}`);

  const { injectDrift } = options;
  const maxBudget = run.plan.maxBudget;

  // 1) search
  const search = searchFlights({
    origin: run.plan.origin,
    destination: run.plan.destination,
    maxPrice: injectDrift ? undefined : maxBudget,
    injectDrift,
  });
  log(
    `search → ${search.options.length} options ${search.options.map((o) => `${o.id}=$${o.priceUsd}`).join(", ")}`,
  );
  let state = await recordStepReport({
    runId,
    stepId: "search",
    tool: "search_flights",
    status: "success",
    result: { options: search.options },
    costUsd: 0,
  });
  if (state.status !== "running") {
    log(`stopped early after search status=${state.status}`);
    return;
  }
  await sleep(paceMs);

  // 2) select
  let selected = injectDrift
    ? search.options.find((o) => o.id === "flt-upgrade-1200") ??
      [...search.options].sort((a, b) => b.priceUsd - a.priceUsd)[0]
    : pickInBudget(search.options, maxBudget);
  if (!selected) throw new Error("No flight to select");

  log(`selecting ${selected.id} at $${selected.priceUsd}`);
  let selectRes = selectFlight(selected.id);
  state = await recordStepReport({
    runId,
    stepId: "select",
    tool: "select_flight",
    status: "success",
    result: { selected: selectRes.selected },
    costUsd: selectRes.selected.priceUsd,
  });

  if (state.status === "awaiting_approval") {
    state = await waitWhileAwaitingApproval(
      runId,
      options.approvalTimeoutMs ?? 10 * 60_000,
      log,
    );
  }

  if (injectDrift && state.status === "running" && state.recovered) {
    log(
      `post-recovery resume; completedSteps=${state.completedSteps.join(",")}`,
    );
    await sleep(paceMs);
    const searchArtifact = state.artifacts?.search as
      | { options?: Array<{ id: string; priceUsd: number; airline: string }> }
      | undefined;
    const optionsList = searchArtifact?.options ?? search.options;
    selected = pickInBudget(optionsList, state.plan.maxBudget);
    log(`re-selecting in-budget ${selected.id} at $${selected.priceUsd}`);
    selectRes = selectFlight(selected.id);
    state = await recordStepReport({
      runId,
      stepId: "select",
      tool: "select_flight",
      status: "success",
      result: { selected: selectRes.selected },
      costUsd: selectRes.selected.priceUsd,
    });
  }

  if (state.status !== "running") {
    log(`stopped after select status=${state.status}`);
    return;
  }
  await sleep(paceMs);

  // 3) confirm
  const confirmRes = confirmDetails({
    flightId: selected.id,
    passengerName: "Demo Traveler",
  });
  state = await recordStepReport({
    runId,
    stepId: "confirm",
    tool: "confirm_details",
    status: "success",
    result: { confirmation: confirmRes.confirmation },
    costUsd: 0,
  });
  if (state.status !== "running") {
    log(`stopped after confirm status=${state.status}`);
    return;
  }
  await sleep(paceMs);

  // 4) book — pre-irreversible checkpoint (constraints.irreversible on plan step)
  state = await prepareStep(runId, "book");
  log(
    `pre-irreversible ready; checkpoints=${state.checkpointIds.length} last=${state.checkpointIds[state.checkpointIds.length - 1]}`,
  );
  await sleep(paceMs);

  const bookRes = bookFlight({
    flightId: selected.id,
    passengerName: "Demo Traveler",
  });
  state = await recordStepReport({
    runId,
    stepId: "book",
    tool: "book_flight",
    status: "success",
    result: { booking: bookRes.booking },
    costUsd: bookRes.booking.priceUsd,
  });
  log(
    `booked ${bookRes.booking.bookingId} for $${bookRes.booking.priceUsd} status=${state.status}`,
  );
}
