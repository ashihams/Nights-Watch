/**
 * Planner — single responsibility: turn a user task string into a validated Plan.
 * Uses the LLM provider when configured; otherwise a deterministic travel-booking
 * fallback so Phase 1 plumbing can be verified without an API key.
 * Does not call SigNoz (Query API or MCP).
 */
import { config } from "../config/index.js";
import { parsePlan, type Plan } from "../types/plan.js";
import { withSpan, SpanNames } from "../otel/index.js";

const PLANNER_SYSTEM = `You are the Nights Watch Planner for a travel-booking agent.
Return ONLY valid JSON matching this shape (no markdown):
{
  "goal": string,
  "maxBudget": number,
  "currency": "USD",
  "origin": string | optional,
  "destination": string | optional,
  "expectedTargets": ["flights"],
  "steps": [
    {
      "id": string,
      "order": number,
      "description": string,
      "expectedTool": "search_flights" | "select_flight" | "confirm_details" | "book_flight",
      "constraints": object
    }
  ]
}
Always produce exactly four steps in order: search_flights → select_flight → confirm_details → book_flight.
Extract a max budget from the task when stated (default 400). Prefer flights under that budget.`;

function deterministicTravelPlan(task: string): Plan {
  const budgetMatch = task.match(/\$?\s*(\d{2,5})\b/);
  const maxBudget = budgetMatch ? Number(budgetMatch[1]) : 400;
  const fromMatch = task.match(/\bfrom\s+([A-Za-z\s]+?)(?:\s+to\b|$)/i);
  const toMatch = task.match(/\bto\s+([A-Za-z\s]+?)(?:\s+under\b|\s+for\b|$)/i);

  return parsePlan({
    goal: task.trim(),
    maxBudget,
    currency: "USD",
    origin: fromMatch?.[1]?.trim() || "SFO",
    destination: toMatch?.[1]?.trim() || "LAX",
    expectedTargets: ["flights"],
    steps: [
      {
        id: "search",
        order: 0,
        description: "Search flights within budget",
        expectedTool: "search_flights",
        constraints: { maxPrice: maxBudget },
      },
      {
        id: "select",
        order: 1,
        description: "Select an in-budget flight option",
        expectedTool: "select_flight",
        constraints: { maxPrice: maxBudget },
      },
      {
        id: "confirm",
        order: 2,
        description: "Confirm passenger and itinerary details",
        expectedTool: "confirm_details",
        constraints: {},
      },
      {
        id: "book",
        order: 3,
        description: "Book the confirmed flight",
        expectedTool: "book_flight",
        constraints: { irreversible: true },
      },
    ],
  });
}

async function callAnthropic(task: string): Promise<unknown> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": config.llm.anthropicApiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: config.llm.model,
      max_tokens: 1024,
      system: PLANNER_SYSTEM,
      messages: [{ role: "user", content: task }],
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Anthropic planner failed (${res.status}): ${body}`);
  }
  const data = (await res.json()) as {
    content?: Array<{ type: string; text?: string }>;
  };
  const text = data.content?.find((c) => c.type === "text")?.text ?? "";
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("Planner LLM returned no JSON object");
  return JSON.parse(jsonMatch[0]) as unknown;
}

async function callOpenAI(task: string): Promise<unknown> {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.llm.openaiApiKey}`,
    },
    body: JSON.stringify({
      model: config.llm.model.startsWith("gpt") ? config.llm.model : "gpt-4o-mini",
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: PLANNER_SYSTEM },
        { role: "user", content: task },
      ],
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OpenAI planner failed (${res.status}): ${body}`);
  }
  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const text = data.choices?.[0]?.message?.content ?? "";
  return JSON.parse(text) as unknown;
}

/** Generate a structured Plan for the travel-booking scenario. */
export async function generatePlan(task: string): Promise<{
  plan: Plan;
  source: "llm" | "deterministic_fallback";
}> {
  return withSpan(
    SpanNames.PLAN_GENERATED,
    {
      "planner.task": task.slice(0, 200),
      "planner.provider": config.llm.provider,
    },
    async (span) => {
      const hasKey =
        config.llm.provider === "openai"
          ? Boolean(config.llm.openaiApiKey)
          : Boolean(config.llm.anthropicApiKey);

      if (!hasKey) {
        const plan = deterministicTravelPlan(task);
        span.setAttribute("planner.source", "deterministic_fallback");
        span.setAttribute("plan.maxBudget", plan.maxBudget);
        span.setAttribute("plan.steps", plan.steps.length);
        console.log("[planner] no LLM key — using deterministic travel plan");
        return { plan, source: "deterministic_fallback" as const };
      }

      try {
        const raw =
          config.llm.provider === "openai"
            ? await callOpenAI(task)
            : await callAnthropic(task);
        const plan = parsePlan(raw);
        span.setAttribute("planner.source", "llm");
        span.setAttribute("plan.maxBudget", plan.maxBudget);
        span.setAttribute("plan.steps", plan.steps.length);
        return { plan, source: "llm" as const };
      } catch (err) {
        console.warn("[planner] LLM failed, falling back:", err);
        span.addEvent("planner.llm_failed", {
          message: err instanceof Error ? err.message : String(err),
        });
        const plan = deterministicTravelPlan(task);
        span.setAttribute("planner.source", "deterministic_fallback");
        return { plan, source: "deterministic_fallback" as const };
      }
    },
  );
}
