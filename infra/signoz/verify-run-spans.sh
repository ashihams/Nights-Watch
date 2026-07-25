#!/usr/bin/env bash
# Verify nights-watch spans in ClickHouse without the SigNoz UI.
# Usage (from Windows):
#   wsl -d Ubuntu -- bash /mnt/d/project/SignozHack/infra/signoz/verify-run-spans.sh run-XXXX
# Or via npm:
#   cd backend && npm run spans:verify -- run-XXXX
set -eu

RUN_ID="${1:-}"
if [ -z "$RUN_ID" ]; then
  echo "Usage: $0 <runId>"
  echo "Example: $0 run-2a843bb4"
  exit 1
fi

CH=(docker exec signoz-telemetrystore-clickhouse-0-0 clickhouse-client -q)

echo "=== SigNoz ClickHouse spans for run.id=$RUN_ID ==="

# Prefer attribute map columns used by SigNoz index v3.
SQL_SPANS=$(cat <<EOF
SELECT
  name,
  count() AS c,
  any(hex(traceID)) AS sample_trace
FROM signoz_traces.distributed_signoz_index_v3
WHERE serviceName = 'nights-watch'
  AND (
    stringTagMap['run.id'] = '${RUN_ID}'
    OR numberTagMap['run.id'] = toFloat64OrZero('${RUN_ID}')
  )
GROUP BY name
ORDER BY name
EOF
)

if ! "${CH[@]}" "$SQL_SPANS" 2>/tmp/nw-ch-err.txt; then
  # Fallback: scan attributes JSON-ish via resource/string maps if column names differ
  echo "Primary query failed; probing schema..."
  cat /tmp/nw-ch-err.txt || true
  "${CH[@]}" "DESCRIBE TABLE signoz_traces.distributed_signoz_index_v3" | head -40 || true
  SQL_FALLBACK=$(cat <<EOF
SELECT name, count() AS c
FROM signoz_traces.distributed_signoz_index_v3
WHERE serviceName = 'nights-watch'
  AND positionCaseInsensitive(toString(stringTagMap), '${RUN_ID}') > 0
GROUP BY name
ORDER BY name
EOF
)
  "${CH[@]}" "$SQL_FALLBACK"
fi

echo
echo "=== checkpoint.created detail ==="
SQL_CP=$(cat <<EOF
SELECT
  stringTagMap['checkpoint.id'] AS checkpoint_id,
  stringTagMap['checkpoint.label'] AS label,
  toString(numberTagMap['checkpoint.index']) AS idx,
  toString(numberTagMap['checkpoint.budgetConsumed']) AS budget,
  formatDateTime(timestamp, '%F %T') AS ts
FROM signoz_traces.distributed_signoz_index_v3
WHERE serviceName = 'nights-watch'
  AND name = 'checkpoint.created'
  AND stringTagMap['run.id'] = '${RUN_ID}'
ORDER BY timestamp ASC
EOF
)
"${CH[@]}" "$SQL_CP" 2>/dev/null || echo "(checkpoint detail query unavailable — check schema)"

echo
echo "=== policy.evaluation detail (if any) ==="
SQL_POL=$(cat <<EOF
SELECT
  toString(numberTagMap['policy.score']) AS score,
  stringTagMap['checkpoint.id'] AS checkpoint_id,
  stringTagMap['step.id'] AS step_id,
  formatDateTime(timestamp, '%F %T') AS ts
FROM signoz_traces.distributed_signoz_index_v3
WHERE serviceName = 'nights-watch'
  AND name = 'policy.evaluation'
  AND stringTagMap['run.id'] = '${RUN_ID}'
ORDER BY timestamp ASC
EOF
)
"${CH[@]}" "$SQL_POL" 2>/dev/null || echo "(no policy.evaluation spans yet)"

echo
echo "=== expected Phase 2 checklist ==="
echo "  run.execute              >= 1"
echo "  executor.step            = 4"
echo "  checkpoint.created       = 4"
echo "Cross-check local SQLite: cd backend && npm run checkpoints:list -- ${RUN_ID}"
