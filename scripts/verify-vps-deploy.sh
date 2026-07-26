#!/usr/bin/env bash
# Run on the VPS after Foundry + compose are up.
# Usage: ./scripts/verify-vps-deploy.sh [public-base-url]
# Example: ./scripts/verify-vps-deploy.sh https://nights-watch.example.com
set -euo pipefail

PUBLIC_URL="${1:-}"
BACKEND_CONTAINER="${BACKEND_CONTAINER:-$(docker compose ps -q backend 2>/dev/null || true)}"

echo "==> 1. Backend health (loopback)"
curl -sfS --max-time 5 "http://127.0.0.1:3001/health" | head -c 200
echo

echo "==> 2. Dashboard (loopback)"
code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:5173/" || true)
echo "HTTP $code (expect 200)"
test "$code" = "200"

echo "==> 3. host.docker.internal → SigNoz from backend container"
if [[ -z "$BACKEND_CONTAINER" ]]; then
  echo "WARN: backend container id not found; skipping in-container checks"
else
  docker exec "$BACKEND_CONTAINER" node -e "
    (async () => {
      const health = 'http://host.docker.internal:8080/api/v1/health';
      try {
        const r = await fetch(health);
        console.log(health, '→', r.status);
        if (!r.ok) process.exit(1);
      } catch (e) {
        console.error(health, '→ FAIL', e.message);
        process.exit(1);
      }
      const otlp = 'http://host.docker.internal:4318';
      try {
        const r = await fetch(otlp);
        console.log(otlp, '→', r.status, '(any HTTP response means host-gateway works)');
      } catch (e) {
        console.error(otlp, '→ FAIL', e.message);
        process.exit(1);
      }
    })();
  "
fi

echo "==> 4. SigNoz must NOT be reachable on the public interface"
# Best-effort: if PUBLIC_HOST is set, probe remote; otherwise skip.
if [[ -n "${PUBLIC_HOST:-}" ]]; then
  for p in 8080 8000 4318; do
    if timeout 2 bash -c "echo >/dev/tcp/${PUBLIC_HOST}/${p}" 2>/dev/null; then
      echo "FAIL: port $p open on PUBLIC_HOST=$PUBLIC_HOST — close firewall / rebind to 127.0.0.1"
      exit 1
    else
      echo "OK: $p not accepting on $PUBLIC_HOST"
    fi
  done
else
  echo "SKIP (set PUBLIC_HOST=your.vps.ip to probe). Ensure ufw denies 8080/8000/4317/4318."
fi

if [[ -n "$PUBLIC_URL" ]]; then
  echo "==> 5. Public control-room URL"
  pcode=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 15 "$PUBLIC_URL/" || true)
  echo "$PUBLIC_URL → HTTP $pcode"
  [[ "$pcode" == "200" || "$pcode" == "301" || "$pcode" == "302" ]]
  hcode=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 15 "$PUBLIC_URL/api/health" || true)
  echo "$PUBLIC_URL/api/health → HTTP $hcode (expect 200)"
  [[ "$hcode" == "200" ]]
else
  echo "==> 5. Public URL SKIP (pass base URL as arg after tunnel/Caddy is up)"
fi

echo
echo "Manual gates (not automated here):"
echo "  - Phone on mobile data: open PUBLIC_URL, Start run (inject drift) → Reject & recover → complete"
echo "  - Stop SigNoz once; confirm control room still loads and degrades (no hard crash)"
echo "  - Ops SigNoz UI: ssh -L 8080:127.0.0.1:8080 user@vps  →  http://localhost:8080"
echo "DONE (automated checks passed)"
