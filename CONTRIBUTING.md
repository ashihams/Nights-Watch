# Contributing to Nights Watch

Thanks for helping build **Nights Watch** — a runtime resilience system for AI agents with SigNoz as the control plane.

## Build order

Follow `CURSOR_GUIDE.md` phases in order. Do not skip a phase checkpoint.

| Phase | Focus |
|---|---|
| 0 | Scaffold + OTel → SigNoz |
| 1 | Plan + n8n Executor |
| 2 | Checkpoint Manager |
| 3 | Policy Engine |
| 4 | Explanation Layer |
| 5 | Recovery Engine |
| 6 | Dashboard |
| 7 | Nice-to-haves |
| 8 | Demo prep |

## Local setup

1. Copy `.env.example` → `.env` and fill values.
2. Run SigNoz (self-host via Foundry under `infra/signoz`, or SigNoz Cloud).
3. Backend:

```bash
cd backend
npm install
npm run typecheck
npm run otel:test   # Phase 0: confirm a span in SigNoz
npm run dev
```

4. Dashboard:

```bash
cd dashboard
npm install
npm run typecheck
npm run dev
```

## Pull requests

- Prefer small, phase-aligned PRs (see `CURSOR_GUIDE.md` §8).
- Use the PR template.
- CI must pass (backend typecheck, dashboard typecheck + build).
- Never commit `.env`, API keys, or local SigNoz `pours/` / Foundry binaries.

## Terminology lock

Use the exact names from the guide in code and UI: `Supervisor`, `PolicyEngine`, `Checkpoint`, `RecoveryEngine`, `ExplanationLayer`, etc.
