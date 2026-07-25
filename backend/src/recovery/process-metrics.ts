/**
 * Process-local recovery aggregates for the dashboard Recovery Health panel.
 * These mirror OTel counters at record-time — they are NOT durable and reset
 * when the backend process restarts (fine for a single continuous demo session).
 */

let rollbackAttempts = 0;
let rollbackSuccesses = 0;
let recoveredExecutionsTotal = 0;

export function noteRollbackAttempt(success: boolean): void {
  rollbackAttempts += 1;
  if (success) rollbackSuccesses += 1;
}

export function noteRecoveredExecution(): void {
  recoveredExecutionsTotal += 1;
}

export function getRecoveryProcessMetrics(): {
  recoveryAttempts: number;
  rollbackSuccesses: number;
  rollbackSuccessRate: number | null;
  recoveredExecutions: number;
  note: string;
} {
  return {
    recoveryAttempts: rollbackAttempts,
    rollbackSuccesses,
    rollbackSuccessRate:
      rollbackAttempts === 0 ? null : rollbackSuccesses / rollbackAttempts,
    recoveredExecutions: recoveredExecutionsTotal,
    note: "Process-local totals; reset on backend restart — not a lifetime store.",
  };
}
