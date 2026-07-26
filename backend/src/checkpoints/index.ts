/**
 * Checkpoint Manager — owns durable run state + emits correlated SigNoz spans.
 * Rollback (Phase 5) must read from this store, never from SigNoz.
 * Phase 7: auto pre-irreversible checkpoints via plan step constraints.
 */
import type { SpanContext } from "@opentelemetry/api";
import { randomUUID } from "node:crypto";
import { SpanNames, withChildSpan } from "../otel/index.js";
import type { Plan } from "../types/plan.js";
import type { Checkpoint, CheckpointMilestoneLabel } from "../types/checkpoint.js";
import { PRE_IRREVERSIBLE_LABEL } from "../types/checkpoint.js";
import {
  getCheckpointById,
  getLatestCheckpoint,
  listCheckpointsForRun,
  saveCheckpoint,
} from "./store.js";

export interface CreateCheckpointInput {
  runId: string;
  index: number;
  label: CheckpointMilestoneLabel | string;
  planStep: string;
  state: Record<string, unknown>;
  budgetConsumed: number;
  trustContext?: Record<string, unknown>;
  /** Optional explicit id; auto-generated uniquely when omitted. */
  id?: string;
  /** Parent run span — checkpoint.created becomes a child in the same trace. */
  parentSpanContext: SpanContext;
  /** Extra attributes on the checkpoint.created span. */
  spanAttributes?: Record<string, string | number | boolean>;
}

/** True when the plan step is tagged for an irreversible side effect (e.g. book). */
export function isIrreversiblePlanStep(
  plan: Plan,
  stepId: string,
): boolean {
  const step = plan.steps.find((s) => s.id === stepId);
  return step?.constraints?.irreversible === true;
}

/**
 * Whether we already snapshotted a pre-irreversible CP for this step at the
 * current completedSteps frontier (idempotent across prepare + step report).
 */
export function hasPreIrreversibleCheckpoint(
  runId: string,
  stepId: string,
  completedSteps: string[],
): boolean {
  const key = completedSteps.join(",");
  return listCheckpointsForRun(runId).some(
    (cp) =>
      cp.label === PRE_IRREVERSIBLE_LABEL &&
      cp.planStep === stepId &&
      ((cp.state.completedSteps as string[] | undefined) ?? []).join(",") === key,
  );
}

export async function createCheckpoint(
  input: CreateCheckpointInput,
): Promise<Checkpoint> {
  const timestamp = new Date().toISOString();
  // Unique id so post-recovery re-checkpoints at the same milestone don't collide.
  const id = input.id ?? `${input.runId}-cp-${input.index}-${randomUUID().slice(0, 8)}`;

  const checkpoint: Checkpoint = {
    id,
    runId: input.runId,
    index: input.index,
    label: input.label,
    planStep: input.planStep,
    state: input.state,
    budgetConsumed: input.budgetConsumed,
    timestamp,
    trustContext: input.trustContext ?? {
      sources: ["planner", "executor", "local-store"],
    },
  };

  // 1) Persist full object locally (source of truth for rollback).
  saveCheckpoint(checkpoint);

  // 2) Emit summary span to SigNoz (observability only — not for restore).
  await withChildSpan(
    input.parentSpanContext,
    SpanNames.CHECKPOINT_CREATED,
    {
      "checkpoint.id": checkpoint.id,
      "run.id": checkpoint.runId,
      "checkpoint.index": checkpoint.index,
      "checkpoint.label": checkpoint.label,
      "checkpoint.planStep": checkpoint.planStep,
      "checkpoint.budgetConsumed": checkpoint.budgetConsumed,
      "checkpoint.timestamp": checkpoint.timestamp,
      ...(input.spanAttributes ?? {}),
    },
    (span) => {
      span.addEvent("checkpoint.persisted", {
        "store": "sqlite",
        "state.keys": Object.keys(checkpoint.state).join(","),
      });
    },
  );

  console.log(
    `[checkpoint] saved ${checkpoint.id} label=${checkpoint.label} budget=${checkpoint.budgetConsumed}`,
  );
  return checkpoint;
}

export {
  listCheckpointsForRun,
  getCheckpointById,
  getLatestCheckpoint,
};
