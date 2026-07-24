#!/usr/bin/env bash
set -euo pipefail
echo "=== health ==="
curl -sS -m 5 http://127.0.0.1:8080/api/v1/health
echo
echo "=== otlp empty ==="
curl -sS -m 5 -o /tmp/otlp.txt -w "OTLP=%{http_code}\n" \
  -X POST http://127.0.0.1:4318/v1/traces \
  -H "Content-Type: application/json" \
  -d '{"resourceSpans":[]}'
echo "OTLP_BODY=$(cat /tmp/otlp.txt)"

# Build a minimal OTLP JSON span for nights-watch.test
TRACE_ID=$(openssl rand -hex 16)
SPAN_ID=$(openssl rand -hex 8)
NOW_NS=$(date +%s%N)

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
          {"key": "test.purpose", "value": {"stringValue": "Confirm OTel to SigNoz ingestion"}}
        ],
        "status": {"code": 1}
      }]
    }]
  }]
}
EOF

echo "=== send test span ==="
echo "traceId=${TRACE_ID}"
curl -sS -m 10 -o /tmp/otlp2.txt -w "SEND=%{http_code}\n" \
  -X POST http://127.0.0.1:4318/v1/traces \
  -H "Content-Type: application/json" \
  -d @/tmp/nw-test-span.json
echo "SEND_BODY=$(cat /tmp/otlp2.txt)"
echo "${TRACE_ID}" > /tmp/nw-trace-id.txt
