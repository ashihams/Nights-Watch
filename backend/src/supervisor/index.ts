/**
 * Supervisor — owns live execution state for a run.
 * Phase 2: local checkpoints + checkpoint.created spans.
 * Phase 3: Policy Engine on each step (Query API for prior context).
 * Phase 4: Explanation Layer (SigNoz MCP + LLM) on pause threshold.
 * Phase 5: Recovery Engine (rollback from local store + re-plan + resume).
 * Phase 7: auto-checkpoint before plan steps tagged irreversible.
 */
import { randomUUID } from "node:crypto";
import {
  SpanStatusCode,
  type Span,
  type SpanContext,
} from "@opentelemetry/api";
import {
  SpanNames,
  startParentSpan,
  withChildSpan,
  recordViolationFlagged,
} from "../otel/index.js";
import { generatePlan } from "../planner/index.js";
import {
  createCheckpoint,
  hasPreIrreversibleCheckpoint,
  isIrreversiblePlanStep,
} from "../checkpoints/index.js";
import { evaluateStep, severityForScore } from "../policy/index.js";
import { explainViolation } from "../explanation/index.js";
import {
  executeRecovery,
  markRunRecovered,
} from "../recovery/index.js";
import {
  CheckpointMilestones,
  PRE_IRREVERSIBLE_LABEL,
} from "../types/checkpoint.js";
import type { Plan } from "../types/plan.js";
import type { StepReport } from "../types/step-report.js";
import type { PolicyEvaluation } from "../types/policy.js";
import type { Explanation } from "../explanation/index.js";
import { config } from "../config/index.js";
import {
  broadcastCheckpoint,
  broadcastRunUpdate,
} from "../api/ws-hub.js";

export type RunStatus =
  | "running"
  | "paused"
  | "completed"
  | "failed"
  | "hard_stopped"
  | "recovering";

export interface ActiveRun {
  runId: string;
  task: string;
  plan: Plan;
  planSource: "llm" | "deterministic_fallback";
  status: RunStatus;
  completedSteps: string[];
  artifacts: Record<string, unknown>;
  budgetConsumed: number;
  checkpointIds: string[];
  policyEvaluations: PolicyEvaluation[];
  lastPolicyScore: number;
  recoveryCount: number;
  recovered: boolean;
  lastRecoveryDetail?: string;
  lastRecoveryDurationMs?: number;
  lastRestoredCheckpointId?: string;
  lastExplanation?: Explanation;
  parentSpan: Span;
  parentSpanContext: SpanContext;
  startedAt: string;
}

const runs = new Map<string, ActiveRun>();

export function getRun(runId: string): ActiveRun | undefined {
  return runs.get(runId);
}

export function listRuns(): ActiveRun[] {
  return [...runs.values()];
}

export function summarizeRun(run: ActiveRun) {
  return {
    runId: run.runId,
    task: run.task,
    status: run.status,
    planSource: run.planSource,
    plan: run.plan,
    completedSteps: run.completedSteps,
    budgetConsumed: run.budgetConsumed,
    checkpointIds: run.checkpointIds,
    lastPolicyScore: run.lastPolicyScore,
    recoveryCount: run.recoveryCount,
    recovered: run.recovered,
    lastRecoveryDetail: run.lastRecoveryDetail,
    lastRecoveryDurationMs: run.lastRecoveryDurationMs,
    lastRestoredCheckpointId: run.lastRestoredCheckpointId,
    lastExplanation: run.lastExplanation,
    artifacts: run.artifacts,
    policyEvaluations: run.policyEvaluations.map((e) => ({
      stepId: e.stepId,
      score: e.score,
      checkpointId: e.checkpointId,
      fired: e.ruleTrace.filter((r) => r.fired).map((r) => r.ruleName),
      timestamp: e.timestamp,
    })),
    startedAt: run.startedAt,
  };
}

function publishRun(run: ActiveRun): ReturnType<typeof summarizeRun> {
  const summary = summarizeRun(run);
  broadcastRunUpdate(summary as unknown as Record<string, unknown>);
  return summary;
}

