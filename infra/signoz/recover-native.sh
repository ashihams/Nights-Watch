#!/usr/bin/env bash
set -euo pipefail
cd /mnt/d/project/SignozHack/infra/signoz/pours/deployment

sudo docker compose up -d
echo "COMPOSE_UP_OK"

health_of() {
  local name="$1"
  sudo docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$name" 2>/dev/null || echo missing
}

status_of() {
  local name="$1"
  sudo docker inspect -f '{{.State.Status}}' "$name" 2>/dev/null || echo missing
}

for i in $(seq 1 48); do
  pg=$(health_of signoz-metastore-postgres-0)
  ui=$(health_of signoz-signoz-0)
  ch=$(health_of signoz-telemetrystore-clickhouse-0-0)
  kp=$(health_of signoz-telemetrykeeper-clickhousekeeper-0)
  ing=$(status_of signoz-ingester-1)
  mcp=$(status_of signoz-mcp)
  echo "try=$i pg=$pg ui=$ui ch=$ch keeper=$kp ingester=$ing mcp=$mcp"
  if [ "$pg" = healthy ] && [ "$ui" = healthy ] && [ "$ch" = healthy ] && [ "$kp" = healthy ] && [ "$ing" = running ] && [ "$mcp" = running ]; then
    echo ALL_HEALTHY
    break
  fi
  sleep 5
done

echo "==== docker ps ===="
sudo docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'

echo "==== verify inside WSL ===="
curl -sf -m 5 http://127.0.0.1:8080/api/v1/health; echo
curl -sf -m 5 http://127.0.0.1:8000/livez; echo
curl -s -m 5 -o /dev/null -w "OTLP_HTTP=%{http_code}\n" -X POST http://127.0.0.1:4318/v1/traces -H 'Content-Type: application/json' -d '{"resourceSpans":[]}' || echo "OTLP_HTTP_FAIL"
ss -lntp | grep -E ':4317|:4318|:8080|:8000' || true

echo "==== WSL IP ===="
hostname -I | awk '{print $1}'
