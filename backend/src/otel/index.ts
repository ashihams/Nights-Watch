/**
 * Shared OpenTelemetry helpers for Nights Watch.
 * Every span/metric emission in the backend must go through this module —
 * do not scatter raw OTel SDK calls across other packages.
 */
import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { Resource } from "@opentelemetry/resources";
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from "@opentelemetry/semantic-conventions";
import {
  context,
  trace,
  metrics,
  SpanStatusCode,
  ROOT_CONTEXT,
  type Span,
  type SpanContext,
  type Tracer,
  type Meter,
  type Gauge,
} from "@opentelemetry/api";
import { config } from "../config/index.js";

let sdk: NodeSDK | null = null;
let initialized = false;
let policyScoreGauge: Gauge | null = null;

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

/** Start the OTel Node SDK (traces + metrics → SigNoz OTLP HTTP). Safe to call once. */
export function initOtel(): void {
  if (initialized) return;

  const headers = parseOtelHeaders(config.otel.headers);
  const endpoint = config.otel.endpoint.replace(/\/$/, "");
  const traceExporter = new OTLPTraceExporter({
    url: `${endpoint}/v1/traces`,
    headers,
  });
  const metricExporter = new OTLPMetricExporter({
    url: `${endpoint}/v1/metrics`,
    headers,
  });

  sdk = new NodeSDK({
    resource: new Resource({
      [ATTR_SERVICE_NAME]: config.otel.serviceName,
      [ATTR_SERVICE_VERSION]: "0.1.0",
      "deployment.environment": config.nodeEnv,
    }),
    traceExporter,
    metricReader: new PeriodicExportingMetricReader({
      exporter: metricExporter,
      exportIntervalMillis: 5_000,
    }),
  });

  sdk.start();
  initialized = true;

  const meter = getMeter();
  policyScoreGauge = meter.createGauge("nights_watch.policy_score", {
    description: "Policy Score (0–100) per evaluation",
    unit: "1",
  });

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
  policyScoreGauge = null;
  console.log("[otel] shut down");
}

export function getTracer(name = "nights-watch"): Tracer {
  return trace.getTracer(name, "0.1.0");
}

export function getMeter(name = "nights-watch"): Meter {
  return metrics.getMeter(name, "0.1.0");
}

/** Record Policy Score gauge (Phase 3+). */
export function recordPolicyScore(
  score: number,
  attrs: Record<string, string> = {},
): void {
  if (!policyScoreGauge) {
    // Lazy init if initOtel already ran but gauge missing
    try {
      policyScoreGauge = getMeter().createGauge("nights_watch.policy_score", {
        description: "Policy Score (0–100) per evaluation",
        unit: "1",
      });
    } catch {
      return;
    }
  }
  policyScoreGauge.record(score, attrs);
}

/** Canonical span names used across the project (Section 8 / OTel helpers). */
export const SpanNames = {
  TEST: "nights-watch.test",
  RUN_EXECUTE: "run.execute",
  PLAN_GENERATED: "plan.generated",
  EXECUTOR_STEP: "executor.step",
  CHECKPOINT_CREATED: "checkpoint.created",
  POLICY_EVALUATION: "policy.evaluation",
  POLICY_EXPLANATION: "policy.explanation",
  CHECKPOINT_RESTORED: "checkpoint.restored",
  RECOVERY_OUTCOME: "recovery.outcome",
} as const;

/** Start a long-lived parent span (e.g. a full run). Caller must end it. */
export function startParentSpan(
  name: string,
  attributes: Record<string, string | number | boolean> = {},
): Span {
  const span = getTracer().startSpan(name);
  for (const [key, value] of Object.entries(attributes)) {
    span.setAttribute(key, value);
  }
  return span;
}

/** Run work as a child of a stored parent SpanContext (e.g. async webhook). */
export async function withChildSpan<T>(
  parent: SpanContext,
  name: string,
  attributes: Record<string, string | number | boolean>,
  fn: (span: Span) => Promise<T> | T,
): Promise<T> {
  const ctx = trace.setSpanContext(ROOT_CONTEXT, parent);
  const tracer = getTracer();
  return context.with(ctx, () =>
    tracer.startActiveSpan(name, async (span) => {
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
    }),
  );
}

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
