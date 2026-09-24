export type ExecutionState =
  | "CREATED"
  | "RUNNING"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED";

export interface ExecutionRequest {
  taskId: string;
  workspacePath: string;
  goal: string;
  plan: string;
  tests?: string[];
  iteration?: number;
}

export interface ExecutionResult {
  taskId: string;
  executorSessionId?: string;
  state: ExecutionState;
  summary?: string;
  changedFiles: string[];

  testStatus?: {
    passed?: number;
    failed?: number;
    summary?: string;
  };

  error?: string;

  startedAt: number;
  finishedAt?: number;
}
