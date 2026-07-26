/**
 * Supervisor — owns live execution state for a run.
 * Phase 2: local checkpoints + checkpoint.created spans.
 * Phase 3: Policy Engine on each step (Query API for prior context).
 * Phase 4: Explanation Layer (SigNoz MCP + LLM) on pause threshold.
 * Phase 5: Recovery Engine (rollback from local store + re-plan + resume).
 * Phase 7: auto-checkpoint before irreversible steps; human approval on medium.
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
  type Severity,
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
  broadcastExplanation,
  broadcastRunUpdate,
} from "../api/ws-hub.js";

export type RunStatus =
  | "running"
  | "paused"
  | "awaiting_approval"
  | "completed"
  | "failed"
  | "hard_stopped"
  | "recovering";

export type HumanDecision = "approve" | "reject";

export interface PendingApproval {
  stepId: string;
  score: number;
  evaluation: PolicyEvaluation;
}

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
  pendingApproval?: PendingApproval;
  lastHumanDecision?: HumanDecision;
  /**
   * After an operator approves a medium pause, further medium pauses on this
   * run are skipped (e.g. book of an already-approved over-budget selection).
   * High / hard_stop still fire. Cleared on reject→recovery.
   */
  mediumApprovalGranted?: boolean;
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
    awaitingApproval: run.status === "awaiting_approval",
    pendingApproval: run.pendingApproval
      ? {
          stepId: run.pendingApproval.stepId,
          score: run.pendingApproval.score,
        }
      : null,
    lastHumanDecision: run.lastHumanDecision,
    mediumApprovalGranted: !!run.mediumApprovalGranted,
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

