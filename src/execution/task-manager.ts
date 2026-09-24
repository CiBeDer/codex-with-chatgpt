import { TaskStore, type TaskRecord } from "./task-store.js";
import type { Executor } from "../executor/executor.js";
import { OpenCodeExecutor } from "../executor/opencode.js";
import type { ExecutionRequest, ExecutionResult, ExecutionState } from "../executor/types.js";

export interface CreateTaskOptions {
  taskId: string;
  workspacePath: string;
  goal: string;
  plan: string;
  tests?: string[];
  iteration?: number;
}

export interface TaskManagerOptions {
  store?: TaskStore;
  executor?: Executor;
}

export class TaskManager {
  private store: TaskStore;
  private executor: Executor;
  private activeExecutions = new Map<string, Promise<ExecutionResult>>();

  constructor(opts: TaskManagerOptions = {}) {
    this.store = opts.store ?? new TaskStore();
    this.executor = opts.executor ?? new OpenCodeExecutor();
  }

  async create(opts: CreateTaskOptions): Promise<TaskRecord> {
    const existing = this.store.get(opts.taskId);
    const iteration = opts.iteration ?? (existing ? existing.iteration + 1 : 1);

    const record: TaskRecord = {
      version: 1,
      taskId: opts.taskId,
      workspacePath: opts.workspacePath,
      goal: opts.goal,
      plan: opts.plan,
      tests: opts.tests,
      iteration,
      state: "CREATED",
      executor: "opencode",
      executorSessionId: existing?.executorSessionId,
      createdAt: Date.now(),
    };

    this.store.save(record);
    return record;
  }

  async get(taskId: string): Promise<TaskRecord | null> {
    return this.store.get(taskId);
  }

  async execute(taskId: string): Promise<ExecutionResult> {
    const record = this.store.get(taskId);
    if (!record) {
      throw new Error(`Task not found: ${taskId}`);
    }

    if (record.state === "RUNNING") {
      const active = this.activeExecutions.get(taskId);
      if (active) return active;
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

    const promise = (async () => {
      try {
        const result = await this.executor.execute(executionReq);

        const current = this.store.get(taskId);
        if (current?.state === "CANCELLED") {
          const cancelledRes: ExecutionResult = {
            taskId,
            state: "CANCELLED",
            changedFiles: result.changedFiles ?? [],
            startedAt,
            finishedAt: Date.now(),
            error: "Task was cancelled",
          };
          return cancelledRes;
        }

        const finalState: ExecutionState =
          result.state === "COMPLETED" ? "COMPLETED" : "FAILED";

        this.store.update(taskId, {
          state: finalState,
          summary: result.summary,
          error: result.error,
          finishedAt: result.finishedAt ?? Date.now(),
        });

        return result;
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
          return cancelledRes;
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
        return failedRes;
      } finally {
        this.activeExecutions.delete(taskId);
      }
    })();

    this.activeExecutions.set(taskId, promise);
    return promise;
  }

  async cancel(taskId: string): Promise<boolean> {
    const record = this.store.get(taskId);
    if (!record) return false;

    if (record.state === "CANCELLED") return true;
    if (record.state === "COMPLETED" || record.state === "FAILED") return false;

    this.store.update(taskId, {
      state: "CANCELLED",
      finishedAt: Date.now(),
      error: "Task cancelled by user",
    });

    await this.executor.cancel(taskId);
    return true;
  }
}
