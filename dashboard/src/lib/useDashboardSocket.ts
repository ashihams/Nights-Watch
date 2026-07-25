import { startTransition, useEffect, useRef } from "react";
import type {
  CheckpointEvent,
  ExplanationEvent,
  RunSummary,
} from "./types";

type Handlers = {
  onRunUpdate: (run: RunSummary) => void;
  onExplanation: (event: ExplanationEvent) => void;
  onCheckpoint: (event: CheckpointEvent) => void;
  onHello?: (explanations: ExplanationEvent[]) => void;
};

export function useDashboardSocket(handlers: Handlers): void {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    const proto = window.location.protocol === "https:" ? "wss" : "ws";
    const url = `${proto}://${window.location.host}/ws`;
    let socket: WebSocket | null = null;
    let closed = false;
    let retryMs = 1000;

    const connect = () => {
      if (closed) return;
      socket = new WebSocket(url);
      socket.onopen = () => {
        retryMs = 1000;
      };
      socket.onmessage = (msg) => {
        try {
          const data = JSON.parse(String(msg.data)) as Record<string, unknown>;
          const type = String(data.type ?? "");

          startTransition(() => {
            if (type === "hello" && Array.isArray(data.recentExplanations)) {
              handlersRef.current.onHello?.(
                data.recentExplanations as ExplanationEvent[],
              );
            } else if (type === "run_update" && data.run) {
              handlersRef.current.onRunUpdate(data.run as RunSummary);
            } else if (type === "explanation") {
              handlersRef.current.onExplanation(data as ExplanationEvent);
            } else if (type === "checkpoint") {
              handlersRef.current.onCheckpoint(data as CheckpointEvent);
            }
          });
        } catch {
          // ignore malformed frames
        }
      };
      socket.onclose = () => {
        if (closed) return;
        window.setTimeout(connect, retryMs);
        retryMs = Math.min(retryMs * 1.5, 8000);
      };
    };

    connect();
    return () => {
      closed = true;
      socket?.close();
    };
  }, []);
}
