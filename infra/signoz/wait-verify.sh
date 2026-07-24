#!/usr/bin/env bash
set -euo pipefail
for i in $(seq 1 30); do
  pg=$(sudo docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' signoz-metastore-postgres-0 2>/dev/null || echo missing)
  ui=$(sudo docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' signoz-signoz-0 2>/dev/null || echo missing)
  ch=$(sudo docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' signoz-telemetrystore-clickhouse-0-0 2>/dev/null || echo missing)
  ip=$(hostname -I | awk '{print $1}')
  echo "try=$i pg=$pg ui=$ui ch=$ch ip=$ip"
  if [ "$pg" = healthy ] && [ "$ui" = healthy ] && [ "$ch" = healthy ]; then
    echo "==== VERIFY ===="
    curl -sf -m 5 http://127.0.0.1:8080/api/v1/health; echo
    curl -sf -m 5 http://127.0.0.1:8000/livez; echo
    curl -s -m 5 -o /dev/null -w "OTLP_HTTP=%{http_code}\n" -X POST http://127.0.0.1:4318/v1/traces -H 'Content-Type: application/json' -d '{"resourceSpans":[]}'
    ss -lntp | grep -E ':4317|:4318|:8080|:8000' || true
    echo "==== DOCKER PS ===="
    sudo docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
    exit 0
  fi
  sleep 5
done
sudo docker ps -a --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
exit 1
