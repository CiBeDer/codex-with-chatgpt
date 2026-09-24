import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { TaskManager } from "../src/execution/task-manager.js";
import { TaskStore } from "../src/execution/task-store.js";
import type { Executor } from "../src/executor/executor.js";
import type { ExecutionRequest, ExecutionResult } from "../src/executor/types.js";

describe("TaskManager (Phase 6)", () => {
  let tmpDir: string;
  let store: TaskStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "c2c-task-manager-test-"));
    store = new TaskStore({ stateDir: tmpDir });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates a new task in CREATED state", async () => {
    const manager = new TaskManager({ store });
    const record = await manager.create({
      taskId: "task_create_1",
      workspacePath: "/repo/test",
      goal: "Implement feature",
      plan: "1. Do A\n2. Do B",
      tests: ["pnpm test"],
    });

    expect(record.taskId).toBe("task_create_1");
    expect(record.state).toBe("CREATED");
    expect(record.iteration).toBe(1);
    expect(record.executor).toBe("opencode");

    const fetched = await manager.get("task_create_1");
    expect(fetched).toEqual(record);
  });

  it("execute runs task to COMPLETED and stores summary and changed files", async () => {
    const mockExecutor: Executor = {
      health: async () => true,
      execute: async (req: ExecutionRequest): Promise<ExecutionResult> => ({
        taskId: req.taskId,
        state: "COMPLETED",
        summary: "Tests passed cleanly",
        changedFiles: ["src/index.ts"],
        startedAt: 1000,
        finishedAt: 2000,
      }),
      cancel: async () => true,
    };

    const manager = new TaskManager({ store, executor: mockExecutor });
    await manager.create({
      taskId: "task_exec_1",
      workspacePath: "/repo/test",
      goal: "Implement feature",
      plan: "Plan text",
    });

    const result = await manager.execute("task_exec_1");
    expect(result.state).toBe("COMPLETED");
    expect(result.summary).toBe("Tests passed cleanly");

    const record = await manager.get("task_exec_1");
    expect(record?.state).toBe("COMPLETED");
    expect(record?.summary).toBe("Tests passed cleanly");
  });

  it("execute sets FAILED state when executor fails", async () => {
    const mockExecutor: Executor = {
      health: async () => true,
      execute: async (req: ExecutionRequest): Promise<ExecutionResult> => ({
        taskId: req.taskId,
        state: "FAILED",
        error: "Build failed with exit code 1",
        changedFiles: [],
        startedAt: 1000,
        finishedAt: 2000,
      }),
      cancel: async () => true,
    };

    const manager = new TaskManager({ store, executor: mockExecutor });
    await manager.create({
      taskId: "task_fail_1",
      workspacePath: "/repo/test",
      goal: "Implement feature",
      plan: "Plan text",
    });

    const result = await manager.execute("task_fail_1");
    expect(result.state).toBe("FAILED");
    expect(result.error).toBe("Build failed with exit code 1");

    const record = await manager.get("task_fail_1");
    expect(record?.state).toBe("FAILED");
    expect(record?.error).toBe("Build failed with exit code 1");
  });

  it("cancel transitions RUNNING task to CANCELLED and interrupts executor", async () => {
    let cancelCalled = false;
    let executeResolve: (res: ExecutionResult) => void;

    const mockExecutor: Executor = {
      health: async () => true,
      execute: (req: ExecutionRequest) =>
        new Promise<ExecutionResult>((resolve) => {
          executeResolve = resolve;
        }),
      cancel: async (taskId: string) => {
        cancelCalled = true;
        return true;
      },
    };

    const manager = new TaskManager({ store, executor: mockExecutor });
    await manager.create({
      taskId: "task_cancel_1",
      workspacePath: "/repo/test",
      goal: "Cancel me",
      plan: "Plan text",
    });

    // Start execution in background
    const execPromise = manager.execute("task_cancel_1");

    // Wait microtask so state transitions to RUNNING
    await new Promise((r) => setTimeout(r, 10));

    const runningRecord = await manager.get("task_cancel_1");
    expect(runningRecord?.state).toBe("RUNNING");

    const cancelled = await manager.cancel("task_cancel_1");
    expect(cancelled).toBe(true);
    expect(cancelCalled).toBe(true);

    const cancelledRecord = await manager.get("task_cancel_1");
    expect(cancelledRecord?.state).toBe("CANCELLED");
  });

  it("same task with next iteration reuses existing session mapping", async () => {
    let callCount = 0;
    const receivedRequests: ExecutionRequest[] = [];

    const mockExecutor: Executor = {
      health: async () => true,
      execute: async (req: ExecutionRequest) => {
        callCount++;
        receivedRequests.push(req);
        return {
          taskId: req.taskId,
          state: "COMPLETED",
          changedFiles: [],
          startedAt: 1000,
          finishedAt: 2000,
        };
      },
      cancel: async () => true,
    };

    const manager = new TaskManager({ store, executor: mockExecutor });

    // Iteration 1
    await manager.create({
      taskId: "task_reuse",
      workspacePath: "/repo/test",
      goal: "Goal",
      plan: "Plan 1",
      iteration: 1,
    });
    await manager.execute("task_reuse");

    // Iteration 2 with same taskId
    await manager.create({
      taskId: "task_reuse",
      workspacePath: "/repo/test",
      goal: "Goal",
      plan: "Plan 2",
      iteration: 2,
    });
    await manager.execute("task_reuse");

    expect(callCount).toBe(2);
    expect(receivedRequests[0].iteration).toBe(1);
    expect(receivedRequests[1].iteration).toBe(2);

    const record = await manager.get("task_reuse");
    expect(record?.iteration).toBe(2);
  });
});
