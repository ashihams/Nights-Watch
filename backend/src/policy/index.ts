/**
 * Policy Engine — rule-based evaluation of each Executor step against the plan.
 * SigNoz access: Query API only (prior scores / budget context). Never MCP.
 *
 * Policy Score formula (inspectable):
 *   score = min(100, sum(weight for each fired rule))
 */
import {
  config,
  POLICY_WEIGHT_BUDGET_BREACH,
  POLICY_WEIGHT_MINOR_PARAM,
  POLICY_WEIGHT_STEP_ORDER,
  POLICY_WEIGHT_TARGET_MISMATCH,
  POLICY_WEIGHT_TOOL_MISMATCH,
} from "../config/index.js";
import { SpanNames, recordPolicyScore, withChildSpan } from "../otel/index.js";
import { fetchPriorPolicyContext } from "../signoz/query-client.js";
import type { Plan } from "../types/plan.js";
import type { StepReport } from "../types/step-report.js";
import type { PolicyEvaluation, RuleResult } from "../types/policy.js";
import type { SpanContext } from "@opentelemetry/api";

export interface EvaluateStepInput {
  runId: string;
  plan: Plan;
  report: StepReport;
  completedStepsBefore: string[];
  checkpointId: string;
  parentSpanContext: SpanContext;
  /** Optional declared target domain for this step (defaults to "flights"). */
  actionTarget?: string;
}

function evalToolMismatch(plan: Plan, report: StepReport): RuleResult {
  const expected = plan.steps.find((s) => s.id === report.stepId);
  const weight = POLICY_WEIGHT_TOOL_MISMATCH;
  if (!expected) {
    return {
      ruleName: "tool_mismatch",
      fired: true,
      weight,
      detail: `stepId=${report.stepId} not in plan`,
    };
  }
  const fired = expected.expectedTool !== report.tool;
  return {
    ruleName: "tool_mismatch",
    fired,
    weight,
    detail: fired
      ? `expected=${expected.expectedTool} actual=${report.tool}`
      : "tool matches plan",
  };
}

function evalBudgetBreach(plan: Plan, report: StepReport): RuleResult {
  const weight = POLICY_WEIGHT_BUDGET_BREACH;
  const fired = report.costUsd > plan.maxBudget;
  return {
    ruleName: "budget_breach",
    fired,
    weight,
    detail: fired
      ? `costUsd=${report.costUsd} exceeds maxBudget=${plan.maxBudget}`
      : `costUsd=${report.costUsd} within maxBudget=${plan.maxBudget}`,
  };
}

function evalTargetMismatch(plan: Plan, actionTarget: string): RuleResult {
  const weight = POLICY_WEIGHT_TARGET_MISMATCH;
  const allowed = plan.expectedTargets.length
    ? plan.expectedTargets
    : ["flights"];
  const fired = !allowed.includes(actionTarget);
  return {
    ruleName: "target_mismatch",
    fired,
    weight,
    detail: fired
      ? `target=${actionTarget} not in [${allowed.join(",")}]`
      : `target=${actionTarget} allowed`,
  };
}

function evalStepOrder(
  plan: Plan,
  report: StepReport,
  completedBefore: string[],
): RuleResult {
  const weight = POLICY_WEIGHT_STEP_ORDER;
  const ordered = [...plan.steps].sort((a, b) => a.order - b.order);
  const idx = ordered.findIndex((s) => s.id === report.stepId);
  if (idx === -1) {
    return {
      ruleName: "step_order_violation",
      fired: true,
      weight,
      detail: `unknown step ${report.stepId}`,
    };
  }
  // All previous plan steps must already be completed.
  const missing = ordered
    .slice(0, idx)
    .filter((s) => !completedBefore.includes(s.id))
    .map((s) => s.id);
  const fired = missing.length > 0;
  return {
    ruleName: "step_order_violation",
    fired,
    weight,
    detail: fired
      ? `skipped ahead; missing prior steps: ${missing.join(",")}`
      : "step order ok",
  };
}

