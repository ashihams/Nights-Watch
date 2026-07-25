/**
 * Explanation Layer — plain-language "why" for policy violations.
 * SigNoz access: MCP only (exploratory). Never Query API here.
 * Pushes explanations to the dashboard WebSocket feed.
 */
import { z } from "zod";
import type { SpanContext } from "@opentelemetry/api";
import { config } from "../config/index.js";
import { SpanNames, withChildSpan } from "../otel/index.js";
import { gatherMcpContext } from "../signoz/mcp-client.js";
import { broadcastExplanation } from "../api/ws-hub.js";
import type { Plan } from "../types/plan.js";
import type { PolicyEvaluation } from "../types/policy.js";
import type { StepReport } from "../types/step-report.js";

export const ExplanationSchema = z.object({
  text: z.string().min(1).max(600),
  mcpInvoked: z.boolean(),
  mcpOk: z.boolean(),
  source: z.enum(["llm", "deterministic_fallback"]),
});
export type Explanation = z.infer<typeof ExplanationSchema>;

function deterministicExplanation(input: {
  plan: Plan;
  evaluation: PolicyEvaluation;
  report: StepReport;
  mcpNote: string;
}): string {
  const fired = input.evaluation.ruleTrace
    .filter((r) => r.fired)
    .map((r) => r.detail)
    .join("; ");
  const sentence1 = `The agent planned to keep spend under $${input.plan.maxBudget}, but step "${input.report.stepId}" used tool ${input.report.tool} at $${input.report.costUsd} (policy score ${input.evaluation.score}).`;
  const sentence2 = fired
    ? `Rules fired: ${fired}. ${input.mcpNote}`
    : `No named rules beyond score aggregation. ${input.mcpNote}`;
  return `${sentence1} ${sentence2}`.slice(0, 500);
}

async function callLlmExplanation(prompt: string): Promise<string | null> {
  const hasKey =
    config.llm.provider === "openai"
      ? Boolean(config.llm.openaiApiKey)
      : Boolean(config.llm.anthropicApiKey);
  if (!hasKey) return null;

  const system =
    "You explain AI agent policy violations in 1-2 plain sentences. No markdown, no bullets.";

  try {
    if (config.llm.provider === "openai") {
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${config.llm.openaiApiKey}`,
        },
        body: JSON.stringify({
          model: config.llm.model.startsWith("gpt")
            ? config.llm.model
            : "gpt-4o-mini",
          messages: [
            { role: "system", content: system },
            { role: "user", content: prompt },
          ],
          max_tokens: 120,
        }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) return null;
      const data = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      return data.choices?.[0]?.message?.content?.trim() ?? null;
    }

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": config.llm.anthropicApiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: config.llm.model,
        max_tokens: 120,
        system,
        messages: [{ role: "user", content: prompt }],
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      content?: Array<{ type: string; text?: string }>;
    };
    return data.content?.find((c) => c.type === "text")?.text?.trim() ?? null;
  } catch {
    return null;
  }
}

/** Triggered when Policy Score crosses the pause threshold. */
export async function explainViolation(input: {
  runId: string;
  plan: Plan;
  evaluation: PolicyEvaluation;
  report: StepReport;
  parentSpanContext: SpanContext;
}): Promise<Explanation> {
  // 1) MCP context (required integration point — never Query API)
  const mcp = await gatherMcpContext({ runId: input.runId });
  const mcpInvoked = true; // gatherMcpContext always attempts the MCP path
  const mcpOk = mcp.ok;
  const mcpText = mcp.text;
  const mcpError = mcp.error;
  const mcpNote = mcpOk
    ? "SigNoz MCP supplied related-trace context."
    : `SigNoz MCP was invoked but returned no usable context (${mcpError ?? "empty"}).`;

  const prompt = [
    `Plan goal: ${input.plan.goal}`,
    `Plan maxBudget: $${input.plan.maxBudget}`,
    `Action: step=${input.report.stepId} tool=${input.report.tool} costUsd=${input.report.costUsd}`,
    `Policy score: ${input.evaluation.score}`,
    `Rule trace: ${JSON.stringify(input.evaluation.ruleTrace)}`,
    `MCP context (may be empty/error): ${mcpText.slice(0, 2000) || mcpError || "(none)"}`,
    "Write 1-2 plain sentences explaining the violation to a human operator.",
  ].join("\n");

  let text = await callLlmExplanation(prompt);
  let source: "llm" | "deterministic_fallback" = "llm";
  if (!text) {
    source = "deterministic_fallback";
    text = deterministicExplanation({
      plan: input.plan,
      evaluation: input.evaluation,
      report: input.report,
      mcpNote,
    });
  }

  const parts = text.split(/(?<=[.!?])\s+/).filter(Boolean);
  text = parts.slice(0, 2).join(" ").trim();

  const explanation = ExplanationSchema.parse({
    text,
    mcpInvoked,
    mcpOk,
    source,
  });

  await withChildSpan(
    input.parentSpanContext,
    SpanNames.POLICY_EXPLANATION,
    {
      "run.id": input.runId,
      "step.id": input.report.stepId,
      "checkpoint.id": input.evaluation.checkpointId,
      "policy.score": input.evaluation.score,
      "explanation.mcp_invoked": explanation.mcpInvoked,
      "explanation.mcp_ok": explanation.mcpOk,
      "explanation.source": explanation.source,
    },
    (span) => {
      span.addEvent("policy.explanation", {
        "explanation.text": explanation.text,
        "mcp.tool": mcp.toolName,
        "mcp.ok": explanation.mcpOk,
      });
      if (mcpError) {
        span.addEvent("signoz.mcp.degraded", {
          error: String(mcpError).slice(0, 500),
        });
      }
    },
  );

  broadcastExplanation({
    runId: input.runId,
    stepId: input.report.stepId,
    score: input.evaluation.score,
    text: explanation.text,
    mcpInvoked: explanation.mcpInvoked,
    mcpOk: explanation.mcpOk,
    timestamp: new Date().toISOString(),
  });

  console.log(
    `[explanation] run=${input.runId} mcpInvoked=${explanation.mcpInvoked} mcpOk=${explanation.mcpOk} source=${explanation.source} text=${explanation.text}`,
  );

  return explanation;
}
