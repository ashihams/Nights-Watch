export type RunStatus =
  | "running"
  | "paused"
  | "awaiting_approval"
  | "completed"
  | "failed"
  | "hard_stopped"
  | "recovering";

export type HumanDecision = "approve" | "reject";

export type PolicyEvalPoint = {
  stepId: string;
  score: number;
  checkpointId: string;
  fired: string[];
  timestamp: string;
};

export type RunSummary = {
  runId: string;
  task: string;
  status: RunStatus;
  planSource: "llm" | "deterministic_fallback";
  plan: {
    goal: string;
    maxBudget: number;
    origin?: string;
    destination?: string;
  };
  completedSteps: string[];
  budgetConsumed: number;
  checkpointIds: string[];
  lastPolicyScore: number;
  recoveryCount: number;
  recovered: boolean;
  lastRecoveryDetail?: string;
  lastRecoveryDurationMs?: number;
  lastRestoredCheckpointId?: string;
  lastExplanation?: {
    text: string;
    mcpInvoked: boolean;
    mcpOk: boolean;
    source: string;
  };
  awaitingApproval?: boolean;
  pendingApproval?: { stepId: string; score: number } | null;
  lastHumanDecision?: HumanDecision;
  policyEvaluations: PolicyEvalPoint[];
  startedAt: string;
};

export type CheckpointRow = {
  id: string;
  runId: string;
  index: number;
  label: string;
  planStep: string;
  budgetConsumed: number;
  timestamp: string;
};

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

export type Thresholds = {
  pause: number;
  rollback: number;
  hardStop: number;
};

export type RecoveryMetrics = {
  recoveryAttempts: number;
  rollbackSuccesses: number;
  rollbackSuccessRate: number | null;
  recoveredExecutions: number;
  note: string;
};
