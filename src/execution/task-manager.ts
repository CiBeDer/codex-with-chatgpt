import { TaskStore, type TaskRecord } from "./task-store.js";
import type { Executor } from "../executor/executor.js";
import { OpenCodeExecutor } from "../executor/opencode.js";
import type { ExecutionRequest, ExecutionResult, ExecutionState } from "../executor/types.js";
import { gitStatus } from "../workspace/git.js";
import { saveExecutionOutput } from "./output.js";
import { appendExecutionRecord } from "./records.js";

export interface CreateTaskOptions {
  taskId: string;
  workspaceId?: string;
  workspacePath: string;
  goal: string;
  plan: string;
  tests?: string[];
  iteration?: number;
}

export class TaskConflictError extends Error {
  readonly code = "TASK_CONFLICT";
  constructor(taskId: string) {
    super(
      `Task ${taskId} already exists with a different payload. Use a different task_id, or explicitly submit the next iteration after the current task reaches a terminal state.`
    );
    this.name = "TaskConflictError";
  }
}

function areArraysEqual(a?: string[], b?: string[]): boolean {
  const arrA = a ?? [];
  const arrB = b ?? [];
  if (arrA.length !== arrB.length) return false;
  for (let i = 0; i < arrA.length; i++) {
    if (arrA[i] !== arrB[i]) return false;
  }
  return true;
}

export function isTaskPayloadEqual(
  existing: TaskRecord,
  opts: CreateTaskOptions
): boolean {
  if (existing.goal !== opts.goal) return false;
  if (existing.plan !== opts.plan) return false;
  if (!areArraysEqual(existing.tests, opts.tests)) return false;
  if (opts.iteration !== undefined && opts.iteration !== existing.iteration) {
    return false;
  }
  return true;
}

export interface TaskManagerOptions {
  workspaceId?: string;
  workspacePath?: string;
  store?: TaskStore;
  executor?: Executor;
}

export class TaskManager {
  readonly workspaceId: string;
  readonly workspacePath?: string;
  private store: TaskStore;
  private executor: Executor;
  private activeExecutions = new Map<string, Promise<ExecutionResult>>();

  constructor(opts: TaskManagerOptions = {}) {
    this.workspaceId = opts.workspaceId ?? opts.store?.workspaceId ?? "default";
    this.workspacePath = opts.workspacePath;
    this.store = opts.store ?? new TaskStore({ workspaceId: this.workspaceId });
    this.executor = opts.executor ?? new OpenCodeExecutor();
  }

  async create(opts: CreateTaskOptions): Promise<TaskRecord> {
    const existing = this.store.get(opts.taskId);

    if (existing) {
      if (existing.state === "CREATED" || existing.state === "RUNNING") {
        if (!isTaskPayloadEqual(existing, opts)) {
          throw new TaskConflictError(opts.taskId);
        }
        // Do not overwrite existing in-progress task; return current record without state reset
        return existing;
      }

      // Terminal states: COMPLETED / FAILED / CANCELLED
      if (opts.iteration === undefined) {
        if (isTaskPayloadEqual(existing, opts)) {
          return existing;
        }
        throw new TaskConflictError(opts.taskId);
      }

      if (opts.iteration === existing.iteration) {
        if (isTaskPayloadEqual(existing, opts)) {
          return existing;
        }
        throw new TaskConflictError(opts.taskId);
      }

      const expectedIteration = existing.iteration + 1;
      if (opts.iteration !== expectedIteration) {
        throw new Error(
          `Invalid iteration: expected ${expectedIteration}, got ${opts.iteration}`
        );
      }

      const nextRecord: TaskRecord = {
        version: 1,
        taskId: opts.taskId,
        workspaceId: this.workspaceId,
        workspacePath: opts.workspacePath,
        goal: opts.goal,
        plan: opts.plan,
        tests: opts.tests,
        iteration: expectedIteration,
        state: "CREATED",
        executor: "opencode",
        executorSessionId: existing.executorSessionId,
        createdAt: Date.now(),
      };

      this.store.save(nextRecord);
      return nextRecord;
    }

    // New task
    if (opts.iteration !== undefined && opts.iteration !== 1) {
      throw new Error(`Invalid iteration for new task: expected 1, got ${opts.iteration}`);
    }

    const record: TaskRecord = {
      version: 1,
      taskId: opts.taskId,
      workspaceId: this.workspaceId,
      workspacePath: opts.workspacePath,
      goal: opts.goal,
      plan: opts.plan,
      tests: opts.tests,
      iteration: 1,
      state: "CREATED",
      executor: "opencode",
      createdAt: Date.now(),
    };

    this.store.save(record);
    return record;
  }

  async get(taskId: string): Promise<TaskRecord | null> {
    return this.store.get(taskId);
  }

