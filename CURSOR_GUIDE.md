# Cursor Build Guide — Nights Watch

**Read this entire document before writing any code.** This is your primary spec. `PROJECT_OVERVIEW.md` in the repo root is the companion human-facing doc — if anything here seems ambiguous, check there first; if still unclear, stop and ask rather than guessing.

You are building **Nights Watch**: a runtime resilience system for AI agents that uses SigNoz as a control plane, not a passive dashboard. An n8n workflow acts as the agent (the Executor). A TypeScript backend supervises it, scoring every action against an original plan, explaining violations in plain language, pausing before out-of-scope or irreversible actions, rolling back to the last safe checkpoint, and resuming — all without ever restarting from scratch.

---

## 1. Non-Negotiable Architectural Rules

These rules override convenience, speed, or "it would be simpler to just—" instincts. If a shortcut would violate one of these, stop and flag it instead of taking the shortcut silently.

1. **The Supervisor (Backend) owns execution state. SigNoz owns observability.** Never make rollback correctness depend on a SigNoz query. Checkpoint data used for actually reconstructing state must come from the Backend's own local store (SQLite/Redis — see Section 4), not from a SigNoz span attribute.
2. **SigNoz still gets a correlated record of every checkpoint** (`checkpoint.created` span, keyed by the same `checkpoint.id` as the local store), for visibility and for the Policy Engine's decision-support queries — but this record is never the source of truth for rollback mechanics.
3. **Data source classification is fixed, do not blur it:**
   - **Live/critical-path context** (current node, current checkpoint, current tool, current execution state, current token usage) → always sourced from the Backend's own state, immediate/synchronous.
   - **Observability/decision-support context** (previous policy violations, recovery metrics, historical traces, budget trends, correlated logs) → sourced from SigNoz, latency-tolerant.
4. **SigNoz access is split by consumer, not interchangeable:**
   - **Policy Engine → SigNoz direct Query API only.** Runs on every step, needs deterministic typed responses fast. Never route Policy Engine queries through MCP.
   - **Explanation Layer (and any human-facing "investigate this" feature) → SigNoz MCP.** Occasional, LLM-driven, exploratory. This is where MCP belongs.
