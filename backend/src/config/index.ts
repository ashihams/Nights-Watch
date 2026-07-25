// Loads named constants and env. Thresholds stay here — never hardcoded in modules.
import { config as loadDotenv } from "dotenv";
import { resolve } from "node:path";

loadDotenv({ path: resolve(process.cwd(), "../.env") });
loadDotenv(); // also allow backend/.env

/** Policy score above this pauses execution for explanation / human review. */
export const PAUSE_THRESHOLD = Number(process.env.PAUSE_THRESHOLD ?? 40);

/** Policy score above this forces rollback rather than auto-replan alone. */
export const ROLLBACK_THRESHOLD = Number(process.env.ROLLBACK_THRESHOLD ?? 70);

/** Policy score above this hard-stops the run with no auto-resume. */
export const HARD_STOP_THRESHOLD = Number(process.env.HARD_STOP_THRESHOLD ?? 90);

/** Named policy rule weights (sum of fired weights → score, capped at 100). */
export const POLICY_WEIGHT_TOOL_MISMATCH = Number(
  process.env.POLICY_WEIGHT_TOOL_MISMATCH ?? 40,
); // wrong tool vs plan — high trust break
export const POLICY_WEIGHT_BUDGET_BREACH = Number(
  process.env.POLICY_WEIGHT_BUDGET_BREACH ?? 40,
); // over plan maxBudget — high
export const POLICY_WEIGHT_TARGET_MISMATCH = Number(
  process.env.POLICY_WEIGHT_TARGET_MISMATCH ?? 35,
); // target not in expectedTargets — high
export const POLICY_WEIGHT_STEP_ORDER = Number(
  process.env.POLICY_WEIGHT_STEP_ORDER ?? 25,
); // out-of-order / skip — medium
export const POLICY_WEIGHT_MINOR_PARAM = Number(
  process.env.POLICY_WEIGHT_MINOR_PARAM ?? 10,
); // small same-tool deviation — low

export const config = {
  port: Number(process.env.PORT ?? 3001),
  nodeEnv: process.env.NODE_ENV ?? "development",
  otel: {
    endpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "http://localhost:4318",
    headers: process.env.OTEL_EXPORTER_OTLP_HEADERS ?? "",
    serviceName: process.env.OTEL_SERVICE_NAME ?? "nights-watch",
  },
  signoz: {
    queryApiUrl: process.env.SIGNOZ_QUERY_API_URL ?? "http://localhost:8080",
    apiKey: process.env.SIGNOZ_API_KEY ?? "",
    mcpEndpoint: process.env.SIGNOZ_MCP_ENDPOINT ?? "http://localhost:8000",
    mcpToken: process.env.SIGNOZ_MCP_TOKEN ?? "",
  },
  n8n: {
    webhookBaseUrl: process.env.N8N_WEBHOOK_BASE_URL ?? "http://localhost:5678",
    apiKey: process.env.N8N_API_KEY ?? "",
  },
  llm: {
    provider: (process.env.LLM_PROVIDER ?? "anthropic") as "anthropic" | "openai",
    anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? "",
    openaiApiKey: process.env.OPENAI_API_KEY ?? "",
    model: process.env.LLM_MODEL ?? "claude-sonnet-4-20250514",
  },
  checkpointDbPath: process.env.CHECKPOINT_DB_PATH ?? "./data/checkpoints.sqlite",
  pauseThreshold: PAUSE_THRESHOLD,
  rollbackThreshold: ROLLBACK_THRESHOLD,
  hardStopThreshold: HARD_STOP_THRESHOLD,
  policyWeights: {
    toolMismatch: POLICY_WEIGHT_TOOL_MISMATCH,
    budgetBreach: POLICY_WEIGHT_BUDGET_BREACH,
    targetMismatch: POLICY_WEIGHT_TARGET_MISMATCH,
    stepOrder: POLICY_WEIGHT_STEP_ORDER,
    minorParam: POLICY_WEIGHT_MINOR_PARAM,
  },
} as const;