/** Live explanation-feed line (same WS channel as Phase 4/6 violation explanations). */
function pushFeedEvent(
  run: ActiveRun,
  stepId: string,
  score: number,
  text: string,
  opts?: { mcpInvoked?: boolean; mcpOk?: boolean },
): void {
  broadcastExplanation({
    runId: run.runId,
    stepId,
    score,
    text,
    mcpInvoked: opts?.mcpInvoked ?? false,
    mcpOk: opts?.mcpOk ?? true,
    timestamp: new Date().toISOString(),
  });
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
    pushFeedEvent(
      run,
      report.stepId,
      evaluation.score,
      `Hard stop on step "${report.stepId}" — policy score ${evaluation.score} breached the ceiling. Run halted.`,
    );
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
    // Operator already approved an earlier medium pause → do not re-prompt
    // (keeps approve→book of the same over-budget choice from looping).
    if (severity === "medium" && run.mediumApprovalGranted) {
      pushFeedEvent(
        run,
        report.stepId,
        evaluation.score,
        `Step "${report.stepId}" still scores ${evaluation.score}, but continues under prior human approval (no second pause).`,
      );
      run.parentSpan.addEvent("run.medium_bypassed", {
        "policy.score": evaluation.score,
        step: report.stepId,
        reason: "human_approved_earlier",
      });
      console.log(
        `[supervisor] medium bypassed (prior approve) run=${run.runId} step=${report.stepId} score=${evaluation.score}`,
      );
    } else {
      // Phase 4: explain before pause / recovery (MCP + LLM) — also WS-broadcasts
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
        pushFeedEvent(
          run,
          report.stepId,
          evaluation.score,
          `Policy score ${evaluation.score} on step "${report.stepId}" (explanation layer failed).`,
        );
      }

      // Phase 7: medium → pause for human approve/reject
      if (severity === "medium") {
        pushFeedEvent(
          run,
          "approval",
          evaluation.score,
          `Paused for human approval on step "${report.stepId}" (score ${evaluation.score}). Reject to roll back, or approve to continue.`,
        );
        run.pendingApproval = {
          stepId: report.stepId,
          score: evaluation.score,
          evaluation,
        };
        run.status = "awaiting_approval";
        run.parentSpan.addEvent("run.awaiting_approval", {
          "policy.score": evaluation.score,
          severity,
          step: report.stepId,
        });
        console.log(
          `[supervisor] AWAITING APPROVAL run=${run.runId} score=${evaluation.score} step=${report.stepId}`,
        );
        return publishRun(run);
      }

      // high → automatic rollback + re-plan
      return applyRecovery(run, evaluation, "high");
    }
  } else {
    // low — narrate every in-policy step so the feed tracks the timeline (Phase 6 feel)
    pushFeedEvent(
      run,
      report.stepId,
      evaluation.score,
      `Step "${report.stepId}" completed in policy (score ${evaluation.score}, tool ${report.tool}).`,
    );
  }

  const expected = [...run.plan.steps].sort((a, b) => a.order - b.order);
  const allDone = expected.every((s) => run.completedSteps.includes(s.id));
  if (report.status === "error") {
    pushFeedEvent(
      run,
      report.stepId,
      evaluation.score,
      `Step "${report.stepId}" failed: ${report.errorMessage ?? "executor error"}.`,
    );
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
    pushFeedEvent(
      run,
      "complete",
      run.lastPolicyScore,
      run.recovered
        ? `Run completed after recovery (${run.recoveryCount} attempt(s)). Original goal finished in scope.`
        : `Run completed cleanly. All plan steps finished in policy.`,
    );
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

async function applyRecovery(
  run: ActiveRun,
  evaluation: PolicyEvaluation,
  severity: Severity,
  actionOverride?: "rollback_replan",
): Promise<ReturnType<typeof summarizeRun>> {
  run.status = "recovering";
  publishRun(run);
  run.parentSpan.addEvent("run.recovery_started", {
    "policy.score": evaluation.score,
    severity,
    step: evaluation.stepId,
    ...(actionOverride ? { "recovery.actionOverride": actionOverride } : {}),
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
    actionOverride,
  });

  run.recoveryCount += 1;
  run.lastRecoveryDetail = recovery.detail;
  run.lastRecoveryDurationMs = recovery.durationMs;
  run.lastRestoredCheckpointId = recovery.restoredCheckpointId ?? undefined;

  if (!recovery.success) {
    pushFeedEvent(
      run,
      "recovery",
      evaluation.score,
      `Recovery failed: ${recovery.detail}. Run paused.`,
    );
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
  pushFeedEvent(
    run,
    "recovery",
    evaluation.score,
    `Recovered via ${recovery.action}; restored=${recovery.restoredCheckpointId ?? "n/a"}. Resuming from steps [${recovery.completedSteps.join(", ") || "none"}].`,
  );
  run.parentSpan.addEvent("run.resumed", {
    "recovery.action": recovery.action,
    "checkpoint.id": recovery.restoredCheckpointId ?? "",
    completedSteps: recovery.completedSteps.join(","),
    durationMs: recovery.durationMs,
  });
  console.log(
    `[supervisor] RESUMED run=${run.runId} via ${recovery.action} restored=${recovery.restoredCheckpointId} steps=[${recovery.completedSteps.join(",")}]`,
  );
  return publishRun(run);
}

/**
 * Human approve/reject for medium-severity pauses (Phase 7).
 * approve → continue with current state; reject → rollback + re-plan.
 */
export async function resolveHumanDecision(
  runId: string,
  decision: HumanDecision,
): Promise<ReturnType<typeof summarizeRun>> {
  const run = runs.get(runId);
  if (!run) throw new Error(`Unknown runId: ${runId}`);
  if (run.status !== "awaiting_approval" || !run.pendingApproval) {
    throw new Error(
      `Run ${runId} is not awaiting approval (status=${run.status})`,
    );
  }

  const pending = run.pendingApproval;
  run.lastHumanDecision = decision;
  run.parentSpan.addEvent("human.decision", {
    decision,
    "run.id": run.runId,
    "step.id": pending.stepId,
    "policy.score": pending.score,
  });
  console.log(
    `[supervisor] human decision=${decision} run=${run.runId} step=${pending.stepId}`,
  );

  if (decision === "approve") {
    run.pendingApproval = undefined;
    run.mediumApprovalGranted = true;
    run.status = "running";
    run.lastRecoveryDetail = `human approved step ${pending.stepId} (score ${pending.score}) — continuing; further medium pauses bypassed`;
    pushFeedEvent(
      run,
      "approval",
      pending.score,
      `Operator approved step "${pending.stepId}" (score ${pending.score}) — continuing; further medium pauses bypassed for this run.`,
    );
    run.parentSpan.addEvent("run.resumed", {
      "recovery.action": "human_approve",
      "step.id": pending.stepId,
    });
    return publishRun(run);
  }

  run.pendingApproval = undefined;
  run.mediumApprovalGranted = false;
  pushFeedEvent(
    run,
    "approval",
    pending.score,
    `Operator rejected step "${pending.stepId}" (score ${pending.score}) — rolling back to last safe checkpoint and re-planning.`,
  );
  return applyRecovery(run, pending.evaluation, "medium", "rollback_replan");
}
