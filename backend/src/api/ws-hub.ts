/**
 * In-process WebSocket hub for dashboard live updates.
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

export type CheckpointEvent = {
  type: "checkpoint";
  runId: string;
  checkpointId: string;
  label: string;
  index: number;
  timestamp: string;
};

/** Full run snapshot for live dashboard panels. */
export type RunUpdateEvent = {
  type: "run_update";
  run: Record<string, unknown>;
};

export type HelloEvent = {
  type: "hello";
  recentExplanations: ExplanationEvent[];
};

export type DashboardWsEvent =
  | ExplanationEvent
  | CheckpointEvent
  | RunUpdateEvent
  | HelloEvent;

let wss: WebSocketServer | null = null;
const clients = new Set<WebSocket>();
const recentExplanations: ExplanationEvent[] = [];

function broadcastRaw(event: DashboardWsEvent): void {
  const raw = JSON.stringify(event);
  for (const c of clients) {
    if (c.readyState === c.OPEN) c.send(raw);
  }
}

export function attachDashboardWs(server: Server): void {
  wss = new WebSocketServer({ server, path: "/ws" });
  wss.on("connection", (socket) => {
    clients.add(socket);
    socket.send(
      JSON.stringify({
        type: "hello",
        recentExplanations: recentExplanations.slice(-20),
      } satisfies HelloEvent),
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
  broadcastRaw(event);
  console.log(
    `[ws] broadcast explanation to ${clients.size} client(s) run=${event.runId}`,
  );
}

export function broadcastCheckpoint(
  payload: Omit<CheckpointEvent, "type">,
): void {
  const event: CheckpointEvent = { type: "checkpoint", ...payload };
  broadcastRaw(event);
  console.log(
    `[ws] broadcast checkpoint to ${clients.size} client(s) run=${event.runId} id=${event.checkpointId}`,
  );
}

export function broadcastRunUpdate(run: Record<string, unknown>): void {
  broadcastRaw({ type: "run_update", run });
}

export function getRecentExplanations(): ExplanationEvent[] {
  return [...recentExplanations];
}
