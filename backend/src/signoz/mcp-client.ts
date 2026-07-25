/**
 * SigNoz MCP client — Explanation Layer only.
 * Access pattern: MCP HTTP (/mcp). Never the Query API.
 * Failures are surfaced explicitly; callers must not silently substitute Query API.
 */
import { config } from "../config/index.js";

export interface McpToolCallResult {
  invoked: true;
  toolName: string;
  ok: boolean;
  text: string;
  error?: string;
  sessionId?: string;
}

export type McpGatherResult = McpToolCallResult;

function mcpBase(): string {
  const raw =
    config.signoz.mcpEndpoint.trim() ||
    process.env.SIGNOZ_MCP_ENDPOINT?.trim() ||
    "http://localhost:8000";
  return raw.replace(/\/$/, "").replace(/\/mcp$/, "");
}

function parseSseOrJson(body: string): unknown {
  // Streamable HTTP may return SSE: event: message\ndata: {...}
  if (body.includes("data:")) {
    const lines = body.split("\n");
    for (const line of lines) {
      if (line.startsWith("data:")) {
        const payload = line.slice(5).trim();
        if (payload && payload !== "[DONE]") {
          try {
            return JSON.parse(payload);
          } catch {
            /* continue */
          }
        }
      }
    }
  }
  return JSON.parse(body) as unknown;
}

async function mcpRpc(
  method: string,
  params: Record<string, unknown> | undefined,
  sessionId: string | undefined,
  id: number,
): Promise<{ json: unknown; sessionId?: string; status: number; raw: string }> {
  const url = `${mcpBase()}/mcp`;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  if (config.signoz.mcpToken) {
    headers["SIGNOZ-API-KEY"] = config.signoz.mcpToken;
  }
  if (sessionId) headers["mcp-session-id"] = sessionId;

  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method,
      ...(params ? { params } : {}),
    }),
    signal: AbortSignal.timeout(12_000),
  });
  const raw = await res.text();
  const newSession =
    res.headers.get("mcp-session-id") ??
    res.headers.get("Mcp-Session-Id") ??
    sessionId;
  let json: unknown = null;
  try {
    json = raw ? parseSseOrJson(raw) : null;
  } catch {
    json = { parseError: true, raw: raw.slice(0, 500) };
  }
  return { json, sessionId: newSession ?? undefined, status: res.status, raw };
}

function extractToolText(json: unknown): string {
  if (!json || typeof json !== "object") return "";
  const obj = json as Record<string, unknown>;
  const result = obj.result as Record<string, unknown> | undefined;
  if (!result) {
    const err = obj.error as { message?: string } | undefined;
    return err?.message ? `MCP error: ${err.message}` : JSON.stringify(obj).slice(0, 1500);
  }
  const content = result.content;
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        if (c && typeof c === "object" && "text" in c) {
          return String((c as { text: unknown }).text);
        }
        return JSON.stringify(c);
      })
      .join("\n")
      .slice(0, 4000);
  }
  return JSON.stringify(result).slice(0, 4000);
}

/**
 * Gather exploratory context via SigNoz MCP (signoz_search_traces).
 * Always logs a distinct [signoz-mcp] line so we can prove invocation.
 */
export async function gatherMcpContext(input: {
  runId: string;
  serviceName?: string;
}): Promise<McpGatherResult> {
  const service = input.serviceName ?? config.otel.serviceName;
  console.log(
    `[signoz-mcp] INVOKING tools/call signoz_search_traces run=${input.runId} endpoint=${mcpBase()}/mcp`,
  );

  try {
    const init = await mcpRpc(
      "initialize",
      {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "nights-watch-explanation", version: "0.1.0" },
      },
      undefined,
      1,
    );
    if (init.status >= 400) {
      console.warn(
        `[signoz-mcp] initialize failed status=${init.status} body=${init.raw.slice(0, 200)}`,
      );
      return {
        invoked: true,
        toolName: "initialize",
        ok: false,
        text: "",
        error: `initialize HTTP ${init.status}`,
      };
    }

    const sessionId = init.sessionId;
    // notifications/initialized (no id)
    await fetch(`${mcpBase()}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(sessionId ? { "mcp-session-id": sessionId } : {}),
        ...(config.signoz.mcpToken
          ? { "SIGNOZ-API-KEY": config.signoz.mcpToken }
          : {}),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/initialized",
      }),
      signal: AbortSignal.timeout(5_000),
    }).catch(() => undefined);

    const end = new Date();
    const start = new Date(end.getTime() - 6 * 60 * 60 * 1000);
    const call = await mcpRpc(
      "tools/call",
      {
        name: "signoz_search_traces",
        arguments: {
          service: service,
          start: start.toISOString(),
          end: end.toISOString(),
          // Keep filter loose — MCP schemas vary by version
          query: `run.id = '${input.runId}' OR service.name = '${service}'`,
          limit: 10,
        },
      },
      sessionId,
      2,
    );

    const text = extractToolText(call.json);
    const ok = call.status < 400 && !text.startsWith("MCP error:");
    console.log(
      `[signoz-mcp] tools/call done ok=${ok} status=${call.status} bytes=${text.length}`,
    );
    return {
      invoked: true,
      toolName: "signoz_search_traces",
      ok,
      text,
      error: ok ? undefined : text || `HTTP ${call.status}`,
      sessionId,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[signoz-mcp] INVOCATION FAILED: ${message}`);
    return {
      invoked: true,
      toolName: "signoz_search_traces",
      ok: false,
      text: "",
      error: message,
    };
  }
}