  execute(taskId: string): Promise<ExecutionResult> {
    const record = this.store.get(taskId);
    if (!record) {
      return Promise.reject(new Error(`Task not found: ${taskId}`));
    }

    if (
      record.state === "COMPLETED" ||
      record.state === "FAILED" ||
      record.state === "CANCELLED"
    ) {
      return Promise.resolve({
        taskId: record.taskId,
        executorSessionId: record.executorSessionId,
        state: record.state,
        summary: record.summary,
        error: record.error,
        changedFiles: [],
        startedAt: record.startedAt ?? record.createdAt,
        finishedAt: record.finishedAt,
      });
    }

    if (record.state === "RUNNING") {
      const active = this.activeExecutions.get(taskId);
      if (active) return active;
      // If marked RUNNING in store but no in-memory active execution (e.g. after bridge restart),
      // do not re-prompt automatically. Trigger resume recovery in background and return RUNNING state.
      if (record.executorSessionId) {
        this.recoverSingleTask(record);
      }
      return Promise.resolve({
        taskId,
        executorSessionId: record.executorSessionId,
        state: "RUNNING",
        changedFiles: [],
        startedAt: record.startedAt ?? record.createdAt,
      });
    }

    const startedAt = Date.now();
    this.store.update(taskId, {
      state: "RUNNING",
      startedAt,
    });

    const executionReq: ExecutionRequest = {
      taskId: record.taskId,
      workspacePath: record.workspacePath,
      goal: record.goal,
      plan: record.plan,
      tests: record.tests,
      iteration: record.iteration,
    };

    let sessionId = record.executorSessionId;

    let resolvePromise!: (res: ExecutionResult) => void;
    let rejectPromise!: (err: any) => void;
    const promise = new Promise<ExecutionResult>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    this.activeExecutions.set(taskId, promise);

    (async () => {
      try {
        if (!sessionId) {
          sessionId = await this.executor.ensureSession(executionReq);
          this.store.update(taskId, { executorSessionId: sessionId });
        }

        const result = await this.executor.execute(executionReq, sessionId!);
        const finalResult = await this.finalizeExecution(record, result, sessionId!, startedAt);
        resolvePromise(finalResult);
      } catch (err: any) {
        const current = this.store.get(taskId);
        if (current?.state === "CANCELLED") {
          const cancelledRes: ExecutionResult = {
            taskId,
            state: "CANCELLED",
            changedFiles: [],
            startedAt,
            finishedAt: Date.now(),
            error: "Task was cancelled",
          };
          resolvePromise(cancelledRes);
          return;
        }

        const errMsg = err instanceof Error ? err.message : String(err);
        this.store.update(taskId, {
          state: "FAILED",
          error: errMsg,
          finishedAt: Date.now(),
        });

        const failedRes: ExecutionResult = {
          taskId,
          state: "FAILED",
          error: errMsg,
          changedFiles: [],
          startedAt,
          finishedAt: Date.now(),
        };
        resolvePromise(failedRes);
      } finally {
        this.activeExecutions.delete(taskId);
      }
    })();

    return promise;
  }

  private async finalizeExecution(
    record: TaskRecord,
    result: ExecutionResult,
    sessionId: string,
    startedAt: number
  ): Promise<ExecutionResult> {
    const current = this.store.get(record.taskId);
    if (current?.state === "CANCELLED") {
      return {
        taskId: record.taskId,
        state: "CANCELLED",
        changedFiles: result.changedFiles ?? [],
        startedAt,
        finishedAt: Date.now(),
        error: "Task was cancelled",
      };
    }

    const finalState: ExecutionState =
      result.state === "COMPLETED" ? "COMPLETED" : "FAILED";

    // Query gitStatus on workspacePath to discover dirty file paths
    let changedFiles = result.changedFiles ?? [];
    if (record.workspacePath) {
      try {
        const status = gitStatus(record.workspacePath);
        if (status.isRepo) {
          const paths = new Set<string>();
          for (const s of status.staged) paths.add(s.path);
          for (const u of status.unstaged) paths.add(u.path);
          for (const ut of status.untracked) paths.add(ut);
          for (const c of status.conflicted) paths.add(c);
          changedFiles = [...paths];
        }
      } catch {
        // Ignore git status query errors
      }
    }

    // Save execution output
    let outputId: number | undefined;
    let outputAvailable = false;
    if (result.summary) {
      try {
        const savedOutput = saveExecutionOutput(this.workspaceId, {
          command: `opencode session ${sessionId}`,
          raw: result.summary,
          exitCode: finalState === "COMPLETED" ? 0 : 1,
          taskId: record.taskId,
          iteration: record.iteration,
        });
        outputId = savedOutput.id;
        outputAvailable = savedOutput.allowed;
      } catch {
        // Ignore output save failures
      }
    }

    // Append execution record for independent review
    try {
      appendExecutionRecord(this.workspaceId, {
        taskId: record.taskId,
        iteration: record.iteration,
        changedFiles,
        tests: null, // Test evidence has not been independently parsed from tool output
        exitStatus: finalState === "COMPLETED" ? "0" : "1",
        timestamp: new Date().toISOString(),
        notes:
          finalState === "COMPLETED"
            ? "OpenCode execution completed. changedFiles reflects current dirty workspace paths after execution; it may include pre-existing changes."
            : `OpenCode execution failed: ${result.error ?? "unknown error"}`,
        outputId,
        outputAvailable,
      });
    } catch {
      // Ignore execution record persistence failures
    }

    const finalResult: ExecutionResult = {
      ...result,
      changedFiles,
    };

    this.store.update(record.taskId, {
      state: finalState,
      summary: result.summary,
      error: result.error,
      finishedAt: result.finishedAt ?? Date.now(),
    });

    return finalResult;
  }

