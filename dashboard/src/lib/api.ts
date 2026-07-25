import type {
  CheckpointRow,
  ExplanationEvent,
  RecoveryMetrics,
  RunSummary,
  Thresholds,
} from "./types";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    ...init,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${path} → ${res.status}: ${text}`);
  }
  return text ? (JSON.parse(text) as T) : ({} as T);
}

export function startDemo(input: {
  injectDrift: boolean;
  task?: string;
}): Promise<RunSummary> {
  return request<RunSummary>("/runs/demo", {
    method: "POST",
    body: JSON.stringify({
      injectDrift: input.injectDrift,
      task:
        input.task ??
        "Find and book a flight from SFO to LAX under $400",
    }),
  });
}

export function listRuns(): Promise<{ runs: RunSummary[] }> {
  return request("/runs");
}

export function getRun(runId: string): Promise<RunSummary> {
  return request(`/runs/${runId}`);
}

export function getCheckpoints(
  runId: string,
): Promise<{ runId: string; checkpoints: CheckpointRow[] }> {
  return request(`/runs/${runId}/checkpoints`);
}

export function getExplanations(): Promise<{
  explanations: ExplanationEvent[];
}> {
  return request("/explanations");
}

export function getThresholds(): Promise<Thresholds> {
  return request("/config/thresholds");
}

export function getRecoveryMetrics(): Promise<RecoveryMetrics> {
  return request("/metrics/recovery");
}
