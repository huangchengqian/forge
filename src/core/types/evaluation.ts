export type EvaluationStatus = "PASS" | "WARNING" | "REVIEW_REQUIRED";

export type FindingSeverity = "info" | "warning" | "critical";

export type Finding = {
  rule: string;
  severity: FindingSeverity;
  message: string;
};

export type Evidence = {
  kind: string;
  detail: string;
};

export type EvaluationResult = {
  taskId: string;
  score: number;
  status: EvaluationStatus;
  findings: readonly Finding[];
  evidence: readonly Evidence[];
};
