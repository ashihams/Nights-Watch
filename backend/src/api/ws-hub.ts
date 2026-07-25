/**
 * In-process WebSocket hub for dashboard live updates (explanations, scores).
 * Attached to the HTTP server in index.ts.
 */
import { WebSocketServer, type WebSocket } from "ws";
import type { Server } from "node:http";

export type ExplanationEvent = {
  type: "explanation";
  runId: string;
  stepId: string;
  score: number;
  text: string;
  mcpInvoked: boolean;
  mcpOk: boolean;
  timestamp: string;
};

let wss: WebSocketServer | null = null;
const clients = new Set<WebSocket>();
const recentExplanations: ExplanationEvent[] = [];

export function attachDashboardWs(server: Server): void {
  wss = new WebSocketServer({ server, path: "/ws" });
  wss.on("connection", (socket) => {
    clients.add(socket);
    socket.send(
      JSON.stringify({
        type: "hello",
        recentExplanations: recentExplanations.slice(-20),
      }),
    );
    socket.on("close", () => clients.delete(socket));
    socket.on("error", () => clients.delete(socket));
  });
  console.log("[ws] dashboard hub listening on /ws");
}

export function broadcastExplanation(
  payload: Omit<ExplanationEvent, "type">,
): void {
  const event: ExplanationEvent = { type: "explanation", ...payload };
  recentExplanations.push(event);
  if (recentExplanations.length > 50) recentExplanations.shift();
  const raw = JSON.stringify(event);
  for (const c of clients) {
    if (c.readyState === c.OPEN) c.send(raw);
  }
  console.log(
    `[ws] broadcast explanation to ${clients.size} client(s) run=${event.runId}`,
  );
}

export function getRecentExplanations(): ExplanationEvent[] {
  return [...recentExplanations];
}
