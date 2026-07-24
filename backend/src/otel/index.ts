/**
 * Shared OpenTelemetry helpers for Nights Watch.
 * Every span/metric emission in the backend must go through this module —
 * do not scatter raw OTel SDK calls across other packages.
 */
import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { Resource } from "@opentelemetry/resources";
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from "@opentelemetry/semantic-conventions";
import {
  trace,
  SpanStatusCode,
  type Span,
  type Tracer,
} from "@opentelemetry/api";
import { config } from "../config/index.js";

let sdk: NodeSDK | null = null;
let initialized = false;

function parseOtelHeaders(raw: string): Record<string, string> {
  if (!raw.trim()) return {};
  const headers: Record<string, string> = {};
  for (const part of raw.split(",")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key) headers[key] = value;
  }
  return headers;
}

/** Start the OTel Node SDK (traces → SigNoz OTLP HTTP). Safe to call once. */
export function initOtel(): void {
  if (initialized) return;

  const headers = parseOtelHeaders(config.otel.headers);
  const traceExporter = new OTLPTraceExporter({
    url: `${config.otel.endpoint.replace(/\/$/, "")}/v1/traces`,
    headers,
  });

  sdk = new NodeSDK({
    resource: new Resource({
      [ATTR_SERVICE_NAME]: config.otel.serviceName,
      [ATTR_SERVICE_VERSION]: "0.1.0",
      "deployment.environment": config.nodeEnv,
    }),
    traceExporter,
  });

  sdk.start();
  initialized = true;
  console.log(
    `[otel] initialized → ${config.otel.endpoint} (service=${config.otel.serviceName})`,
  );
}

/** Flush and shut down exporters. Call before process exit. */
export async function shutdownOtel(): Promise<void> {
  if (!sdk) return;
  await sdk.shutdown();
  sdk = null;
  initialized = false;
  console.log("[otel] shut down");
}

export function getTracer(name = "nights-watch"): Tracer {
  return trace.getTracer(name, "0.1.0");
}

/** Canonical span names used across the project (Section 8 / OTel helpers). */
export const SpanNames = {
  TEST: "nights-watch.test",
  CHECKPOINT_CREATED: "checkpoint.created",
  POLICY_EVALUATION: "policy.evaluation",
  POLICY_EXPLANATION: "policy.explanation",
  CHECKPOINT_RESTORED: "checkpoint.restored",
  RECOVERY_OUTCOME: "recovery.outcome",
} as const;

export async function withSpan<T>(
  name: string,
  attributes: Record<string, string | number | boolean>,
  fn: (span: Span) => Promise<T> | T,
): Promise<T> {
  const tracer = getTracer();
  return tracer.startActiveSpan(name, async (span) => {
    try {
      for (const [key, value] of Object.entries(attributes)) {
        span.setAttribute(key, value);
      }
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      span.setStatus({ code: SpanStatusCode.ERROR, message });
      span.recordException(err instanceof Error ? err : new Error(message));
      throw err;
    } finally {
      span.end();
    }
  });
}
