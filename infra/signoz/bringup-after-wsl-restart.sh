#!/usr/bin/env bash
set -euo pipefail
sudo service docker start
sleep 3
cd /mnt/d/project/SignozHack/infra/signoz/pours/deployment
sudo docker compose up -d
for i in $(seq 1 36); do
  pg=$(sudo docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' signoz-metastore-postgres-0 2>/dev/null || echo missing)
  ui=$(sudo docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' signoz-signoz-0 2>/dev/null || echo missing)
  echo "try=$i pg=$pg ui=$ui"
  if [ "$pg" = healthy ] && [ "$ui" = healthy ]; then
    curl -sf http://127.0.0.1:8080/api/v1/health; echo
    curl -sf http://127.0.0.1:8000/livez; echo
    hostname -I | awk '{print $1}' > /tmp/wsl-ip.txt
    cat /tmp/wsl-ip.txt
    sudo docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
    exit 0
  fi
  sleep 5
done
exit 1