5. **n8n is the Executor and only the Executor.** It runs the actual workflow steps (search, select, confirm, book) and reports results back to the Backend. It does not make policy decisions, does not own state, does not talk to SigNoz directly for control-plane purposes. (It's fine for n8n's own execution to be separately instrumented/visible in SigNoz if trivial to add, but that's observability-of-n8n, not part of the control loop.)
6. **Terminology lock — use these exact terms in code (types, function names, variable names), comments, logs, and UI copy. Do not introduce synonyms:**
   - `Supervisor` (never "controller," never "watcher" in code — "watcher" is marketing copy only)
   - `PolicyEngine` (never "drift detector," never "anomaly detector")
   - `PolicyScore` / `PolicyEvaluation` (never "drift score")
   - `Checkpoint` (never "snapshot," never "backup")
   - `RecoveryEngine` (never "rollback service" as the primary name — RecoveryEngine owns rollback, re-plan, and resume together)
   - `ExplanationLayer` (never "reasoning module" or similar)
7. **No ML/embedding-based scoring.** The Policy Engine is rule-based by design (called "policy," not "detection," specifically because it's a set of explicit, inspectable rules with weights — not a learned/opaque model). Do not introduce a classifier or embedding similarity check, even if it seems like it'd improve accuracy — it contradicts the project's own thesis and adds risk with no judging upside.
8. **One scenario only: travel booking.** Do not build scenario abstraction layers "just in case." Hardcode to this domain. Generalization is explicitly cut scope (see `PROJECT_OVERVIEW.md` Section 5).

---

## 2. Repo Structure

Set this up first, before any feature code:

```
/nights-watch
  /backend
    /src
      /supervisor        # orchestration: receives n8n step reports, decides continue/pause/rollback
      /policy-engine      # rule definitions, scoring, SigNoz Query API client
      /checkpoint-manager # local store (SQLite/Redis) + SigNoz checkpoint span emission
      /recovery-engine    # rollback, re-plan trigger, resume, recovery metrics emission
      /explanation-layer  # LLM call + SigNoz MCP client for context gathering
      /planner            # initial plan generation LLM call
      /otel               # OpenTelemetry SDK setup, span/metric helpers, shared instrumentation
      /api                # REST endpoints + WebSocket server for dashboard
      /types              # shared TypeScript types (Checkpoint, Plan, PolicyEvaluation, etc.)
      /config              # env var loading, constants (thresholds, weights)
    /test
  /dashboard
    /src
      /components
      /hooks              # WebSocket hook, API client hooks
      /pages
      /types              # can re-export/mirror backend types where practical
  /n8n-workflows
    travel-booking.json    # exported n8n workflow definition
  PROJECT_OVERVIEW.md
  CURSOR_GUIDE.md
  README.md
  .env.example
```

Do not deviate from this structure without a clear reason logged in a comment or commit message.

---

## 3. Build Order — Follow Sequentially, Checkpoint After Each Phase

Each phase below ends with a **Checkpoint** — a concrete, testable state that must be true before moving to the next phase. Do not proceed past a checkpoint that isn't actually met; do not skip ahead because a later phase seems more interesting.

### Phase 0 — Scaffolding
- Set up repo structure (Section 2).
- Initialize backend (TypeScript, Fastify recommended), dashboard (React + TS + Tailwind), and `.env.example` with all required keys (see `PROJECT_OVERVIEW.md` Section 4).
- Set up OpenTelemetry SDK in `/backend/src/otel`, confirm a single test span successfully appears in SigNoz.

**Checkpoint 0:** A manually-sent test span shows up in the SigNoz UI. Nothing else has been built yet — do not proceed until this works, since every later phase depends on the OTel pipeline being real.

### Phase 1 — Plan + Executor Wiring (n8n)
- Build the `travel-booking` n8n workflow: search step → select step → confirm step → book step, each calling a mocked API (mock JSON responses, per `PROJECT_OVERVIEW.md` Section 4.6). Each node reports its result to the Backend via webhook/HTTP call.
- Build the Planner module: one LLM call, input = user task string, output = structured plan (ordered steps, expected tool per step, expected scope/constraints like max price). Define this as a strict TypeScript type — do not accept loosely-typed/freeform LLM output; validate/parse it.
- Wire the Backend to receive n8n step-completion callbacks and log them as spans (no policy logic yet — just get the full happy path executing and visible in SigNoz as a trace).

**Checkpoint 1:** Running the full happy-path scenario (no injected drift) produces one clean, readable trace in SigNoz showing all four steps in order, and the Planner's structured plan is visible/logged. No policy evaluation, no checkpoints yet — just confirm the whole plumbing works end to end.

### Phase 2 — Checkpoint Manager
- Implement the local checkpoint store (SQLite recommended for a one-week build: simple, zero external ops dependency, durable).
- Checkpoint schema (see Section 5 below for full field list) — implement as a strict TypeScript type/interface first, then the store.
- Emit a checkpoint at each of the four plan-defined milestones (plan generated / search complete / option selected / before booking).
- Each checkpoint write to the local store also triggers a `checkpoint.created` span emission to SigNoz, same `checkpoint.id`, carrying a summary (not necessarily the full state blob — summary attributes are fine for the SigNoz record; full state lives in the local store).

**Checkpoint 2:** Running the happy path produces 4 checkpoints in the local store (inspectable directly, e.g. via a simple query script) AND 4 correlated `checkpoint.created` spans in SigNoz, both sets sharing the same `checkpoint.id` values. Confirm the local store, not SigNoz, is what you'd actually read from if you were to reconstruct state right now.

### Phase 3 — Policy Engine
- Implement rule-based policy evaluation as a set of explicit, named rules with weights (see Section 6 for the starter rule set — extend if needed but keep it rule-based and inspectable).
- Implement the SigNoz Query API client for decision-support queries (previous policy scores this run, cumulative budget consumed). Wire at least one real query into the Policy Engine's evaluation logic — this is the architectural centerpiece, do not defer or fake it with local-only logic.
- Produce a `PolicyEvaluation` result per action: `{ score: number, ruleTrace: RuleResult[], timestamp, checkpointId }`.
- Emit the Policy Score as a custom OTel metric (not just a log) on every evaluation.
- Configure a real SigNoz Alert Rule on the Policy Score metric (do this directly in the SigNoz UI once the metric exists and is flowing — not something to fake in code).

**Checkpoint 3:** Injecting a drift scenario (see Section 7) into the happy path produces a visibly higher Policy Score than the non-drifted steps, the score is queryable/graphable in SigNoz as a metric, and the configured SigNoz alert rule actually fires when the score crosses threshold. Confirm the Policy Engine's query to SigNoz for prior-run context is a real network call, not a stub.

### Phase 4 — Explanation Layer
- Implement the second LLM call, triggered only when Policy Score crosses the pause threshold.
- Input to this call: the plan, the rule-trace from the triggering PolicyEvaluation, the actual action taken. Additionally, use the **SigNoz MCP client** here to let the LLM pull in any further context it decides is relevant (recent related traces, correlated logs) before composing its explanation — this is the MCP integration point, do not skip it or substitute the Query API here.
- Constrain output to 1–2 plain-language sentences.
- Emit the explanation as a `policy.explanation` span event attached to the same trace/span where the violation occurred.
- Push the explanation to the dashboard via WebSocket as soon as it's generated.

**Checkpoint 4:** Injecting drift produces a plain-language explanation, visible both (a) as a span event inside the relevant SigNoz trace, and (b) live on the dashboard's explanation feed within a couple seconds of the violation. Confirm the MCP client is actually being invoked (log/trace this call distinctly) rather than silently falling back to the Query API.

### Phase 5 — Recovery Engine
- Implement rollback: given a `PolicyEvaluation` that exceeds the rollback threshold, look up the last valid checkpoint from the **local Checkpoint Manager store** (never from SigNoz), discard state past that point, restore in-memory execution state from it.
- Implement re-plan: call the Planner again with the restored state + original goal as context, get a fresh plan segment, hand control back to the Supervisor to resume driving n8n from the restored point.
- Implement the severity-to-action policy explicitly as a small, readable lookup/switch — not scattered if-statements across the codebase:
  - low severity → auto re-plan, resume
  - medium severity → pause, await human approval (if built this week) or auto re-plan if human-approval UI isn't ready yet
  - high severity / irreversible-action risk → rollback to last checkpoint, then re-plan
  - severity breaching a hard ceiling → hard stop, no auto-resume
- Emit all five recovery metrics (Section 8) as OTel custom metrics on every recovery attempt/outcome.

**Checkpoint 5:** The full loop works end-to-end without manual intervention: happy path → injected drift → Policy Score spike → explanation generated → pause → rollback → re-plan → resume → task completes successfully. All five recovery metrics update in SigNoz after the run. Run this at least 3 times in a row successfully before moving on — this is the core demo moment and must be reliable.

### Phase 6 — Dashboard
- Build the React dashboard: live Policy Score timeline with checkpoint markers overlaid, explanation feed, recovery metrics panel (all 5 metrics from Section 8), current execution status (running/paused/rolled-back/resumed).
- Wire via WebSocket for live updates; REST for initial load / historical queries.
- Keep visual design simple and legible over feature-rich — this is a demo surface, not a production admin panel.

**Checkpoint 6:** Running the full scenario live updates the dashboard in real time with no manual refresh, and every event in the demo script (`PROJECT_OVERVIEW.md` Section 7) is visibly reflected on screen at the moment it happens.

### Phase 7 — Nice-to-Haves (only if Phases 0–6 are solid and time remains)
In strict priority order — do not start #2 before #1 is done, do not start #3 before #2 is done:
1. **Human-approval UI** — approve/reject control on the dashboard, wired to the medium-severity pause branch in the Recovery Engine's severity lookup. Log the human's decision as a span event correlated to the same trace/run.
2. **Auto-checkpoints before irreversible actions** — Checkpoint Manager automatically creates a checkpoint immediately before any n8n step tagged `irreversible: true` (the booking step), independent of the plan-defined checkpoint schedule.
3. **Dynamic budget tracking** — token/cost gauge on the dashboard, hard-stop when a budget ceiling is reached regardless of Policy Score.

### Phase 8 — Demo Prep
- Write/finalize README (project pitch, architecture summary, setup instructions, how to run the demo).
- Rehearse the demo script at least twice, timed.
- Record a backup demo video in case live demo has issues during presentation.

---

## 4. Checkpoint Data Schema (implement as a strict TypeScript type)

```
interface Checkpoint {
  id: string;              // e.g. "run-abc123-cp-2"
  runId: string;            // groups all checkpoints for one execution
  index: number;            // 0, 1, 2, 3...
  label: string;            // e.g. "flight_selected"
  planStep: string;         // which plan step this corresponds to
  state: Record<string, unknown>; // serialized snapshot: artifacts, selected options, intermediate outputs needed to resume
  budgetConsumed: number;    // cost/tokens spent up to this point
  timestamp: string;         // ISO8601
  trustContext: Record<string, unknown>; // which data sources fed decisions up to this point
}
```

This full object lives in the local store (Phase 2). The SigNoz `checkpoint.created` span should carry `id`, `runId`, `index`, `label`, `planStep`, `budgetConsumed`, `timestamp` as attributes — `state` and `trustContext` can be summarized or omitted from the span if large, since they're not needed there for rollback (rollback reads the local store).

---

## 5. Starter Policy Rule Set (extend as needed, keep it rule-based)

Implement as an array of named, weighted rules the Policy Engine evaluates against each proposed/actual action:

- **Tool mismatch** — actual tool called ≠ tool specified in the plan for this step → high weight
- **Budget breach** — cost/price of the action exceeds the plan's stated budget ceiling → high weight
- **Target mismatch** — recipient/domain/target of the action not in the plan's expected target set → high weight
- **Step-order violation** — step executed out of the plan's expected order or skips ahead → medium weight
- **Minor parameter deviation** — same tool/target, small parameter differences within plausible range → low weight

Each rule returns `{ ruleName, fired: boolean, weight, detail }`. The Policy Score is a weighted aggregate of fired rules (define the exact formula in code and document it in a comment — keep it simple and inspectable, e.g. sum of fired weights, capped at 100).

---

## 6. Demo Drift Injection (build this as a deliberate, controllable test path)

Do not rely on genuinely random/unpredictable API responses to trigger the demo's drift moment. Build an explicit "inject drift" trigger (e.g. a query param, config flag, or dedicated test endpoint) that deterministically causes either:
- the mocked search step to return a $1,200 option that the agent then attempts to select/book, or
- the agent's flow to attempt an additional, unrequested hotel-booking step.

This needs to fire reliably on demand during a live presentation — treat this as a first-class feature, not an afterthought.

---

## 7. Recovery Metrics (implement all five as real OTel custom metrics)

- **Policy Score** — gauge, per evaluation, 0–100.
- **Recovery Time** — histogram, duration from rollback initiated (`checkpoint.restored` event) to next successful post-recovery tool call.
- **Rollback Success Rate** — ratio: successful post-rollback completions / total rollback attempts.
- **Recovery Attempts** — counter, incremented on every rollback or re-plan trigger.
- **Recovered Executions** — counter, incremented when a run hits ≥1 policy violation but still completes the original goal successfully.
- **False Positive Rate** — ratio: violations later judged not actually problematic / total violations flagged. For the hackathon build, seed this via a small labeled test set (~10 runs, some legitimate deviations, some real violations) rather than building live human-labeling infrastructure — a simple config/fixture file mapping test-run outcomes to "true violation" / "false positive" is sufficient.

All five must appear on one dashboard panel/row ("Recovery Health") in both SigNoz and the React dashboard.

---

## 8. Code Quality Rules

1. **Strict TypeScript everywhere** (`strict: true` in `tsconfig.json`, both backend and dashboard). No `any` except where genuinely unavoidable (e.g. raw LLM response parsing before validation) — and even then, narrow it immediately via a parser/type guard, don't let `any` propagate.
2. **Validate all LLM outputs** (plan generation, re-plan, explanation) against a defined schema/type before using them downstream. LLMs producing malformed structured output is a real failure mode — don't assume well-formed JSON, parse defensively.
3. **No hardcoded magic numbers for thresholds/weights** — define them as named constants in `/backend/src/config`, documented with a one-line comment explaining the reasoning (e.g. `const ROLLBACK_THRESHOLD = 70; // policy score above this forces rollback rather than auto-replan`).
4. **Every span/metric emission goes through the shared `/backend/src/otel` helpers** — don't scatter raw OTel SDK calls across modules; centralize span/metric creation so naming stays consistent (`checkpoint.created`, `policy.evaluation`, `policy.explanation`, `checkpoint.restored`, `recovery.outcome`).
5. **Keep the severity-to-action policy in one place** (Section 3, Phase 5) — a single, readable function/switch, not scattered conditionals across the Supervisor and Recovery Engine.
6. **Write a short comment at the top of each core module** (`policy-engine`, `checkpoint-manager`, `recovery-engine`, `explanation-layer`) stating its single responsibility and explicitly which of the two SigNoz access patterns (Query API vs MCP) it uses, if any — this keeps the architectural rules from Section 1 visible in the code itself, not just in this doc.
7. **No premature abstraction.** Don't build a generic "AgentAdapter" interface for supporting multiple agent frameworks, don't build a generic "scenario" abstraction for multiple demo scenarios. This project is scoped to one agent (n8n travel-booking) — build directly against that, per Section 1 rule 8.
8. **Commit in small, checkpoint-aligned units.** Ideally one or a few commits per Phase in Section 3, with commit messages referencing the phase (e.g. "Phase 2: Checkpoint Manager local store + SigNoz correlation spans"). This makes it easy to verify each checkpoint was actually met before moving on.
9. **Every module that calls out to an external service (SigNoz Query API, SigNoz MCP, n8n webhook, LLM API) must handle failure gracefully** — timeouts, malformed responses, service unavailability — and log the failure as its own span/event rather than crashing the Supervisor loop. A dead SigNoz connection should degrade the Policy Engine's context, not take down the whole system (reinforces Section 1 rule 1: the Supervisor must be able to keep functioning on its own state even if SigNoz is temporarily unreachable).

---

## 9. When To Stop and Ask Instead of Guessing

- If SigNoz's MCP server isn't actually available/reachable for the setup being used, stop and flag it — don't silently substitute the Query API into the Explanation Layer without noting that this changes the architecture.
- If a Phase's Checkpoint (Section 3) genuinely can't be met as specified within reasonable effort, stop and report what's blocking it rather than quietly shipping a weaker version and moving on.
- If asked to add scope beyond what's in `PROJECT_OVERVIEW.md` Section 5 (Must-have / Nice-to-have / Cut), flag the conflict rather than building it.
