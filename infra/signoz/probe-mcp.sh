#!/usr/bin/env bash
# Quick probe of SigNoz MCP /mcp JSON-RPC
set -eu
BASE="${1:-http://127.0.0.1:8000}"
echo "livez: $(curl -s -m 3 "$BASE/livez" || true)"
INIT=$(curl -s -m 10 -D /tmp/mcp-hdrs.txt -X POST "$BASE/mcp" \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"nights-watch-probe","version":"0.1.0"}}}')
echo "init body: $(echo "$INIT" | head -c 400)"
echo "headers:"; grep -i 'mcp-session\|content-type' /tmp/mcp-hdrs.txt || true
SESSION=$(grep -i 'mcp-session-id:' /tmp/mcp-hdrs.txt | awk '{print $2}' | tr -d '\r')
echo "session=$SESSION"
if [ -n "$SESSION" ]; then
  curl -s -m 10 -X POST "$BASE/mcp" \
    -H 'content-type: application/json' \
    -H 'accept: application/json, text/event-stream' \
    -H "mcp-session-id: $SESSION" \
    -d '{"jsonrpc":"2.0","method":"notifications/initialized"}' || true
  echo
  curl -s -m 15 -X POST "$BASE/mcp" \
    -H 'content-type: application/json' \
    -H 'accept: application/json, text/event-stream' \
    -H "mcp-session-id: $SESSION" \
    -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' | head -c 800
  echo
fi
