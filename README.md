# Nights Watch

Runtime resilience for AI agents — **SigNoz as a control plane**, not a passive dashboard.

An n8n (or CLI) travel-booking agent executes a plan. A TypeScript supervisor scores every step against that plan, explains violations in plain language, rolls back to a local checkpoint, re-plans, and resumes — without restarting from scratch.

Companion docs: [`PROJECT_OVERVIEW.md`](./PROJECT_OVERVIEW.md) · [`CURSOR_GUIDE.md`](./CURSOR_GUIDE.md) · [`CONTRIBUTING.md`](./CONTRIBUTING.md)

## Status

| Phase | Focus | Status |
|---|---|---|
| 0 | Scaffold + OTel → SigNoz | Done |
| 1 | Plan + Executor (n8n / happy-path harness) | Done |
| 2 | Checkpoint Manager (SQLite + `checkpoint.created`) | Done |
| 3 | Policy Engine (rules + Query API + score) | Done |
| 4 | Explanation Layer (MCP + LLM + `policy.explanation`) | Done |
| 5 | Recovery Engine (rollback → re-plan → resume) | Done |
| 6 | Live React dashboard | Next |
| 7 | Nice-to-haves (human approval → irreversible CP) | Later |
| 8 | Demo prep | Later |

## Architecture (short)

```
Planner → Executor (n8n or happy-path) → Supervisor
              ↓                              ↓
         step reports              Policy → Explain → Recover
              ↓                              ↓
         OTel spans ──────────→ SigNoz (Query API + MCP + traces)
              ↓
    Local SQLite checkpoints (source of truth for rollback)
```

- **Query API** — Policy Engine decision support (prior scores / context).
- **MCP** — Explanation Layer only (exploratory context for the LLM).
- **Never** reconstruct rollback state from SigNoz — only from local checkpoints.

## Repo layout

```
backend/            Fastify + OTel + policy / checkpoints / recovery / explanation
dashboard/          React + Vite + Tailwind (Phase 6)
n8n-workflows/      travel-booking Executor export
infra/signoz/       Self-host helpers (WSL / Windows port-forward)
docker-compose.yml  Backend + dashboard only (SigNoz stays separate)
```

## Quick start

```bash
cp .env.example .env
# Set OTEL_EXPORTER_OTLP_ENDPOINT, SIGNOZ_* , and optionally LLM keys

# SigNoz must already be running (see infra/signoz/)
cd backend && npm install && npm run dev
```

In another terminal:

```bash
cd backend
npm run happy-path          # clean booking under $400
npm run happy-path:drift    # $1200 upgrade → policy → explain → rollback → resume → book
```

Optional UI scaffold:

```bash
cd dashboard && npm install && npm run dev   # http://localhost:5173
```

### Docker (backend + dashboard)

SigNoz is **not** in this compose file — point env at `host.docker.internal` (defaults in `docker-compose.yml`).

```bash
docker compose up --build
# API    http://localhost:3001/health
# UI     http://localhost:5173  (/api and /ws proxied to backend)
```

### Verify a run in SigNoz

After a harness run, note `run.id` from the logs, then:

1. SigNoz → Traces → filter `service.name = nights-watch` and `run.id = <id>`
2. Open the **`run.execute`** waterfall (child spans, not root-only):  
   `executor.step`, `checkpoint.created`, `policy.evaluation`, `policy.explanation`, `checkpoint.restored`, `recovery.outcome`
3. Or CLI (ClickHouse via WSL): `cd backend && npm run spans:verify -- <runId>`  
   Local checkpoints: `npm run checkpoints:list -- <runId>`

### Self-hosted SigNoz (Windows + WSL)

Helpers under `infra/signoz/` (`casting.yaml`, `expose-ports-to-windows.ps1`, `stabilize-signoz-ui.sh`, etc.). Prefer **native Docker Engine in Ubuntu WSL** over Docker Desktop for stability.

## Demo path (judges)

1. Start backend (`npm run dev` or `docker compose up`).
2. Run `npm run happy-path:drift`.
3. In SigNoz, open that `run.id` → show score spike, explanation, rollback, resume, completed booking.
4. (Phase 6) Watch the same events live on the dashboard via `/ws`.

## CI

GitHub Actions on push/PR to `main`:

- Backend `npm run typecheck`
- Dashboard `npm run typecheck` + `npm run build`
- Sanity check that `.env` is not tracked

## License

MIT — see [`LICENSE`](./LICENSE).
