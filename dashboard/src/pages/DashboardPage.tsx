import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "../components/Button";
import { DecoCard } from "../components/DecoCard";
import { PolicyTimeline } from "../components/PolicyTimeline";
import * as api from "../lib/api";
import type {
  CheckpointEvent,
  CheckpointRow,
  ExplanationEvent,
  RecoveryMetrics,
  RunSummary,
  Thresholds,
} from "../lib/types";
import { useDashboardSocket } from "../lib/useDashboardSocket";

const DEFAULT_THRESHOLDS: Thresholds = {
  pause: 40,
  rollback: 70,
  hardStop: 90,
};

/** One card per run+step+text — ignores timestamp so WS + run_update don't triple. */
function upsertExplanation(
  prev: ExplanationEvent[],
  event: ExplanationEvent,
): ExplanationEvent[] {
  const key = `${event.runId}|${event.stepId}|${event.text}`;
  const without = prev.filter(
    (e) => `${e.runId}|${e.stepId}|${e.text}` !== key,
  );
  return [event, ...without];
}

export function DashboardPage({ onHome }: { onHome: () => void }) {
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [active, setActive] = useState<RunSummary | null>(null);
  const [checkpoints, setCheckpoints] = useState<CheckpointRow[]>([]);
  const [explanations, setExplanations] = useState<ExplanationEvent[]>([]);
  const [thresholds, setThresholds] = useState<Thresholds>(DEFAULT_THRESHOLDS);
  const [recoveryMetrics, setRecoveryMetrics] = useState<RecoveryMetrics | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [focusedStepId, setFocusedStepId] = useState<string | null>(null);
  const activeRunIdRef = useRef<string | null>(null);

  useEffect(() => {
    activeRunIdRef.current = active?.runId ?? null;
  }, [active?.runId]);

  const refreshLists = useCallback(async () => {
    // Do not hydrate the explanation feed here — refresh should start empty;
    // explanations load only when a run is selected or arrive live over WS.
    const [runList, thresh, metrics] = await Promise.all([
      api.listRuns(),
      api.getThresholds(),
      api.getRecoveryMetrics(),
    ]);
    setRuns([...runList.runs].reverse());
    setThresholds(thresh);
    setRecoveryMetrics(metrics);
  }, []);

  useEffect(() => {
    void refreshLists().catch((e: unknown) =>
      setError(e instanceof Error ? e.message : String(e)),
    );
  }, [refreshLists]);

  const loadCheckpoints = useCallback(async (runId: string) => {
    const res = await api.getCheckpoints(runId);
    setCheckpoints(res.checkpoints);
  }, []);

  const loadExplanationsForRun = useCallback(async (runId: string) => {
    const res = await api.getExplanations();
    const seen = new Set<string>();
    const deduped: ExplanationEvent[] = [];
    for (const e of [...res.explanations].reverse()) {
      if (e.runId !== runId) continue;
      const key = `${e.stepId}|${e.text}`;
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(e);
    }
    setExplanations(deduped);
  }, []);

  const selectRun = useCallback(
    async (runId: string) => {
      const run = await api.getRun(runId);
      activeRunIdRef.current = run.runId;
      setActive(run);
      setFocusedStepId(null);
      await Promise.all([loadCheckpoints(runId), loadExplanationsForRun(runId)]);
    },
    [loadCheckpoints, loadExplanationsForRun],
  );

  useDashboardSocket({
    onHello: () => {
      // Ignore buffered history — feed stays empty until a run is active.
    },
    onRunUpdate: (run) => {
      setActive((cur) => (cur && cur.runId !== run.runId ? cur : run));
      setRuns((prev) => {
        const next = prev.filter((r) => r.runId !== run.runId);
        return [run, ...next];
      });
      void api.getRecoveryMetrics().then(setRecoveryMetrics).catch(() => undefined);
    },
    onExplanation: (event) => {
      // Phase 6 style: append live WS feed events (step / approval / recovery).
      const watching = activeRunIdRef.current;
      if (watching && event.runId !== watching) return;
      setExplanations((prev) => upsertExplanation(prev, event));
    },
    onCheckpoint: (event: CheckpointEvent) => {
      const watching = activeRunIdRef.current;
      if (watching && event.runId !== watching) return;
      setCheckpoints((prev) => {
        if (prev.some((c) => c.id === event.checkpointId)) return prev;
        return [
          ...prev,
          {
            id: event.checkpointId,
            runId: event.runId,
            index: event.index,
            label: event.label,
            planStep: event.label,
            budgetConsumed: 0,
            timestamp: event.timestamp,
          },
        ];
      });
    },
  });

  const start = async (injectDrift: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const run = await api.startDemo({ injectDrift });
      activeRunIdRef.current = run.runId;
      setActive(run);
      setCheckpoints([]);
      setExplanations([]);
      setFocusedStepId(null);
      setRuns((prev) => [run, ...prev.filter((r) => r.runId !== run.runId)]);
      await loadCheckpoints(run.runId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const decide = async (decision: "approve" | "reject") => {
    if (!active) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.submitDecision(active.runId, decision);
      setActive(res.run);
      setRuns((prev) => {
        const next = prev.filter((r) => r.runId !== res.run.runId);
        return [res.run, ...next];
      });
      await loadCheckpoints(res.run.runId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const feedForRun = useMemo(() => {
    if (!active) return [];
    // Newest first; hard-dedupe by step+text. Never filter-hide other cards —
    // timeline focus only highlights (filtering made the feed look "stuck").
    const seen = new Set<string>();
    const forRun: ExplanationEvent[] = [];
    for (const e of explanations) {
      if (e.runId !== active.runId) continue;
      const key = `${e.stepId}|${e.text}`;
      if (seen.has(key)) continue;
      seen.add(key);
      forRun.push(e);
    }
    if (!focusedStepId) return forRun;
    return [...forRun].sort((a, b) => {
      const af = a.stepId === focusedStepId ? 0 : 1;
      const bf = b.stepId === focusedStepId ? 0 : 1;
      return af - bf;
    });
  }, [active, explanations, focusedStepId]);

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 md:px-6 md:py-12">
      <header className="mb-8 flex flex-wrap items-end justify-between gap-4 border-b border-nw-gold/30 pb-6">
        <div>
          <button
            type="button"
            onClick={onHome}
            className="text-xs tracking-[0.3em] text-nw-gold uppercase transition-colors hover:text-nw-gold-light"
          >
            Nights Watch
          </button>
          <h1 className="mt-2 font-display text-3xl tracking-[0.2em] text-nw-fg uppercase md:text-4xl">
            Control room
          </h1>
        </div>
        <p className="max-w-md text-sm text-nw-muted">
          Live Policy Score, explanations, and recovery — no refresh required.
        </p>
      </header>

      {error ? (
        <p className="mb-4 border border-red-500/50 bg-red-950/40 px-4 py-3 text-sm text-red-200">
          {error}
        </p>
      ) : null}

      <DecoCard title="Run control" className="nw-enter mb-6">
        <div className="flex flex-wrap items-center gap-3">
          <Button disabled={busy} onClick={() => void start(false)}>
            Start run
          </Button>
          <Button
            variant="solid"
            disabled={busy}
            onClick={() => void start(true)}
          >
            Start run (inject drift)
          </Button>
          <label className="ml-auto flex min-w-[16rem] flex-col gap-1 text-xs tracking-[0.15em] text-nw-gold uppercase">
            Inspect run
            <select
              className="nw-select h-12 border-0 border-b-2 border-nw-gold bg-nw-card px-2 text-sm tracking-normal text-nw-fg normal-case outline-none focus:border-nw-gold-light"
              value={active?.runId ?? ""}
              onChange={(e) => {
                const id = e.target.value;
                if (id) void selectRun(id);
              }}
            >
              <option value="">Select a run…</option>
              {runs.map((r) => (
                <option key={r.runId} value={r.runId}>
                  {r.runId} — {r.status}
                </option>
              ))}
            </select>
          </label>
        </div>
        {active ? (
          <p className="mt-4 font-mono text-sm text-nw-muted">
            Active: <span className="text-nw-gold">{active.runId}</span>
          </p>
        ) : null}
      </DecoCard>

      <DecoCard title="Status" className="nw-enter mb-6" accent={!!active}>
        {active ? (
          <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <Stat label="Status" value={active.status} emphasize />
            <Stat label="Task" value={active.task} />
            <Stat label="Goal" value={active.plan.goal} />
            <Stat label="Max budget" value={`$${active.plan.maxBudget}`} />
            <Stat label="Plan source" value={active.planSource} />
            <Stat
              label="Started"
              value={new Date(active.startedAt).toLocaleString()}
            />
            {active.lastHumanDecision ? (
              <Stat
                label="Human decision"
                value={active.lastHumanDecision}
                emphasize
              />
            ) : null}
          </dl>
        ) : (
          <p className="text-nw-muted">Start a run to populate the control room.</p>
        )}
      </DecoCard>

      {active?.status === "awaiting_approval" ? (
        <DecoCard
          title="Human approval required"
          className="nw-enter mb-6"
          accent
        >
          <p className="mb-4 text-sm leading-relaxed text-nw-fg/90">
            Medium-severity pause on step{" "}
            <span className="font-mono text-nw-gold">
              {active.pendingApproval?.stepId ?? "?"}
            </span>{" "}
            (score {active.pendingApproval?.score ?? active.lastPolicyScore}).
            For the inject-drift demo, use{" "}
            <span className="text-nw-gold">Reject &amp; recover</span>. Approve
            accepts this violation for the rest of the run (no second medium
            pause on later steps).
          </p>
          {active.lastExplanation?.text ? (
            <p className="mb-4 border border-nw-gold/30 bg-nw-bg/50 p-3 text-sm text-nw-muted">
              {active.lastExplanation.text}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-3">
            <Button
              variant="solid"
              disabled={busy}
              onClick={() => void decide("reject")}
            >
              Reject &amp; recover
            </Button>
            <Button disabled={busy} onClick={() => void decide("approve")}>
              Approve &amp; continue
            </Button>
          </div>
        </DecoCard>
      ) : null}

      <div className="mb-6 grid gap-6 lg:grid-cols-5">
        <DecoCard title="Policy score timeline" className="nw-enter lg:col-span-3">
          <PolicyTimeline
            evaluations={active?.policyEvaluations ?? []}
            checkpoints={checkpoints}
            thresholds={thresholds}
            focusedStepId={focusedStepId}
            onStepClick={(stepId) =>
              setFocusedStepId((cur) => (cur === stepId ? null : stepId))
            }
          />
          <p className="mt-2 text-xs text-nw-muted">
            Click a step on the timeline to focus its explanation (if any).
          </p>
        </DecoCard>
        <DecoCard title="Explanation feed" className="nw-enter lg:col-span-2">
          <ul className="flex max-h-[280px] flex-col gap-3 overflow-y-auto pr-1">
            {feedForRun.length === 0 ? (
              <li className="text-sm text-nw-muted">
                No explanations yet. Violations (score ≥ pause) appear here live.
              </li>
            ) : (
              feedForRun.map((e) => {
                const focused = focusedStepId === e.stepId;
                const kind =
                  e.stepId === "recovery"
                    ? "recovery"
                    : e.stepId === "approval"
                      ? "approval"
                      : e.stepId === "complete"
                        ? "complete"
                        : e.score >= thresholds.pause
                          ? "violation"
                          : "ok";
                return (
                  <li
                    key={`${e.runId}-${e.timestamp}-${e.stepId}-${e.text.slice(0, 24)}`}
                    className={`nw-enter border p-3 text-sm ${
                      focused
                        ? "border-nw-gold bg-nw-midnight/80 nw-glow"
                        : kind === "recovery" || kind === "complete"
                          ? "border-emerald-700/50 bg-emerald-950/20"
                          : kind === "approval"
                            ? "border-nw-gold/50 bg-nw-midnight/40"
                            : kind === "violation"
                              ? e.mcpOk
                                ? "border-nw-gold/40 bg-nw-bg/60"
                                : "border-amber-700/60 bg-amber-950/30"
                              : "border-nw-gold/25 bg-nw-bg/40"
                    }`}
                  >
                    <div className="flex flex-wrap items-center gap-2 text-xs tracking-[0.12em] uppercase">
                      <span className="text-nw-gold">{e.stepId}</span>
                      <span className="text-nw-muted">score {e.score}</span>
                      {kind === "violation" ? (
                        <span
                          className={
                            e.mcpOk ? "text-emerald-400/90" : "text-amber-300"
                          }
                        >
                          MCP {e.mcpOk ? "ok" : "degraded"}
                        </span>
                      ) : (
                        <span className="text-emerald-400/90">{kind}</span>
                      )}
                    </div>
                    <p className="mt-2 leading-relaxed text-nw-fg/90">{e.text}</p>
                    <p className="mt-1 text-xs text-nw-muted">
                      {new Date(e.timestamp).toLocaleTimeString()}
                    </p>
                  </li>
                );
              })
            )}
          </ul>
        </DecoCard>
      </div>

      <DecoCard title="Recovery health" className="nw-enter mb-6">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
          <Metric
            label="Policy score"
            value={String(active?.lastPolicyScore ?? "—")}
          />
          <Metric
            label="Recovery time"
            value={
              active?.lastRecoveryDurationMs != null
                ? `${active.lastRecoveryDurationMs} ms`
                : "—"
            }
          />
          <Metric
            label="Rollback success"
            value={
              recoveryMetrics?.rollbackSuccessRate == null
                ? "—"
                : `${Math.round(recoveryMetrics.rollbackSuccessRate * 100)}%`
            }
          />
          <Metric
            label="Recovery attempts"
            value={String(
              active?.recoveryCount ?? recoveryMetrics?.recoveryAttempts ?? "—",
            )}
          />
          <Metric
            label="Recovered executions"
            value={
              recoveryMetrics
                ? `${recoveryMetrics.recoveredExecutions}${active?.recovered ? " · this run ✓" : ""}`
                : "—"
            }
          />
        </div>
        {recoveryMetrics?.note ? (
          <p className="mt-4 text-xs text-nw-muted">{recoveryMetrics.note}</p>
        ) : null}
      </DecoCard>

      <DecoCard title="Recovery event trace" className="nw-enter">
        {active?.lastRecoveryDetail ? (
          <div className="space-y-2 text-sm">
            <p className="text-nw-fg">{active.lastRecoveryDetail}</p>
            {active.lastRestoredCheckpointId ? (
              <p className="font-mono text-nw-gold">
                Restored checkpoint: {active.lastRestoredCheckpointId}
              </p>
            ) : null}
            {active.lastRecoveryDurationMs != null ? (
              <p className="text-nw-muted">
                Duration: {active.lastRecoveryDurationMs} ms
              </p>
            ) : null}
          </div>
        ) : (
          <p className="text-nw-muted">
            No recovery event on this run yet. Inject drift to force one.
          </p>
        )}
      </DecoCard>
    </div>
  );
}

function Stat({
  label,
  value,
  emphasize,
}: {
  label: string;
  value: string;
  emphasize?: boolean;
}) {
  return (
    <div>
      <dt className="text-xs tracking-[0.18em] text-nw-gold uppercase">
        {label}
      </dt>
      <dd
        className={`mt-1 text-sm leading-snug ${emphasize ? "font-display tracking-[0.15em] text-nw-gold-light uppercase" : "text-nw-fg"}`}
      >
        {value}
      </dd>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="border border-nw-gold/20 bg-nw-bg/50 p-4 text-center">
      <p className="text-[0.65rem] tracking-[0.2em] text-nw-muted uppercase">
        {label}
      </p>
      <p className="mt-2 font-display text-2xl text-nw-gold">{value}</p>
    </div>
  );
}
