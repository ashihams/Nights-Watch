/**
 * Local durable checkpoint store (SQLite via node:sqlite).
 * This is the source of truth for rollback — never reconstruct state from SigNoz.
 */
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { config } from "../config/index.js";
import {
  parseCheckpoint,
  type Checkpoint,
} from "../types/checkpoint.js";

let db: DatabaseSync | null = null;

function dbPath(): string {
  return resolve(process.cwd(), config.checkpointDbPath);
}

export function getCheckpointDb(): DatabaseSync {
  if (db) return db;

  const path = dbPath();
  mkdirSync(dirname(path), { recursive: true });
  db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE IF NOT EXISTS checkpoints (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      idx INTEGER NOT NULL,
      label TEXT NOT NULL,
      plan_step TEXT NOT NULL,
      state_json TEXT NOT NULL,
      budget_consumed REAL NOT NULL,
      ts TEXT NOT NULL,
      trust_context_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_checkpoints_run
      ON checkpoints(run_id, idx);
  `);
  return db;
}

/** Close the DB (tests / process shutdown). */
export function closeCheckpointDb(): void {
  if (!db) return;
  db.close();
  db = null;
}

export function saveCheckpoint(cp: Checkpoint): Checkpoint {
  const parsed = parseCheckpoint(cp);
  const database = getCheckpointDb();
  database
    .prepare(
      `INSERT INTO checkpoints
        (id, run_id, idx, label, plan_step, state_json, budget_consumed, ts, trust_context_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      parsed.id,
      parsed.runId,
      parsed.index,
      parsed.label,
      parsed.planStep,
      JSON.stringify(parsed.state),
      parsed.budgetConsumed,
      parsed.timestamp,
      JSON.stringify(parsed.trustContext),
    );
  return parsed;
}

function rowToCheckpoint(row: Record<string, unknown>): Checkpoint {
  return parseCheckpoint({
    id: row.id,
    runId: row.run_id,
    index: row.idx,
    label: row.label,
    planStep: row.plan_step,
    state: JSON.parse(String(row.state_json)),
    budgetConsumed: row.budget_consumed,
    timestamp: row.ts,
    trustContext: JSON.parse(String(row.trust_context_json)),
  });
}

export function listCheckpointsForRun(runId: string): Checkpoint[] {
  const database = getCheckpointDb();
  const rows = database
    .prepare(
      `SELECT id, run_id, idx, label, plan_step, state_json, budget_consumed, ts, trust_context_json
       FROM checkpoints WHERE run_id = ? ORDER BY idx ASC`,
    )
    .all(runId) as Record<string, unknown>[];
  return rows.map(rowToCheckpoint);
}

export function getCheckpointById(id: string): Checkpoint | undefined {
  const database = getCheckpointDb();
  const row = database
    .prepare(
      `SELECT id, run_id, idx, label, plan_step, state_json, budget_consumed, ts, trust_context_json
       FROM checkpoints WHERE id = ?`,
    )
    .get(id) as Record<string, unknown> | undefined;
  return row ? rowToCheckpoint(row) : undefined;
}

/** Latest checkpoint for a run — what rollback would restore from. */
export function getLatestCheckpoint(runId: string): Checkpoint | undefined {
  const database = getCheckpointDb();
  const row = database
    .prepare(
      `SELECT id, run_id, idx, label, plan_step, state_json, budget_consumed, ts, trust_context_json
       FROM checkpoints WHERE run_id = ? ORDER BY idx DESC LIMIT 1`,
    )
    .get(runId) as Record<string, unknown> | undefined;
  return row ? rowToCheckpoint(row) : undefined;
}