  private recoverSingleTask(record: TaskRecord): Promise<ExecutionResult> {
    const taskId = record.taskId;
    const existingActive = this.activeExecutions.get(taskId);
    if (existingActive) return existingActive;

    const startedAt = record.startedAt ?? record.createdAt;
    const sessionId = record.executorSessionId;
    if (!sessionId) {
      const errMsg = `Cannot recover RUNNING task without executorSessionId: ${taskId}`;
      this.store.update(taskId, {
        state: "FAILED",
        error: errMsg,
        finishedAt: Date.now(),
      });
      return Promise.resolve({
        taskId,
        state: "FAILED",
        error: errMsg,
        changedFiles: [],
        startedAt,
        finishedAt: Date.now(),
      });
    }

    let resolvePromise!: (res: ExecutionResult) => void;
    let rejectPromise!: (err: any) => void;
    const promise = new Promise<ExecutionResult>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    this.activeExecutions.set(taskId, promise);

    const executionReq: ExecutionRequest = {
      taskId: record.taskId,
      workspacePath: record.workspacePath,
      goal: record.goal,
      plan: record.plan,
      tests: record.tests,
      iteration: record.iteration,
    };

    (async () => {
      try {
        const result = await this.executor.resume(executionReq, sessionId);
        const finalRes = await this.finalizeExecution(record, result, sessionId, startedAt);
        resolvePromise(finalRes);
      } catch (err: any) {
        const errMsg = err instanceof Error ? err.message : String(err);
        const isSessionNotFound =
          errMsg.includes("SessionNotFoundError") ||
          errMsg.toLowerCase().includes("session not found");

        if (isSessionNotFound) {
          const notFoundError = `OpenCode session not found while recovering task ${taskId}`;
          this.store.update(taskId, {
            state: "FAILED",
            error: notFoundError,
            finishedAt: Date.now(),
          });
          resolvePromise({
            taskId,
            state: "FAILED",
            error: notFoundError,
            changedFiles: [],
            startedAt,
            finishedAt: Date.now(),
          });
          return;
        }

        // For temporary network/connection errors, keep RUNNING in store and return RUNNING
        resolvePromise({
          taskId,
          state: "RUNNING",
          executorSessionId: sessionId,
          error: errMsg,
          changedFiles: [],
          startedAt,
        });
      } finally {
        this.activeExecutions.delete(taskId);
      }
    })();

    return promise;
  }

  async recoverRunningTasks(): Promise<void> {
    const records = this.store.list();
    const running = records.filter((r) => r.state === "RUNNING");
    if (running.length === 0) return;

    const promises: Promise<ExecutionResult>[] = [];
    for (const record of running) {
      if (this.activeExecutions.has(record.taskId)) {
        const active = this.activeExecutions.get(record.taskId);
        if (active) promises.push(active);
        continue;
      }
      promises.push(this.recoverSingleTask(record));
    }
    await Promise.all(promises);
  }

  async cancel(taskId: string): Promise<boolean> {
    const record = this.store.get(taskId);
    if (!record) return false;

    // Idempotent: already cancelled
    if (record.state === "CANCELLED") return true;

    // Completed or failed tasks cannot be cancelled
    if (record.state === "COMPLETED" || record.state === "FAILED") return false;

    // Must be in RUNNING state
    if (record.state !== "RUNNING") return false;

    // Must have an active executorSessionId
    const sessionId = record.executorSessionId;
    if (!sessionId) return false;

    try {
      const ok = await this.executor.cancel(taskId, sessionId);
      if (!ok) return false;
    } catch {
      // If interrupt throws an exception, do not fake state as CANCELLED
      return false;
    }

    this.store.update(taskId, {
      state: "CANCELLED",
      finishedAt: Date.now(),
      error: "Task cancelled by user",
    });

    return true;
  }
}
