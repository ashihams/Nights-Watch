/**
 * Recovery Engine — severity→action, rollback from local Checkpoint store, re-plan.
 * SigNoz access: none for restore (local SQLite only). Emits recovery OTel metrics/spans.
 * Never reconstructs state from SigNoz.
 */
import type { SpanContext } from "@opentelemetry/api";
import { generatePlan } from "../planner/index.js";
import {
  getCheckpointById,
  getLatestCheckpoint,
  listCheckpointsForRun,
} from "../checkpoints/index.js";
import type { Checkpoint } from "../types/checkpoint.js";
import type { Plan } from "../types/plan.js";
import type { PolicyEvaluation } from "../types/policy.js";
import {
  SpanNames,
  withChildSpan,
  recordRecoveryAttempt,
  recordRollbackOutcome,
  recordRecoveredExecution,
  recordRecoveryDurationMs,
} from "../otel/index.js";
import {
  noteRecoveredExecution,
  noteRollbackAttempt,
} from "./process-metrics.js";

export type Severity = "low" | "medium" | "high" | "hard_stop";

/**
 * Single severity→action policy (CURSOR_GUIDE Phase 5 / Phase 7).
 * medium → await human approve/reject on the dashboard (not auto-recover).
 */
export type RecoveryAction =
  | "continue"
  | "replan"
  | "rollback_replan"
  | "await_human"
  | "hard_stop";

export function decideRecoveryAction(severity: Severity): RecoveryAction {
  switch (severity) {
    case "low":
      return "continue";
    case "medium":
      return "await_human";
    case "high":
      return "rollback_replan";
    case "hard_stop":
      return "hard_stop";
    default: {
      const _exhaustive: never = severity;
      return _exhaustive;
    }
  }
}

export interface RunSnapshot {
  task: string;
  plan: Plan;
  planSource: "llm" | "deterministic_fallback";
  completedSteps: string[];
  artifacts: Record<string, unknown>;
  budgetConsumed: number;
  checkpointIds: string[];
  status: string;
}

export interface RecoveryResult {
  action: RecoveryAction;
  success: boolean;
  restoredCheckpointId: string | null;
  plan: Plan;
  planSource: "llm" | "deterministic_fallback";
  completedSteps: string[];
  artifacts: Record<string, unknown>;
  budgetConsumed: number;
  checkpointIds: string[];
  detail: string;
  durationMs: number;
}

/** Pick last safe checkpoint strictly before the offending step (prefer prior milestone). */
export function selectRollbackCheckpoint(
  runId: string,
  offendingStepId: string,
  checkpointIds: string[],
): Checkpoint | undefined {
  const all = listCheckpointsForRun(runId);
  if (all.length === 0) return getLatestCheckpoint(runId);

  // Prefer a checkpoint whose planStep is NOT the offending step and whose
  // completedSteps in state do not include the offending step.
  const safe = [...all]
    .reverse()
    .find((cp) => {
      const steps = (cp.state.completedSteps as string[] | undefined) ?? [];
      return !steps.includes(offendingStepId) && cp.planStep !== offendingStepId;
    });
  if (safe) return safe;

  // Fallback: previous id in the run's checkpoint list
  if (checkpointIds.length >= 2) {
    const prevId = checkpointIds[checkpointIds.length - 2];
    if (prevId) {
      const prev = getCheckpointById(prevId);
      if (prev) return prev;
    }
  }
  return all[0];
}

function restoreFromCheckpoint(cp: Checkpoint): Omit<
  RecoveryResult,
  "action" | "success" | "detail" | "durationMs" | "plan" | "planSource"
> & { plan?: Plan; planSource?: "llm" | "deterministic_fallback" } {
  const state = cp.state;
  const completedSteps = Array.isArray(state.completedSteps)
    ? (state.completedSteps as string[])
    : [];
  const artifacts =
    state.artifacts && typeof state.artifacts === "object"
      ? ({ ...(state.artifacts as Record<string, unknown>) } as Record<
          string,
          unknown
        >)
      : {};
  const plan =
    state.plan && typeof state.plan === "object"
      ? (state.plan as Plan)
      : undefined;
  const planSource =
    state.planSource === "llm" || state.planSource === "deterministic_fallback"
      ? state.planSource
      : undefined;

  return {
    restoredCheckpointId: cp.id,
    completedSteps,
    artifacts,
    budgetConsumed: cp.budgetConsumed,
    checkpointIds: [cp.id],
    plan,
    planSource,
  };
}

