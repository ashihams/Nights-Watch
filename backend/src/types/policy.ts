import { z } from "zod";

export const RuleResultSchema = z.object({
  ruleName: z.string().min(1),
  fired: z.boolean(),
  weight: z.number().nonnegative(),
  detail: z.string(),
});
export type RuleResult = z.infer<typeof RuleResultSchema>;

export const PolicyEvaluationSchema = z.object({
  score: z.number().min(0).max(100),
  ruleTrace: z.array(RuleResultSchema),
  timestamp: z.string().min(1),
  checkpointId: z.string().min(1),
  runId: z.string().min(1),
  stepId: z.string().min(1),
});
export type PolicyEvaluation = z.infer<typeof PolicyEvaluationSchema>;

export function parsePolicyEvaluation(raw: unknown): PolicyEvaluation {
  return PolicyEvaluationSchema.parse(raw);
}