async function emitMilestoneCheckpoint(
  run: ActiveRun,
  milestone: (typeof CheckpointMilestones)[number],
): Promise<string> {
  const cp = await createCheckpoint({
    runId: run.runId,
    index: milestone.index,
    label: milestone.label,
    planStep: milestone.planStep,
    state: {
      task: run.task,
      plan: run.plan,
      planSource: run.planSource,
      completedSteps: [...run.completedSteps],
      artifacts: { ...run.artifacts },
      status: run.status,
      lastPolicyScore: run.lastPolicyScore,
    },
    budgetConsumed: run.budgetConsumed,
    trustContext: {
      sources: ["planner", "executor", "local-store", "policy-engine", "recovery"],
      planSource: run.planSource,
    },
    parentSpanContext: run.parentSpanContext,
  });
  run.checkpointIds.push(cp.id);
  broadcastCheckpoint({
    runId: run.runId,
    checkpointId: cp.id,
    label: cp.label,
    index: cp.index,
    timestamp: cp.timestamp,
  });
  return cp.id;
}

/**
 * Snapshot safe state immediately before an irreversible plan step.
 * Independent of CheckpointMilestones — driven only by constraints.irreversible.
 * Idempotent for the same (stepId, completedSteps) frontier.
 */
async function ensurePreIrreversibleCheckpoint(
  run: ActiveRun,
  stepId: string,
): Promise<string | null> {
  if (!isIrreversiblePlanStep(run.plan, stepId)) return null;
  if (hasPreIrreversibleCheckpoint(run.runId, stepId, run.completedSteps)) {
    return null;
  }

  const cp = await createCheckpoint({
    runId: run.runId,
    index: run.checkpointIds.length,
    label: PRE_IRREVERSIBLE_LABEL,
    planStep: stepId,
    state: {
      task: run.task,
      plan: run.plan,
      planSource: run.planSource,
      completedSteps: [...run.completedSteps],
      artifacts: { ...run.artifacts },
      status: run.status,
      lastPolicyScore: run.lastPolicyScore,
      preIrreversibleFor: stepId,
    },
    budgetConsumed: run.budgetConsumed,
    trustContext: {
      sources: ["planner", "executor", "local-store", "checkpoint-manager"],
      planSource: run.planSource,
      reason: "pre_irreversible",
      irreversibleStepId: stepId,
    },
    parentSpanContext: run.parentSpanContext,
    spanAttributes: {
      "checkpoint.preIrreversible": true,
      "checkpoint.irreversibleStepId": stepId,
    },
  });
  run.checkpointIds.push(cp.id);
  run.parentSpan.addEvent("checkpoint.pre_irreversible", {
    "checkpoint.id": cp.id,
    "step.id": stepId,
  });
  broadcastCheckpoint({
    runId: run.runId,
    checkpointId: cp.id,
    label: cp.label,
    index: cp.index,
    timestamp: cp.timestamp,
  });
  console.log(
    `[supervisor] pre-irreversible checkpoint ${cp.id} before step=${stepId}`,
  );
  return cp.id;
}

/**
 * Executor call-site: create a pre-irreversible checkpoint before running the step.
 * Safe no-op when the step is not tagged irreversible.
 */
export async function prepareStep(
  runId: string,
  stepId: string,
): Promise<ReturnType<typeof summarizeRun>> {
  const run = runs.get(runId);
  if (!run) throw new Error(`Unknown runId: ${runId}`);
  if (run.status !== "running") {
    throw new Error(`Run ${runId} is ${run.status}`);
  }
  await ensurePreIrreversibleCheckpoint(run, stepId);
  return publishRun(run);
}