function evalMinorParamDeviation(plan: Plan, report: StepReport): RuleResult {
  const weight = POLICY_WEIGHT_MINOR_PARAM;
  const expected = plan.steps.find((s) => s.id === report.stepId);
  if (!expected || expected.expectedTool !== report.tool) {
    return {
      ruleName: "minor_parameter_deviation",
      fired: false,
      weight,
      detail: "n/a (tool mismatch owns this case)",
    };
  }
  const maxPrice = expected.constraints.maxPrice;
  // Soft signal: price within 15% over step constraint but still under plan budget.
  if (
    typeof maxPrice === "number" &&
    report.costUsd > maxPrice &&
    report.costUsd <= plan.maxBudget
  ) {
    return {
      ruleName: "minor_parameter_deviation",
      fired: true,
      weight,
      detail: `costUsd=${report.costUsd} above step maxPrice=${maxPrice} but under plan budget`,
    };
  }
  return {
    ruleName: "minor_parameter_deviation",
    fired: false,
    weight,
    detail: "no minor deviation detected",
  };
}

/** Aggregate: sum fired weights, cap at 100. */
export function aggregatePolicyScore(ruleTrace: RuleResult[]): number {
  const sum = ruleTrace
    .filter((r) => r.fired)
    .reduce((acc, r) => acc + r.weight, 0);
  return Math.min(100, sum);
}

export async function evaluateStep(
  input: EvaluateStepInput,
): Promise<PolicyEvaluation> {
  const actionTarget = input.actionTarget ?? "flights";
  const prior = await fetchPriorPolicyContext(input.runId);

  const ruleTrace: RuleResult[] = [
    evalToolMismatch(input.plan, input.report),
    evalBudgetBreach(input.plan, input.report),
    evalTargetMismatch(input.plan, actionTarget),
    evalStepOrder(input.plan, input.report, input.completedStepsBefore),
    evalMinorParamDeviation(input.plan, input.report),
  ];

  // Mild uplift if prior scores this run were already elevated (real Query API context).
  let score = aggregatePolicyScore(ruleTrace);
  if (prior.queried && prior.previousScores.some((s) => s >= config.pauseThreshold)) {
    score = Math.min(100, score + 5);
    ruleTrace.push({
      ruleName: "prior_elevated_context",
      fired: true,
      weight: 5,
      detail: `SigNoz prior scores: [${prior.previousScores.join(",")}]`,
    });
    score = aggregatePolicyScore(ruleTrace);
  } else if (!prior.queried) {
    ruleTrace.push({
      ruleName: "signoz_query_degraded",
      fired: false,
      weight: 0,
      detail: prior.error ?? "SigNoz Query API unreachable; continuing on local rules",
    });
  }

  const evaluation: PolicyEvaluation = {
    score,
    ruleTrace,
    timestamp: new Date().toISOString(),
    checkpointId: input.checkpointId,
    runId: input.runId,
    stepId: input.report.stepId,
  };

  recordPolicyScore(score, {
    "run.id": input.runId,
    "step.id": input.report.stepId,
  });

  await withChildSpan(
    input.parentSpanContext,
    SpanNames.POLICY_EVALUATION,
    {
      "run.id": input.runId,
      "step.id": input.report.stepId,
      "checkpoint.id": input.checkpointId,
      "policy.score": score,
      "policy.firedCount": ruleTrace.filter((r) => r.fired).length,
      "signoz.queried": prior.queried,
    },
    (span) => {
      span.addEvent("policy.rule_trace", {
        "ruleTrace.json": JSON.stringify(ruleTrace).slice(0, 4000),
      });
      if (prior.error) {
        span.addEvent("signoz.query.degraded", { error: prior.error.slice(0, 500) });
      }
    },
  );

  console.log(
    `[policy] run=${input.runId} step=${input.report.stepId} score=${score} fired=${ruleTrace
      .filter((r) => r.fired)
      .map((r) => r.ruleName)
      .join(",") || "none"}`,
  );

  return evaluation;
}

export function severityForScore(score: number): "low" | "medium" | "high" | "hard_stop" {
  if (score >= config.hardStopThreshold) return "hard_stop";
  if (score >= config.rollbackThreshold) return "high";
  if (score >= config.pauseThreshold) return "medium";
  return "low";
}