export async function executeRecovery(input: {
  runId: string;
  task: string;
  severity: Severity;
  evaluation: PolicyEvaluation;
  snapshot: RunSnapshot;
  parentSpanContext: SpanContext;
  /** When true, re-plan prompt includes "avoid prior budget breach". */
  avoidDriftHint?: boolean;
  /** Force an action (e.g. human reject → rollback_replan). */
  actionOverride?: RecoveryAction;
}): Promise<RecoveryResult> {
  const started = Date.now();
  const action = input.actionOverride ?? decideRecoveryAction(input.severity);
  recordRecoveryAttempt(action, { "run.id": input.runId });

  if (action === "await_human") {
    return {
      action,
      success: false,
      restoredCheckpointId: null,
      plan: input.snapshot.plan,
      planSource: input.snapshot.planSource,
      completedSteps: input.snapshot.completedSteps,
      artifacts: input.snapshot.artifacts,
      budgetConsumed: input.snapshot.budgetConsumed,
      checkpointIds: input.snapshot.checkpointIds,
      detail: "awaiting human approval — no auto-recovery",
      durationMs: Date.now() - started,
    };
  }

  if (action === "continue") {
    return {
      action,
      success: true,
      restoredCheckpointId: null,
      plan: input.snapshot.plan,
      planSource: input.snapshot.planSource,
      completedSteps: input.snapshot.completedSteps,
      artifacts: input.snapshot.artifacts,
      budgetConsumed: input.snapshot.budgetConsumed,
      checkpointIds: input.snapshot.checkpointIds,
      detail: "severity low — no recovery",
      durationMs: Date.now() - started,
    };
  }

  if (action === "hard_stop") {
    recordRollbackOutcome(false, { "run.id": input.runId, action });
    noteRollbackAttempt(false);
    return {
      action,
      success: false,
      restoredCheckpointId: null,
      plan: input.snapshot.plan,
      planSource: input.snapshot.planSource,
      completedSteps: input.snapshot.completedSteps,
      artifacts: input.snapshot.artifacts,
      budgetConsumed: input.snapshot.budgetConsumed,
      checkpointIds: input.snapshot.checkpointIds,
      detail: "hard stop — no auto-resume",
      durationMs: Date.now() - started,
    };
  }

  let restoredCheckpointId: string | null = null;
  let completedSteps = [...input.snapshot.completedSteps];
  let artifacts = { ...input.snapshot.artifacts };
  let budgetConsumed = input.snapshot.budgetConsumed;
  let checkpointIds = [...input.snapshot.checkpointIds];
  let plan = input.snapshot.plan;
  let planSource = input.snapshot.planSource;

  try {
    if (action === "rollback_replan") {
      const cp = selectRollbackCheckpoint(
        input.runId,
        input.evaluation.stepId,
        input.snapshot.checkpointIds,
      );
      if (!cp) {
        throw new Error("No checkpoint available for rollback");
      }
      const restored = restoreFromCheckpoint(cp);
      restoredCheckpointId = restored.restoredCheckpointId;
      completedSteps = restored.completedSteps;
      artifacts = restored.artifacts;
      budgetConsumed = restored.budgetConsumed;
      checkpointIds = restored.checkpointIds;
      if (restored.plan) plan = restored.plan;
      if (restored.planSource) planSource = restored.planSource;

      await withChildSpan(
        input.parentSpanContext,
        SpanNames.CHECKPOINT_RESTORED,
        {
          "run.id": input.runId,
          "checkpoint.id": cp.id,
          "checkpoint.label": cp.label,
          "checkpoint.index": cp.index,
          "recovery.action": action,
          "policy.score": input.evaluation.score,
        },
        (span) => {
          span.addEvent("rollback.restored", {
            "completedSteps": completedSteps.join(","),
            "budgetConsumed": budgetConsumed,
          });
        },
      );
      console.log(
        `[recovery] rolled back run=${input.runId} → ${cp.id} (${cp.label})`,
      );
    }

    // Re-plan from restored goal + context
    const replanTask =
      input.avoidDriftHint || input.evaluation.score >= 40
        ? `${input.task} (re-plan after policy violation: stay strictly under budget; do not select luxury upgrades)`
        : input.task;
    const generated = await generatePlan(replanTask);
    plan = generated.plan;
    planSource = generated.source;

    await withChildSpan(
      input.parentSpanContext,
      SpanNames.RECOVERY_OUTCOME,
      {
        "run.id": input.runId,
        "recovery.action": action,
        "recovery.success": true,
        "checkpoint.id": restoredCheckpointId ?? "",
        "policy.score": input.evaluation.score,
      },
      (span) => {
        span.addEvent("recovery.replanned", {
          "plan.steps": plan.steps.length,
          "plan.maxBudget": plan.maxBudget,
          "plan.source": planSource,
        });
      },
    );

    const durationMs = Date.now() - started;
    recordRecoveryDurationMs(durationMs, { "run.id": input.runId, action });
    recordRollbackOutcome(true, { "run.id": input.runId, action });
    noteRollbackAttempt(true);

    return {
      action,
      success: true,
      restoredCheckpointId,
      plan,
      planSource,
      completedSteps,
      artifacts,
      budgetConsumed,
      checkpointIds,
      detail: `recovered via ${action}; restored=${restoredCheckpointId ?? "n/a"}`,
      durationMs,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const durationMs = Date.now() - started;
    recordRecoveryDurationMs(durationMs, { "run.id": input.runId, action });
    recordRollbackOutcome(false, { "run.id": input.runId, action });
    noteRollbackAttempt(false);
    await withChildSpan(
      input.parentSpanContext,
      SpanNames.RECOVERY_OUTCOME,
      {
        "run.id": input.runId,
        "recovery.action": action,
        "recovery.success": false,
        "policy.score": input.evaluation.score,
      },
      (span) => {
        span.addEvent("recovery.failed", { error: message.slice(0, 500) });
      },
    ).catch(() => undefined);

    return {
      action,
      success: false,
      restoredCheckpointId,
      plan: input.snapshot.plan,
      planSource: input.snapshot.planSource,
      completedSteps: input.snapshot.completedSteps,
      artifacts: input.snapshot.artifacts,
      budgetConsumed: input.snapshot.budgetConsumed,
      checkpointIds: input.snapshot.checkpointIds,
      detail: `recovery failed: ${message}`,
      durationMs,
    };
  }
}

export function markRunRecovered(runId: string): void {
  recordRecoveredExecution({ "run.id": runId });
  noteRecoveredExecution();
}