/** Start a run: generate plan, open parent span, checkpoint plan_generated. */
export async function startRun(task: string): Promise<ReturnType<typeof summarizeRun>> {
  const runId = `run-${randomUUID().slice(0, 8)}`;
  const { plan, source } = await generatePlan(task);

  const parentSpan = startParentSpan(SpanNames.RUN_EXECUTE, {
    "run.id": runId,
    "run.task": task.slice(0, 200),
    "plan.maxBudget": plan.maxBudget,
    "plan.steps": plan.steps.length,
    "plan.source": source,
  });
  parentSpan.addEvent("plan.ready", {
    "plan.json": JSON.stringify(plan).slice(0, 4000),
  });

  const active: ActiveRun = {
    runId,
    task,
    plan,
    planSource: source,
    status: "running",
    completedSteps: [],
    artifacts: {},
    budgetConsumed: 0,
    checkpointIds: [],
    policyEvaluations: [],
    lastPolicyScore: 0,
    recoveryCount: 0,
    recovered: false,
    parentSpan,
    parentSpanContext: parentSpan.spanContext(),
    startedAt: new Date().toISOString(),
  };
  runs.set(runId, active);

  const planMilestone = CheckpointMilestones[0];
  await emitMilestoneCheckpoint(active, planMilestone);

  console.log(`[supervisor] started ${runId} planSource=${source} steps=${plan.steps.length}`);
  console.log(`[supervisor] plan:\n${JSON.stringify(plan, null, 2)}`);
  return publishRun(active);
}

