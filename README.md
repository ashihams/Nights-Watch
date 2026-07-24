# Nights Watch

Runtime resilience for AI agents — SigNoz as a **control plane**, n8n as the Executor.

Companion docs: [`PROJECT_OVERVIEW.md`](./PROJECT_OVERVIEW.md) · [`CURSOR_GUIDE.md`](./CURSOR_GUIDE.md) · [`CONTRIBUTING.md`](./CONTRIBUTING.md)

## Status

| Phase | Status |
|---|---|
| 0 — Scaffold + OTel → SigNoz | In progress / checkpoint met when test span visible |
| 1–8 | Not started |

## Repo layout

```
backend/          TypeScript + Fastify + OpenTelemetry
dashboard/        React + Vite + Tailwind
n8n-workflows/    Executor workflow exports
infra/signoz/     Foundry casting + Windows port-forward helpers
```

## Quick start

```bash
cp .env.example .env
# fill SigNoz OTLP + API keys, LLM key, n8n URL

cd backend && npm install && npm run otel:test
cd ../dashboard && npm install && npm run dev
```

Confirm a `nights-watch.test` span in SigNoz → Traces (`service.name = nights-watch`).

### Self-hosted SigNoz (Windows + WSL)

See helpers under `infra/signoz/` (`casting.yaml`, `expose-ports-to-windows.ps1`, `recover-native.sh`). Prefer **native Docker Engine inside Ubuntu WSL** over Docker Desktop for Postgres stability.

## CI

GitHub Actions runs on push/PR to `main`:

- Backend `npm run typecheck`
- Dashboard `npm run typecheck` + `npm run build`
- Sanity check that `.env` is not tracked

## License

MIT — see [`LICENSE`](./LICENSE).
