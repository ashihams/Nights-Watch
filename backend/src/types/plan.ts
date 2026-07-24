import { z } from "zod";

/** Tools the travel-booking Executor may call (hardcoded domain). */
export const TravelToolSchema = z.enum([
  "search_flights",
  "select_flight",
  "confirm_details",
  "book_flight",
]);
export type TravelTool = z.infer<typeof TravelToolSchema>;

export const PlanStepSchema = z.object({
  id: z.string().min(1),
  order: z.number().int().nonnegative(),
  description: z.string().min(1),
  expectedTool: TravelToolSchema,
  /** Scope / constraints for this step (e.g. maxPrice, origin, destination). */
  constraints: z.record(z.union([z.string(), z.number(), z.boolean()])).default({}),
});
export type PlanStep = z.infer<typeof PlanStepSchema>;

export const PlanSchema = z.object({
  goal: z.string().min(1),
  maxBudget: z.number().positive(),
  currency: z.string().default("USD"),
  origin: z.string().optional(),
  destination: z.string().optional(),
  steps: z.array(PlanStepSchema).min(1),
  /** Allowed targets/domains for later Policy Engine checks. */
  expectedTargets: z.array(z.string()).default(["flights"]),
});
export type Plan = z.infer<typeof PlanSchema>;

export function parsePlan(raw: unknown): Plan {
  return PlanSchema.parse(raw);
}
