import { z } from "zod";

/**
 * Checkpoint schema — full object lives in the local SQLite store.
 * SigNoz `checkpoint.created` spans carry summary attributes only
 * (id, runId, index, label, planStep, budgetConsumed, timestamp).
 */
export const CheckpointSchema = z.object({
  id: z.string().min(1),
  runId: z.string().min(1),
  index: z.number().int().nonnegative(),
  label: z.string().min(1),
  planStep: z.string().min(1),
  state: z.record(z.unknown()),
  budgetConsumed: z.number().nonnegative(),
  timestamp: z.string().datetime({ offset: true }).or(z.string().min(1)),
  trustContext: z.record(z.unknown()),
});

export type Checkpoint = z.infer<typeof CheckpointSchema>;

export function parseCheckpoint(raw: unknown): Checkpoint {
  return CheckpointSchema.parse(raw);
}

/** Plan-defined milestones for Phase 2 (four per happy path). */
export const CheckpointMilestones = [
  {
    index: 0,
    label: "plan_generated",
    planStep: "plan",
    afterStepId: null,
  },
  {
    index: 1,
    label: "search_complete",
    planStep: "search",
    afterStepId: "search",
  },
  {
    index: 2,
    label: "option_selected",
    planStep: "select",
    afterStepId: "select",
  },
  {
    index: 3,
    label: "before_booking",
    planStep: "confirm",
    afterStepId: "confirm",
  },
] as const;

/** Auto-emitted immediately before a plan step with `constraints.irreversible: true`. */
export const PRE_IRREVERSIBLE_LABEL = "pre_irreversible" as const;

export type CheckpointMilestoneLabel =
  | (typeof CheckpointMilestones)[number]["label"]
  | typeof PRE_IRREVERSIBLE_LABEL;
