import type { ExecutionRequest, ExecutionResult } from "./types.js";

export interface Executor {
  health(): Promise<boolean>;

  ensureSession(
    request: ExecutionRequest
  ): Promise<string>;

  execute(
    request: ExecutionRequest,
    sessionId: string
  ): Promise<ExecutionResult>;

  resume(
    request: ExecutionRequest,
    sessionId: string
  ): Promise<ExecutionResult>;

  cancel(
    taskId: string,
    sessionId: string
  ): Promise<boolean>;
}
