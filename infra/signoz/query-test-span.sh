#!/usr/bin/env bash
set -euo pipefail
TRACE_ID="${1:-$(cat /tmp/nw-trace-id.txt)}"
echo "Looking for traceId=${TRACE_ID}"

# Wait for ingestion/indexing
sleep 5

# SigNoz v3 traces filter API (community/self-host)
END_MS=$(date +%s%3N)
START_MS=$((END_MS - 900000))

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
        "pageSize": 20,
        "selectColumns": [
          {"key": "service.name", "dataType": "string", "type": "tag"},
          {"key": "name", "dataType": "string", "type": "tag"},
          {"key": "durationNano", "dataType": "float64", "type": "tag"}
        ]
      }
    }
  }
}
EOF
)

echo "=== query services ==="
curl -sS -m 10 http://127.0.0.1:8080/api/v1/services -H 'Content-Type: application/json' \
  -d "{\"start\":\"${START_MS}\",\"end\":\"${END_MS}\"}" | head -c 2000
echo
echo
echo "=== query traces (builder) ==="
curl -sS -m 20 http://127.0.0.1:8080/api/v4/query_range -H 'Content-Type: application/json' \
  -d "${PAYLOAD}" | head -c 4000
echo
