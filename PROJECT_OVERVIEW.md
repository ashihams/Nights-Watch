# Nights Watch — Project Overview, Architecture & Setup Guide

**For:** you (project owner), as a reference doc and setup checklist.
**Companion doc:** `CURSOR_GUIDE.md` — hand that one to Cursor for implementation. This doc is the human-readable source of truth both docs should stay consistent with.

---

## 1. The Idea

AI agents fail silently in a specific, underdiscussed way: not by getting hacked, but by quietly doing more than they were asked to do. An agent told to "find a flight under $400" that ends up booking a $1,200 upgrade, or adding a hotel nobody asked for, hasn't been attacked — it has drifted out of scope, one small deviation at a time, and by the time anyone notices, an irreversible action may already have happened.

**Nights Watch** is a runtime resilience system for AI agents that treats observability as a control plane, not a dashboard. It:

1. Watches an agent's real execution against its original plan.
2. Scores each action against policy (does this still match what was approved).
3. Explains, in plain language, why a violation happened the moment it's detected.
4. Pauses execution before an out-of-scope or irreversible action fires.
5. Rolls back to the last safe checkpoint — not a full restart — and re-plans from there.
6. Resumes automatically, or after human approval, depending on severity.

The core architectural bet, and the thing that differentiates this from a typical "AI observability dashboard" project: **the Policy Engine queries SigNoz live, at decision time, to decide what to do next.** SigNoz isn't just where logs go to be looked at later — it's an active input to the Supervisor's runtime decisions.

---

## 2. Core Architecture

```
        React + TypeScript + Tailwind
           (Nights Watch Dashboard)
                     │
            REST  /  WebSocket
                     │
      Nights Watch Backend (TypeScript)
   ┌─────────────────┼──────────────────┐
   │                 │                  │
   ▼                 ▼                  ▼
Policy Engine   Checkpoint Manager   Recovery Engine
   │                 │                  │
   │        (owns execution state,      │
   │         backed by local store)     │
   │                 │                  │
   └─────────────────┼──────────────────┘
                     │
            OpenTelemetry SDK
                     │
                  SigNoz
                     ▲
                     │
          n8n Workflow Engine
          (the Executor — runs the
           actual agent: search,
           select, confirm, book)
```

### 2.1 Component responsibilities

**n8n (Executor)**
Runs the actual agent workflow as a visual n8n workflow: search flights → select option → confirm details → book. Each node executes a step and reports its result back to the Backend via webhook/HTTP call. n8n does the "acting," nothing else — it does not make policy decisions and does not own execution state.

