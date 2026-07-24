/**
 * Supervisor — owns live execution state for a run.
 * Phase 2: also writes local checkpoints + correlated checkpoint.created spans.
 * Does not call SigNoz Query API or MCP (policy / explanation come later).
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
} from "../otel/index.js";
import { generatePlan } from "../planner/index.js";
import { createCheckpoint } from "../checkpoints/index.js";
import { CheckpointMilestones } from "../types/checkpoint.js";
import type { Plan } from "../types/plan.js";
import type { StepReport } from "../types/step-report.js";

export type RunStatus = "running" | "completed" | "failed";

export interface ActiveRun {
  runId: string;
  task: string;
  plan: Plan;
  planSource: "llm" | "deterministic_fallback";
  status: RunStatus;
  completedSteps: string[];
  /** Accumulated artifacts for checkpoint.state / resume. */
  artifacts: Record<string, unknown>;
  budgetConsumed: number;
  checkpointIds: string[];
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
    startedAt: run.startedAt,
  };
}

async function emitMilestoneCheckpoint(
  run: ActiveRun,
  milestone: (typeof CheckpointMilestones)[number],
): Promise<void> {
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
    },
    budgetConsumed: run.budgetConsumed,
    trustContext: {
      sources: ["planner", "executor", "local-store"],
      planSource: run.planSource,
    },
    parentSpanContext: run.parentSpanContext,
  });
  run.checkpointIds.push(cp.id);
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
    parentSpan,
    parentSpanContext: parentSpan.spanContext(),
    startedAt: new Date().toISOString(),
  };
  runs.set(runId, active);

  const planMilestone = CheckpointMilestones[0];
  await emitMilestoneCheckpoint(active, planMilestone);

  console.log(`[supervisor] started ${runId} planSource=${source} steps=${plan.steps.length}`);
  console.log(`[supervisor] plan:\n${JSON.stringify(plan, null, 2)}`);
  return summarizeRun(active);
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

  if (report.status === "success") {
    const milestone = CheckpointMilestones.find(
      (m) => m.afterStepId === report.stepId,
    );
    if (milestone) {
      await emitMilestoneCheckpoint(run, milestone);
    }
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
    run.parentSpan.setStatus({ code: SpanStatusCode.OK });
    run.parentSpan.addEvent("run.completed", {
      steps: run.completedSteps.join(","),
      checkpoints: run.checkpointIds.join(","),
    });
    run.parentSpan.end();
    console.log(
      `[supervisor] run ${report.runId} completed checkpoints=${run.checkpointIds.length}`,
    );
  }

  return summarizeRun(run);
}
