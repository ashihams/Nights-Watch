#!/usr/bin/env bash
set -euo pipefail

echo "[1] waiting for SigNoz healthy..."
for i in $(seq 1 60); do
  UI_OK=0
  OTLP_OK=0
  if curl -sf -m 2 http://127.0.0.1:8080/api/v1/health >/dev/null 2>&1; then UI_OK=1; fi
  CODE=$(curl -s -m 2 -o /dev/null -w "%{http_code}" -X POST http://127.0.0.1:4318/v1/traces \
    -H "Content-Type: application/json" -d '{"resourceSpans":[]}' || true)
  if [ "$CODE" = "200" ] || [ "$CODE" = "201" ] || [ "$CODE" = "204" ] || [ "$CODE" = "400" ]; then
    # 400 on empty is still proof the collector is accepting OTLP HTTP
    OTLP_OK=1
  fi
  echo "  try=$i ui=$UI_OK otlp_code=$CODE"
  if [ "$UI_OK" = "1" ] && [ "$OTLP_OK" = "1" ]; then
    break
  fi
  sleep 5
done

if ! curl -sf -m 3 http://127.0.0.1:8080/api/v1/health >/dev/null; then
  echo "FAIL: SigNoz UI never became healthy"
  sudo docker ps --format '{{.Names}}|{{.Status}}'
  exit 1
fi

echo "[2] UI health OK: $(curl -sS -m 3 http://127.0.0.1:8080/api/v1/health)"

TRACE_ID=$(openssl rand -hex 16)
SPAN_ID=$(openssl rand -hex 8)
NOW_NS=$(date +%s%N)
SENT_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)

cat > /tmp/nw-test-span.json <<EOF
{
  "resourceSpans": [{
    "resource": {
      "attributes": [
        {"key": "service.name", "value": {"stringValue": "nights-watch"}}
      ]
    },
    "scopeSpans": [{
      "scope": {"name": "nights-watch", "version": "0.1.0"},
      "spans": [{
        "traceId": "${TRACE_ID}",
        "spanId": "${SPAN_ID}",
        "name": "nights-watch.test",
        "kind": 1,
        "startTimeUnixNano": "${NOW_NS}",
        "endTimeUnixNano": "${NOW_NS}",
        "attributes": [
          {"key": "nights-watch.phase", "value": {"stringValue": "0"}},
          {"key": "nights-watch.checkpoint", "value": {"stringValue": "otel-pipeline"}},
          {"key": "test.purpose", "value": {"stringValue": "Confirm OTel to SigNoz ingestion"}},
          {"key": "test.sent_at", "value": {"stringValue": "${SENT_AT}"}}
        ],
        "status": {"code": 1}
      }]
    }]
  }]
}
EOF

echo "[3] sending nights-watch.test span"
echo "    traceId=${TRACE_ID}"
echo "    sentAt=${SENT_AT}"
SEND_CODE=$(curl -sS -m 10 -o /tmp/otlp2.txt -w "%{http_code}" \
  -X POST http://127.0.0.1:4318/v1/traces \
  -H "Content-Type: application/json" \
  -d @/tmp/nw-test-span.json)
echo "    OTLP HTTP status=${SEND_CODE} body=$(cat /tmp/otlp2.txt)"
echo "${TRACE_ID}" > /tmp/nw-trace-id.txt

echo "[4] waiting 8s for ingestion..."
sleep 8

END_MS=$(date +%s%3N)
START_MS=$((END_MS - 900000))

echo "[5] services API"
curl -sS -m 10 http://127.0.0.1:8080/api/v1/services \
  -H 'Content-Type: application/json' \
  -d "{\"start\":\"${START_MS}\",\"end\":\"${END_MS}\"}" | head -c 3000
echo
echo

echo "[6] query_range for service nights-watch"
PAYLOAD=$(cat <<EOF
{
  "start": ${START_MS},
  "end": ${END_MS},
  "requestType": "raw",
  "compositeQuery": {
    "queryType": "builder",
    "panelType": "list",
    "builderQueries": {
      "A": {
        "dataSource": "traces",
        "queryName": "A",
        "aggregateOperator": "noop",
        "filters": {
          "items": [
            {
              "key": {"key": "service.name", "type": "tag", "dataType": "string"},
              "op": "=",
              "value": "nights-watch"
            }
          ],
          "op": "AND"
        },
        "expression": "A",
        "orderBy": [{"columnName": "timestamp", "order": "desc"}],
        "offset": 0,
        "pageSize": 10,
        "selectColumns": [
          {"key": "service.name", "dataType": "string", "type": "tag"},
          {"key": "name", "dataType": "string", "type": "tag"}
        ]
      }
    }
  }
}
EOF
)

curl -sS -m 20 http://127.0.0.1:8080/api/v4/query_range \
  -H 'Content-Type: application/json' \
  -d "${PAYLOAD}" | head -c 5000
echo
echo
echo "[done] Open SigNoz UI Traces and filter service.name = nights-watch"
echo "       traceId=${TRACE_ID}"