**Nights Watch Backend (TypeScript)**
The brain. Three modules:
- **Policy Engine** — rule-based (explicitly called "policy," not "drift detection") evaluation of each proposed/actual n8n step against the original plan. Produces a Policy Score (0–100) and a rule-trace of which rules fired.
- **Checkpoint Manager** — owns the actual checkpoint state (current step, artifacts produced, budget consumed) in a local, fast, durable store. Also emits a correlated `checkpoint.created` span to SigNoz for observability/visibility, keyed by the same checkpoint id — but that span is a record, not the mechanism rollback depends on.
- **Recovery Engine** — executes rollback (reconstruct state from the Checkpoint Manager's own store, not from SigNoz), triggers re-plan, and manages resume. Emits recovery outcome metrics.

**SigNoz**
Owns observability, not execution state. Two access patterns, chosen deliberately by data-latency tolerance:
- **Direct Query API** — used by the Policy Engine for decision-support queries that are on the critical path (previous policy violations this run, budget trend, correlated recent logs). Fast, deterministic, typed — no LLM/agentic indirection here, because the Policy Engine runs on every step and can't tolerate MCP's added latency/non-determinism.
- **SigNoz MCP** — used by the Explanation Layer (and optionally a human-facing "investigate this pause" feature on the dashboard) for exploratory, LLM-driven querying. This only fires occasionally (on a violation), so the extra cost/latency of MCP is a non-issue, and it's the right tool where an LLM should decide what context is relevant rather than you pre-specifying every query.

**React Dashboard**
Live view via WebSocket: Policy Score over time, checkpoint markers, the explanation feed (plain-language "why" for each violation), recovery metrics panel, and — if time allows — the human-approval control (approve/reject a paused execution).

### 2.2 Data source classification (the design principle underneath all of this)

| | Live Context (critical path) | Observability Context (decision support) |
|---|---|---|
| **What** | Current workflow node, current checkpoint, current tool, current execution state, current token usage | Previous policy violations, recovery metrics, historical traces, budget trends, correlated logs |
| **Source** | Checkpoint Manager / Supervisor's own store | SigNoz (Query API or MCP) |
| **Latency tolerance** | Immediate — the agent loop is blocked on this | Acceptable to be higher — informs but doesn't block real-time execution |

This is the single most important architectural rule in the project. If you ever find yourself about to make a rollback depend on a SigNoz query, stop — that's the wrong data source for that decision.

---

## 3. Tech Stack

| Layer | Choice | Why |
|---|---|---|
| Agent execution | **n8n** (self-hosted or n8n Cloud) | Visual workflow = demo-friendly, matches hackathon's own example builds, cleanly separable "Executor" role |
| Backend | **TypeScript (Node.js)** | Type safety for checkpoint schemas and policy rule definitions; matches dashboard language for shared types |
| Backend framework | **Express or Fastify** (Fastify preferred for perf + built-in schema validation) | Lightweight, fast to stand up in a week |
| Real-time updates | **WebSocket** (e.g. `ws` or Socket.IO) | Push live Policy Score / pause / explanation events to dashboard |
| Checkpoint store | **SQLite (via better-sqlite3) or Redis** | Fast, durable, zero/low ops overhead for a hackathon build; owns execution-critical state independent of SigNoz |
| Observability backend | **SigNoz** (self-hosted via Docker, or SigNoz Cloud) | OpenTelemetry-native; traces, metrics, logs, dashboards, alerts, Query API, and MCP server all in one platform |
| Instrumentation | **OpenTelemetry SDK for Node.js** | Emits checkpoint spans, policy evaluation span events, custom metrics |
| LLM calls (Planner, Policy explanation, Re-plan) | **Anthropic API (Claude)** or OpenAI — pick one and stay consistent | Structured plan generation, plain-language explanations, re-planning |
| Explanation Layer / investigation queries | **SigNoz MCP server** + LLM tool-calling | Agentic, exploratory querying against SigNoz for context |
| Dashboard | **React + TypeScript + Tailwind CSS** | Fast to build, matches architecture diagram, good for live demo polish |
| Charts on dashboard | **Recharts or a native SigNoz embed/iframe** | Policy Score timeline, recovery metrics panels |

---

## 4. Manual Setup Requirements (things only you can do — accounts, installs, config)

Do these before Cursor starts generating code, so the agent has real endpoints/credentials to wire against rather than placeholders.

### 4.1 SigNoz
- [ ] Decide: self-host (Docker Compose, fastest for a hackathon) or SigNoz Cloud (less setup, no infra to manage during the demo week — recommended given the time constraint).
- [ ] If self-hosting: follow SigNoz's official self-host install guide, confirm the OTel Collector endpoint is reachable (default gRPC `4317` / HTTP `4318`).
- [ ] If using SigNoz Cloud: create an account, note your ingestion endpoint and ingestion key.
- [ ] Confirm you can view the SigNoz UI and that a test span/metric successfully shows up (send one manually to sanity-check before building anything else).
- [ ] Locate and note the **Query API** base URL and auth token/API key for your SigNoz instance (needed by the Policy Engine).
- [ ] Confirm SigNoz's **MCP server** is available for your instance/plan, get its endpoint and any auth token it needs. If it's not available for your setup, flag this immediately — the Explanation Layer's architecture depends on it, and you'd need a fallback plan (e.g., Explanation Layer falls back to Query API only, still legitimate but less differentiated).
- [ ] Set up at least one **Alert Rule** in SigNoz on a custom metric (you'll create the actual Policy Score metric during the build, but confirm you know how to configure alert rules in the UI beforehand).

### 4.2 n8n
- [ ] Decide: self-hosted (Docker) or n8n Cloud.
- [ ] Install/provision and confirm you can create and trigger a workflow via webhook.
- [ ] No need to build the actual travel-booking workflow yet — just confirm your n8n instance is reachable from your Backend (webhook URLs, API key if using n8n's API to trigger workflows programmatically).

### 4.3 LLM Provider
- [ ] Get an API key for whichever LLM you're using for Planner / Explanation Layer / Re-plan calls (Anthropic or OpenAI).
- [ ] Confirm you have enough quota/budget for a week of iterative testing plus the live demo (LLM calls happen on every plan generation, every violation explanation, and every re-plan — budget accordingly, this could add up during heavy iteration).

### 4.4 Local Dev Environment
- [ ] Node.js (LTS version) installed.
- [ ] Package manager decided (npm, pnpm, or yarn — pick one, stay consistent across backend and dashboard).
- [ ] Docker installed if self-hosting SigNoz and/or n8n locally.
- [ ] `.env` file strategy decided — you'll need to store: SigNoz OTel endpoint, SigNoz Query API URL + token, SigNoz MCP endpoint + token, n8n webhook base URL + API key, LLM API key. Keep a `.env.example` in the repo with keys but no values.

### 4.5 Repo & Docs
- [ ] Create the repo, add `PROJECT_OVERVIEW.md` (this doc) and `CURSOR_GUIDE.md` at the root so Cursor has them as context from the start.
- [ ] Confirm your submission requirements once the hackathon's submission form goes live (per the event page, the form was "coming soon" as of the info you shared — check back before the deadline).

### 4.6 Mock Data for the Demo Scenario
- [ ] Since this is a hackathon build, decide whether the flight search/booking APIs the n8n workflow calls are:
  - fully mocked (simple JSON responses you control, recommended — lets you reliably inject the "drift" scenario for the demo), or
  - a real public flight-search API (adds realism but less control over triggering the demo's drift moment reliably).
  - **Recommendation: mock it.** You need the drift injection to fire reliably during a live demo; a real API's inconsistent responses are a demo risk you don't need this week.

---

## 5. Scope Recap (locked, for reference)

**Must-have:** one scenario (travel booking), plan generation + checkpoints, rule-based Policy Engine, threshold-triggered pause, rollback to checkpoint, re-plan + resume, Explanation Layer, deep SigNoz integration (Query API + MCP + dashboard + alert rule), demo script + README.

**Nice-to-have (in order):** human-approval UI, auto-checkpoints before irreversible actions, dynamic budget tracking.

**Cut:** multiple scenarios, generic multi-framework SDK, ML-based scoring, multi-agent handling, production auth/persistence.

---

## 6. Metrics Emitted (for your own tracking sanity)

- **Policy Score** — per evaluation, 0–100.
- **Recovery Time** — duration from rollback initiated to successful resume.
- **Rollback Success Rate** — % of rollbacks that lead to successful goal completion.
- **Recovery Attempts** — count of rollback/re-plan triggers.
- **Recovered Executions** — count of runs that hit a violation but still completed successfully.
- **False Positive Rate** — % of flagged violations later judged not actually problematic (seed this with a small labeled test set of ~10 runs).

---

## 7. Demo Script (for your own rehearsal)

1. Kick off the travel-booking task: "find and book a flight under $400."
2. Happy path runs briefly — checkpoints tick by, Policy Score stays low, shown live on dashboard.
3. Inject drift (poisoned search result nudges toward a $1,200 option, or agent tries to add an unrequested hotel booking).
4. Dashboard shows: Policy Score spike → explanation appears ("agent planned X, is now attempting Y, exceeds approved budget") → execution pauses.
5. (If built) human-approval prompt appears; you reject it, or auto-rollback fires for high severity.
6. Rollback to last safe checkpoint shown on dashboard timeline; re-plan call happens; agent resumes.
7. Agent completes the original, in-scope task.
8. Recovery metrics panel updates live: Recovery Time, Rollback Success Rate, Recovered Executions tick up.

Rehearse this at least twice before presenting — the injected-drift moment needs to fire reliably.
