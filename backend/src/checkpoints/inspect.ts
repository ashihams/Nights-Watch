/**
 * Inspect local checkpoint store (Phase 2 verification).
 * Usage:
 *   npm run checkpoints:list
 *   npm run checkpoints:list -- run-abc123
 */
import { config } from "../config/index.js";
import {
  closeCheckpointDb,
  getLatestCheckpoint,
  listCheckpointsForRun,
  getCheckpointDb,
} from "./store.js";

function listAllRunIds(): string[] {
  const db = getCheckpointDb();
  const rows = db
    .prepare(
      `SELECT run_id FROM checkpoints GROUP BY run_id ORDER BY MAX(ts) DESC`,
    )
    .all() as Array<{ run_id: string }>;
  return rows.map((r) => r.run_id);
}

function main(): void {
  const runId = process.argv[2];
  console.log(`[checkpoints] db=${config.checkpointDbPath}`);

  getCheckpointDb();

  if (runId) {
    const cps = listCheckpointsForRun(runId);
    if (cps.length === 0) {
      console.log(`No checkpoints for runId=${runId}`);
      process.exitCode = 1;
      return;
    }
    console.log(JSON.stringify(cps, null, 2));
    const latest = getLatestCheckpoint(runId);
    console.log(
      `\n[checkpoints] latest (rollback source) = ${latest?.id} label=${latest?.label}`,
    );
    return;
  }

  const runs = listAllRunIds();
  if (runs.length === 0) {
    console.log("No checkpoints stored yet. Run happy-path first.");
    return;
  }

  for (const id of runs) {
    const cps = listCheckpointsForRun(id);
    console.log(
      `\nrun=${id} count=${cps.length} labels=[${cps.map((c) => c.label).join(", ")}]`,
    );
    for (const c of cps) {
      console.log(
        `  ${c.index} ${c.id} step=${c.planStep} budget=${c.budgetConsumed} ts=${c.timestamp}`,
      );
    }
  }
}

try {
  main();
} finally {
  closeCheckpointDb();
}
