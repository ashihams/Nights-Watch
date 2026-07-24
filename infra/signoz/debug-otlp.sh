#!/usr/bin/env bash
set -euo pipefail
echo "=== ports inside ingester ==="
sudo docker exec signoz-ingester-1 sh -c "ss -lntp 2>/dev/null || netstat -lntp 2>/dev/null || true" | head -50
echo
echo "=== curl host 4318 ==="
curl -sv -m 5 -X POST http://127.0.0.1:4318/v1/traces \
  -H "Content-Type: application/json" \
  -d '{"resourceSpans":[]}' 2>&1 | tail -50
echo
INGESTER_IP=$(sudo docker inspect signoz-ingester-1 --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}')
echo "INGESTER_IP=${INGESTER_IP}"
echo "=== curl container IP 4318 ==="
curl -sv -m 5 -X POST "http://${INGESTER_IP}:4318/v1/traces" \
  -H "Content-Type: application/json" \
  -d '{"resourceSpans":[]}' 2>&1 | tail -50
echo
echo "=== healthcheck endpoint ==="
curl -sv -m 5 "http://${INGESTER_IP}:13133" 2>&1 | tail -20 || true
echo
echo "=== ingester config receivers snippet ==="
sudo docker exec signoz-ingester-1 sh -c "grep -n -A3 -E 'otlp|protocols|endpoint' /etc/otel-collector-config.yaml | head -80"
