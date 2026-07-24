/**
 * Phase 0 Checkpoint script: emit one manually-sent test span to SigNoz.
 * Run: npm run otel:test
 * Then confirm the span appears in the SigNoz UI (Traces → service nights-watch).
 */
import { initOtel, shutdownOtel, withSpan, SpanNames } from "./index.js";

async function main(): Promise<void> {
  initOtel();

  const sentAt = new Date().toISOString();
  await withSpan(
    SpanNames.TEST,
    {
      "nights-watch.phase": "0",
      "nights-watch.checkpoint": "otel-pipeline",
      "test.purpose": "Confirm OTel → SigNoz ingestion works before feature work",
      "test.sent_at": sentAt,
    },
    async (span) => {
      span.addEvent("phase0.test_span_emitted", {
        message: "Hello from Nights Watch Phase 0",
      });
      console.log(`[otel:test] emitted span "${SpanNames.TEST}" at ${sentAt}`);
      console.log(
        `[otel:test] Look in SigNoz UI → Traces → filter service.name = nights-watch`,
      );
    },
  );

  // Give the exporter a moment to flush, then shut down cleanly.
  await new Promise((r) => setTimeout(r, 1500));
  await shutdownOtel();
  console.log("[otel:test] done — if SigNoz is reachable, the span should be visible shortly.");
}

main().catch(async (err) => {
  console.error("[otel:test] failed:", err);
  await shutdownOtel().catch(() => undefined);
  process.exit(1);
});
