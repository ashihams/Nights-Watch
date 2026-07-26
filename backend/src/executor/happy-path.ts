/**
 * CLI entry for the shared demo sequence.
 * Run:
 *   npm run happy-path
 *   npm run happy-path:drift
 *
 * Orchestration lives in demo-sequence.ts (also used by POST /runs/demo).
 */
import { initOtel, shutdownOtel } from "../otel/index.js";
import { config } from "../config/index.js";

const BASE = `http://127.0.0.1:${config.port}`;
const INJECT_DRIFT =
  process.env.NW_INJECT_DRIFT === "1" || process.argv.includes("--drift");

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${path} → ${res.status}: ${text}`);
  }
  return JSON.parse(text) as T;
}

async function main(): Promise<void> {
  initOtel();

  const health = await fetch(`${BASE}/health`);
  if (!health.ok) {
    throw new Error(`Backend not healthy at ${BASE} — start it with npm run dev`);
  }

  const task =
    process.env.NW_TASK ??
    "Find and book a flight from SFO to LAX under $400";

  console.log(
    `[happy-path] starting demo via /runs/demo injectDrift=${INJECT_DRIFT}`,
  );

  const started = await postJson<{
    runId: string;
    status: string;
    plan: { maxBudget: number };
  }>("/runs/demo", { task, injectDrift: INJECT_DRIFT });

  console.log(`[happy-path] runId=${started.runId} maxBudget=$${started.plan.maxBudget}`);

  // Poll until terminal — sequence runs in-process on the backend.
  let lastStatus = started.status;
  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const res = await fetch(`${BASE}/runs/${started.runId}`);
    if (!res.ok) throw new Error(`GET /runs/${started.runId} → ${res.status}`);
    const run = (await res.json()) as {
      status: string;
      recoveryCount?: number;
      recovered?: boolean;
      lastPolicyScore?: number;
      lastRecoveryDetail?: string;
      lastExplanation?: { text: string; mcpInvoked: boolean; mcpOk: boolean };
    };
    if (run.status !== lastStatus) {
      console.log(
        `[happy-path] status=${run.status} score=${run.lastPolicyScore} recoveries=${run.recoveryCount ?? 0}`,
      );
      lastStatus = run.status;
    }

    // Unattended CLI: simulate operator reject on medium-severity pause.
    if (run.status === "awaiting_approval") {
      console.log(
        `[happy-path] auto-rejecting awaiting_approval (CLI stand-in for dashboard Reject)`,
      );
      await postJson(`/runs/${started.runId}/decision`, { decision: "reject" });
      continue;
    }

    if (
      run.status === "completed" ||
      run.status === "failed" ||
      run.status === "hard_stopped" ||
      run.status === "paused"
    ) {
      if (run.lastRecoveryDetail) {
        console.log(`[happy-path] recovery: ${run.lastRecoveryDetail}`);
      }
      if (run.lastExplanation?.text) {
        console.log(
          `[happy-path] explanation mcpInvoked=${run.lastExplanation.mcpInvoked} mcpOk=${run.lastExplanation.mcpOk}: ${run.lastExplanation.text}`,
        );
      }
      console.log(
        `[happy-path] done — run.id=${started.runId} status=${run.status} recoveries=${run.recoveryCount ?? 0} recovered=${run.recovered ?? false}`,
      );
      console.log(
        `[happy-path] local checkpoints: npm run checkpoints:list -- ${started.runId}`,
      );
      console.log(
        `[happy-path] ClickHouse spans:  npm run spans:verify -- ${started.runId}`,
      );
      await new Promise((r) => setTimeout(r, 2500));
      await shutdownOtel();
      return;
    }
  }

  throw new Error("Timed out waiting for demo sequence to finish");
}

main().catch(async (err) => {
  console.error("[happy-path] failed:", err);
  await shutdownOtel().catch(() => undefined);
  process.exit(1);
});
