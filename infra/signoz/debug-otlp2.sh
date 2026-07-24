#!/usr/bin/env bash
set -euo pipefail
INGESTER_IP=$(sudo docker inspect signoz-ingester-1 --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}')
echo "INGESTER_IP=${INGESTER_IP}"

echo "=== listening sockets via /proc ==="
sudo docker exec signoz-ingester-1 sh -c 'cat /proc/net/tcp /proc/net/tcp6 2>/dev/null | head -40'

echo "=== try grpc 4317 with curl http (expect fail) ==="
curl -sv -m 3 http://127.0.0.1:4317/ 2>&1 | tail -15 || true

echo "=== collector process ==="
sudo docker exec signoz-ingester-1 sh -c 'ps aux | head -20'

echo "=== recent collector logs filtered ==="
sudo docker logs signoz-ingester-1 2>&1 | grep -Ei 'otlp|4318|4317|receiver|error|Started|Listening' | tail -40
