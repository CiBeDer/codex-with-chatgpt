import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { TaskManager } from "../src/execution/task-manager.js";
import { TaskStore } from "../src/execution/task-store.js";
import type { Executor } from "../src/executor/executor.js";
import type { ExecutionRequest, ExecutionResult } from "../src/executor/types.js";

describe("TaskManager (Phase R2 persistent executor session ownership)", () => {
  let tmpDir: string;
  let store: TaskStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "c2c-task-manager-test-"));
    store = new TaskStore({ stateDir: tmpDir, workspaceId: "ws_test_mgr" });
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

  it("execute calls ensureSession, persists sessionId BEFORE prompt, and completes", async () => {
    let sessionEnsured = false;
    let sessionIdSavedBeforeExecute = false;

    const mockExecutor: Executor = {
      health: async () => true,
      ensureSession: async (req: ExecutionRequest): Promise<string> => {
        sessionEnsured = true;
        return "ses_mock_999";
      },
      execute: async (req: ExecutionRequest, sessionId: string): Promise<ExecutionResult> => {
        // Verify that before execute runs, TaskStore has already saved executorSessionId
        const saved = store.get(req.taskId);
        if (saved?.executorSessionId === "ses_mock_999") {
          sessionIdSavedBeforeExecute = true;
        }
        return {
          taskId: req.taskId,
          executorSessionId: sessionId,
          state: "COMPLETED",
          summary: "Tests passed cleanly",
          changedFiles: ["src/index.ts"],
          startedAt: 1000,
          finishedAt: 2000,
        };
      },
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
    expect(sessionEnsured).toBe(true);
    expect(sessionIdSavedBeforeExecute).toBe(true);
    expect(result.state).toBe("COMPLETED");
    expect(result.summary).toBe("Tests passed cleanly");

    const record = await manager.get("task_exec_1");
    expect(record?.state).toBe("COMPLETED");
    expect(record?.executorSessionId).toBe("ses_mock_999");
  });

  it("execute sets FAILED state when executor fails", async () => {
    const mockExecutor: Executor = {
      health: async () => true,
      ensureSession: async () => "ses_mock_fail",
      execute: async (req: ExecutionRequest, sessionId: string): Promise<ExecutionResult> => ({
        taskId: req.taskId,
        executorSessionId: sessionId,
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

  it("cancel transitions RUNNING task to CANCELLED and passes persisted sessionId to executor.cancel", async () => {
    let cancelCalledWith: { taskId: string; sessionId: string } | null = null;
    let executeResolve: (res: ExecutionResult) => void;

    const mockExecutor: Executor = {
      health: async () => true,
      ensureSession: async () => "ses_to_cancel_123",
      execute: (req: ExecutionRequest, sessionId: string) =>
        new Promise<ExecutionResult>((resolve) => {
          executeResolve = resolve;
        }),
      cancel: async (taskId: string, sessionId: string) => {
        cancelCalledWith = { taskId, sessionId };
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
    manager.execute("task_cancel_1");

    // Wait microtask so state transitions to RUNNING
    await new Promise((r) => setTimeout(r, 10));

    const runningRecord = await manager.get("task_cancel_1");
    expect(runningRecord?.state).toBe("RUNNING");
    expect(runningRecord?.executorSessionId).toBe("ses_to_cancel_123");

    const cancelled = await manager.cancel("task_cancel_1");
    expect(cancelled).toBe(true);
    expect(cancelCalledWith).toEqual({
      taskId: "task_cancel_1",
      sessionId: "ses_to_cancel_123",
    });

    const cancelledRecord = await manager.get("task_cancel_1");
    expect(cancelledRecord?.state).toBe("CANCELLED");
  });

  it("retains executorSessionId across TaskManager instances and across iterations without re-creating session", async () => {
    let ensureSessionCalls = 0;
    const executedSessions: string[] = [];

    const mockExecutor: Executor = {
      health: async () => true,
      ensureSession: async () => {
        ensureSessionCalls++;
        return "ses_stable_session_42";
      },
      execute: async (req: ExecutionRequest, sessionId: string) => {
        executedSessions.push(sessionId);
        return {
          taskId: req.taskId,
          executorSessionId: sessionId,
          state: "COMPLETED",
          changedFiles: [],
          startedAt: 1000,
          finishedAt: 2000,
        };
      },
      cancel: async () => true,
    };

    // First instance: Iteration 1
    const manager1 = new TaskManager({ store, executor: mockExecutor });
    await manager1.create({
      taskId: "task_reuse",
      workspacePath: "/repo/test",
      goal: "Goal",
      plan: "Plan 1",
      iteration: 1,
    });
    await manager1.execute("task_reuse");

    expect(ensureSessionCalls).toBe(1);
    expect(executedSessions[0]).toBe("ses_stable_session_42");

    // Second instance (e.g. process restarted with same TaskStore): Iteration 2
    const freshStore = new TaskStore({ stateDir: tmpDir, workspaceId: "ws_test_mgr" });
    const manager2 = new TaskManager({ store: freshStore, executor: mockExecutor });

    await manager2.create({
      taskId: "task_reuse",
      workspacePath: "/repo/test",
      goal: "Goal",
      plan: "Plan 2",
      iteration: 2,
    });
    await manager2.execute("task_reuse");

    // ensureSession should NOT have been called again!
    expect(ensureSessionCalls).toBe(1);
    expect(executedSessions[1]).toBe("ses_stable_session_42");

    const record = await manager2.get("task_reuse");
    expect(record?.iteration).toBe(2);
    expect(record?.executorSessionId).toBe("ses_stable_session_42");
  });
});
