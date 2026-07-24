/**
 * Supervisor — owns live execution state for a run.
 * Phase 1: receives n8n step reports, correlates them under one OTel trace.
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
  parentSpan: Span;
  parentSpanContext: SpanContext;
  startedAt: string;
}

const runs = new Map<string, ActiveRun>();

export function getRun(runId: string): ActiveRun | undefined {
  return runs.get(runId);
}

export function listRuns(): ActiveRun[] {
  return [...runs.values()].map((r) => ({
    ...r,
    // Don't serialize span objects in API responses later — use summary helper.
  }));
}

export function summarizeRun(run: ActiveRun) {
  return {
    runId: run.runId,
    task: run.task,
    status: run.status,
    planSource: run.planSource,
    plan: run.plan,
    completedSteps: run.completedSteps,
    startedAt: run.startedAt,
  };
}

/** Start a run: generate plan, open parent span, return run summary. */
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
    parentSpan,
    parentSpanContext: parentSpan.spanContext(),
    startedAt: new Date().toISOString(),
  };
  runs.set(runId, active);

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
  console.log(
    `[supervisor] step ${report.stepId} tool=${report.tool} status=${report.status} run=${report.runId}`,
  );

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
    });
    run.parentSpan.end();
    console.log(`[supervisor] run ${report.runId} completed`);
  }

  return summarizeRun(run);
}
