/**
 * SigNoz Query API client — used by the Policy Engine for decision-support context.
 * Access pattern: Query API only (never MCP). Failures degrade to empty context;
 * they must not crash the Supervisor loop.
 */
import { config } from "../config/index.js";

export interface PriorPolicyContext {
  previousScores: number[];
  cumulativeBudgetHint: number | null;
  queried: boolean;
  error?: string;
}

const QUERY_TIMEOUT_MS = 4_000;

/**
 * Pull prior policy.evaluation span scores for this run from SigNoz.
 * Uses the self-hosted /api/v3/query_range (or v4) builder-style payload.
 * If SigNoz is down / UI flaky, returns queried=false and empty scores.
 */
export async function fetchPriorPolicyContext(
  runId: string,
): Promise<PriorPolicyContext> {
  const base = config.signoz.queryApiUrl.replace(/\/$/, "");
  const end = Date.now();
  const start = end - 6 * 60 * 60 * 1000; // last 6h

  // Builder query: count/avg of policy scores via trace attributes is fragile across
  // SigNoz versions — we request recent policy.evaluation spans filtered by run.id.
  const body = {
    start,
    end,
    step: 60,
    compositeQuery: {
      queryType: "builder",
      panelType: "list",
      builderQueries: {
        A: {
          dataSource: "traces",
          queryName: "A",
          aggregateOperator: "noop",
          filters: {
            items: [
              {
                key: { key: "service.name", dataType: "string", type: "resource" },
                op: "=",
                value: config.otel.serviceName,
              },
              {
                key: { key: "name", dataType: "string", type: "tag" },
                op: "=",
                value: "policy.evaluation",
              },
              {
                key: { key: "run.id", dataType: "string", type: "tag" },
                op: "=",
                value: runId,
              },
            ],
            op: "AND",
          },
          expression: "A",
          disabled: false,
        },
      },
    },
  };

  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (config.signoz.apiKey) {
    headers["SIGNOZ-API-KEY"] = config.signoz.apiKey;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), QUERY_TIMEOUT_MS);

  try {
    // Try v4 then v3 — self-host versions differ.
    for (const path of ["/api/v4/query_range", "/api/v3/query_range"]) {
      const res = await fetch(`${base}${path}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        if (res.status === 404) continue;
        return {
          previousScores: [],
          cumulativeBudgetHint: null,
          queried: true,
          error: `SigNoz ${path} → ${res.status}: ${text.slice(0, 200)}`,
        };
      }
      const json = (await res.json()) as unknown;
      const scores = extractScores(json);
      const budget = extractBudgetHint(json);
      console.log(
        `[signoz-query] ${path} run=${runId} priorScores=${scores.length} ok`,
      );
      return {
        previousScores: scores,
        cumulativeBudgetHint: budget,
        queried: true,
      };
    }
    return {
      previousScores: [],
      cumulativeBudgetHint: null,
      queried: true,
      error: "No supported SigNoz query_range endpoint responded",
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[signoz-query] degraded: ${message}`);
    return {
      previousScores: [],
      cumulativeBudgetHint: null,
      queried: false,
      error: message,
    };
  } finally {
    clearTimeout(timer);
  }
}

function extractScores(json: unknown): number[] {
  const scores: number[] = [];
  const walk = (node: unknown): void => {
    if (node == null) return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (typeof node !== "object") return;
    const obj = node as Record<string, unknown>;
    for (const [k, v] of Object.entries(obj)) {
      if (
        (k === "policy.score" || k === "policy_score" || k === "score") &&
        typeof v === "number"
      ) {
        scores.push(v);
      } else if (
        (k === "policy.score" || k === "policy_score") &&
        typeof v === "string" &&
        v.trim() !== "" &&
        !Number.isNaN(Number(v))
      ) {
        scores.push(Number(v));
      } else {
        walk(v);
      }
    }
  };
  walk(json);
  return scores;
}

function extractBudgetHint(json: unknown): number | null {
  let found: number | null = null;
  const walk = (node: unknown): void => {
    if (found != null || node == null) return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (typeof node !== "object") return;
    const obj = node as Record<string, unknown>;
    for (const [k, v] of Object.entries(obj)) {
      if (
        (k === "checkpoint.budgetConsumed" || k === "budgetConsumed") &&
        typeof v === "number"
      ) {
        found = v;
        return;
      }
      walk(v);
    }
  };
  walk(json);
  return found;
}