/** Record an Executor step completion as a child span of the run. */
export async function recordStepReport(
  report: StepReport,
): Promise<ReturnType<typeof summarizeRun>> {
  const run = runs.get(report.runId);
  if (!run) {
    throw new Error(`Unknown runId: ${report.runId}`);
  }
  if (run.status !== "running") {
    throw new Error(`Run ${report.runId} is ${run.status}`);
  }

  const completedBefore = [...run.completedSteps];

  // Safety net: even if the Executor skipped prepareStep, snapshot before
  // applying an irreversible step's results to run state.
  await ensurePreIrreversibleCheckpoint(run, report.stepId);

  await withChildSpan(
    run.parentSpanContext,
    SpanNames.EXECUTOR_STEP,
    {
      "run.id": report.runId,
      "step.id": report.stepId,
      "step.tool": report.tool,
      "step.status": report.status,
      "step.costUsd": report.costUsd,
    },
    (span) => {
      span.addEvent("step.result", {
        "result.json": JSON.stringify(report.result).slice(0, 2000),
      });
      if (report.status === "error") {
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: report.errorMessage ?? "step failed",
        });
      }
    },
  );

  run.completedSteps.push(report.stepId);
  run.artifacts[report.stepId] = report.result;
  run.budgetConsumed += report.costUsd;

  console.log(
    `[supervisor] step ${report.stepId} tool=${report.tool} status=${report.status} run=${report.runId}`,
  );

  let checkpointId =
    run.checkpointIds[run.checkpointIds.length - 1] ?? `${run.runId}-cp-0`;

  if (report.status === "success") {
    const milestone = CheckpointMilestones.find(
      (m) => m.afterStepId === report.stepId,
    );
    if (milestone) {
      checkpointId = await emitMilestoneCheckpoint(run, milestone);
    }
  }

  const evaluation = await evaluateStep({
    runId: run.runId,
    plan: run.plan,
    report,
    completedStepsBefore: completedBefore,
    checkpointId,
    parentSpanContext: run.parentSpanContext,
  });
  run.policyEvaluations.push(evaluation);
  run.lastPolicyScore = evaluation.score;

  if (evaluation.score > 0) {
    recordViolationFlagged(false, {
      "run.id": run.runId,
      "step.id": report.stepId,
    });
  }

  const severity = severityForScore(evaluation.score);

  if (severity === "hard_stop") {
    run.status = "hard_stopped";
    run.parentSpan.setStatus({
      code: SpanStatusCode.ERROR,
      message: `hard stop: policy score ${evaluation.score} >= ${config.hardStopThreshold}`,
    });
    run.parentSpan.addEvent("run.hard_stopped", {
      "policy.score": evaluation.score,
      step: report.stepId,
    });
    run.parentSpan.end();
    console.log(
      `[supervisor] HARD STOP run=${run.runId} score=${evaluation.score}`,
    );
    return publishRun(run);
  }

  if (severity === "medium" || severity === "high") {
    // Phase 4: explain before recovery (MCP + LLM)
    try {
      run.lastExplanation = await explainViolation({
        runId: run.runId,
        plan: run.plan,
        evaluation,
        report,
        parentSpanContext: run.parentSpanContext,
      });
    } catch (err) {
      console.warn("[supervisor] explanation failed:", err);
    }

    run.status = "recovering";
    publishRun(run);
    run.parentSpan.addEvent("run.recovery_started", {
      "policy.score": evaluation.score,
      severity,
      step: report.stepId,
    });
    console.log(
      `[supervisor] recovering run=${run.runId} score=${evaluation.score} severity=${severity}`,
    );

    const recovery = await executeRecovery({
      runId: run.runId,
      task: run.task,
      severity,
      evaluation,
      snapshot: {
        task: run.task,
        plan: run.plan,
        planSource: run.planSource,
        completedSteps: run.completedSteps,
        artifacts: run.artifacts,
        budgetConsumed: run.budgetConsumed,
        checkpointIds: run.checkpointIds,
        status: run.status,
      },
      parentSpanContext: run.parentSpanContext,
      avoidDriftHint: true,
    });

    run.recoveryCount += 1;
    run.lastRecoveryDetail = recovery.detail;
    run.lastRecoveryDurationMs = recovery.durationMs;
    run.lastRestoredCheckpointId = recovery.restoredCheckpointId ?? undefined;

    if (!recovery.success) {
      run.status = "paused";
      run.parentSpan.addEvent("run.paused", {
        "policy.score": evaluation.score,
        severity,
        reason: recovery.detail,
      });
      console.log(`[supervisor] recovery FAILED — paused: ${recovery.detail}`);
      return publishRun(run);
    }

    run.plan = recovery.plan;
    run.planSource = recovery.planSource;
    run.completedSteps = recovery.completedSteps;
    run.artifacts = recovery.artifacts;
    run.budgetConsumed = recovery.budgetConsumed;
    run.checkpointIds = recovery.checkpointIds;
    run.recovered = true;
    run.status = "running";
    run.lastRecoveryDetail = recovery.detail;
    // Keep lastExplanation for API/WS consumers; harness reads it on the pause step.
    run.parentSpan.addEvent("run.resumed", {
      "recovery.action": recovery.action,
      "checkpoint.id": recovery.restoredCheckpointId ?? "",
      "completedSteps": recovery.completedSteps.join(","),
      "durationMs": recovery.durationMs,
    });
    console.log(
      `[supervisor] RESUMED run=${run.runId} via ${recovery.action} restored=${recovery.restoredCheckpointId} steps=[${recovery.completedSteps.join(",")}]`,
    );
    return publishRun(run);
  }

  const expected = [...run.plan.steps].sort((a, b) => a.order - b.order);
  const allDone = expected.every((s) => run.completedSteps.includes(s.id));
  if (report.status === "error") {
    run.status = "failed";
    run.parentSpan.setStatus({
      code: SpanStatusCode.ERROR,
      message: report.errorMessage ?? "executor step failed",
    });
    run.parentSpan.end();
  } else if (allDone) {
    run.status = "completed";
    if (run.recovered || run.recoveryCount > 0) {
      markRunRecovered(run.runId);
    }
    run.parentSpan.setStatus({ code: SpanStatusCode.OK });
    run.parentSpan.addEvent("run.completed", {
      steps: run.completedSteps.join(","),
      checkpoints: run.checkpointIds.join(","),
      "policy.lastScore": run.lastPolicyScore,
      "recovery.count": run.recoveryCount,
    });
    run.parentSpan.end();
    console.log(
      `[supervisor] run ${report.runId} completed checkpoints=${run.checkpointIds.length} recoveries=${run.recoveryCount} lastScore=${run.lastPolicyScore}`,
    );
  }

  return publishRun(run);
}
