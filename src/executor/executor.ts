import type { ExecutionRequest, ExecutionResult } from "./types.js";

export interface Executor {
  health(): Promise<boolean>;

  execute(
    request: ExecutionRequest
  ): Promise<ExecutionResult>;

  cancel(
    taskId: string
  ): Promise<boolean>;
}
