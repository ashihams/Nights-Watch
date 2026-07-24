import { z } from "zod";
import { TravelToolSchema } from "./plan.js";

export const StepReportSchema = z.object({
  runId: z.string().min(1),
  stepId: z.string().min(1),
  tool: TravelToolSchema,
  status: z.enum(["success", "error"]),
  /** Artifacts produced by this Executor step (selected flight, price, etc.). */
  result: z.record(z.unknown()).default({}),
  errorMessage: z.string().optional(),
  /** Cost attributed to this step (tokens or dollars — travel uses USD price). */
  costUsd: z.number().nonnegative().default(0),
});
export type StepReport = z.infer<typeof StepReportSchema>;

export function parseStepReport(raw: unknown): StepReport {
  return StepReportSchema.parse(raw);
}
