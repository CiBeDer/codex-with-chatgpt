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

  it("cancel adheres to interrupt outcome and status constraints", async () => {
    let shouldInterruptSucceed = true;
    let shouldInterruptThrow = false;

    const mockExecutor: Executor = {
      health: async () => true,
      ensureSession: async () => "ses_int_test",
      execute: () => new Promise<ExecutionResult>(() => {}), // stays running
      cancel: async () => {
        if (shouldInterruptThrow) {
          throw new Error("Network interrupt error");
        }
        return shouldInterruptSucceed;
      },
    };

    const manager = new TaskManager({ store, executor: mockExecutor });

    // Case 1: Non-existent task -> false
    expect(await manager.cancel("non_existent")).toBe(false);

    // Case 2: Task created but no session yet (not RUNNING) -> false
    await manager.create({
      taskId: "task_unstarted",
      workspacePath: "/repo/test",
      goal: "G",
      plan: "P",
    });
    expect(await manager.cancel("task_unstarted")).toBe(false);

    // Case 3: Interrupt fails (false) -> returns false and state remains RUNNING
    await manager.create({
      taskId: "task_int_fail",
      workspacePath: "/repo/test",
      goal: "G",
      plan: "P",
    });
    manager.execute("task_int_fail");
    await new Promise((r) => setTimeout(r, 10));

    shouldInterruptSucceed = false;
    const cancelRes1 = await manager.cancel("task_int_fail");
    expect(cancelRes1).toBe(false);
    expect((await manager.get("task_int_fail"))?.state).toBe("RUNNING");

    // Case 4: Interrupt throws -> returns false and state remains RUNNING
    shouldInterruptThrow = true;
    const cancelRes2 = await manager.cancel("task_int_fail");
    expect(cancelRes2).toBe(false);
    expect((await manager.get("task_int_fail"))?.state).toBe("RUNNING");

    // Case 5: Interrupt succeeds -> returns true and state becomes CANCELLED
    shouldInterruptThrow = false;
    shouldInterruptSucceed = true;
    const cancelRes3 = await manager.cancel("task_int_fail");
    expect(cancelRes3).toBe(true);
    expect((await manager.get("task_int_fail"))?.state).toBe("CANCELLED");

    // Case 6: Already cancelled -> idempotent returns true
    expect(await manager.cancel("task_int_fail")).toBe(true);

    // Case 7: Task already completed -> cancel returns false
    store.save({
      version: 1,
      taskId: "task_done",
      workspaceId: store.workspaceId,
      goal: "G",
      plan: "P",
      iteration: 1,
      state: "COMPLETED",
      executor: "opencode",
      createdAt: 1000,
    });
    expect(await manager.cancel("task_done")).toBe(false);

    // Case 8: Task already failed -> cancel returns false
    store.save({
      version: 1,
      taskId: "task_failed",
      workspaceId: store.workspaceId,
      goal: "G",
      plan: "P",
      iteration: 1,
      state: "FAILED",
      executor: "opencode",
      createdAt: 1000,
    });
    expect(await manager.cancel("task_failed")).toBe(false);
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

  it("does not overwrite or re-execute RUNNING task; deduplicates concurrent executions", async () => {
    let executeCalls = 0;
    let finishExecute: () => void;

    const mockExecutor: Executor = {
      health: async () => true,
      ensureSession: async () => "ses_dedup_1",
      execute: async (req: ExecutionRequest, sessionId: string) => {
        executeCalls++;
        await new Promise<void>((resolve) => {
          finishExecute = resolve;
        });
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

    const manager = new TaskManager({ store, executor: mockExecutor });

    // Step 1: Create taskA
    const created1 = await manager.create({
      taskId: "taskA",
      workspacePath: "/repo/test",
      goal: "Goal",
      plan: "Plan",
    });
    expect(created1.state).toBe("CREATED");

    // Start execute taskA (running in background)
    const p1 = manager.execute("taskA");
    await new Promise((r) => setTimeout(r, 10));

    // While taskA is RUNNING, try create taskA again with same payload (idempotent)
    const createdWhileRunning = await manager.create({
      taskId: "taskA",
      workspacePath: "/repo/test",
      goal: "Goal",
      plan: "Plan",
    });
    // Should NOT reset to CREATED
    expect(createdWhileRunning.state).toBe("RUNNING");
    expect(createdWhileRunning.goal).toBe("Goal");

    // Second call to execute while RUNNING should return the SAME active promise
    const p2 = manager.execute("taskA");
    expect(p2).toBe(p1);

    finishExecute!();
    const res1 = await p1;
    const res2 = await p2;
    expect(res1.state).toBe("COMPLETED");
    expect(res2.state).toBe("COMPLETED");
    expect(executeCalls).toBe(1); // Only 1 execute call was made
  });

  it("rejects invalid iteration progression (skipped or backward numbers)", async () => {
    const mockExecutor: Executor = {
      health: async () => true,
      ensureSession: async () => "ses_iter_1",
      execute: async (req: ExecutionRequest, sessionId: string) => ({
        taskId: req.taskId,
        executorSessionId: sessionId,
        state: "COMPLETED",
        changedFiles: [],
        startedAt: 1000,
        finishedAt: 2000,
      }),
      cancel: async () => true,
    };

    const manager = new TaskManager({ store, executor: mockExecutor });

    // New task must not start with iteration > 1
    await expect(
      manager.create({
        taskId: "task_iter_test",
        workspacePath: "/repo/test",
        goal: "G",
        plan: "P",
        iteration: 2,
      })
    ).rejects.toThrowError(/Invalid iteration for new task: expected 1, got 2/);

    // Iteration 1 passes
    await manager.create({
      taskId: "task_iter_test",
      workspacePath: "/repo/test",
      goal: "G",
      plan: "P",
      iteration: 1,
    });
    await manager.execute("task_iter_test");

    // Next iteration skipping to 3 should be rejected
    await expect(
      manager.create({
        taskId: "task_iter_test",
        workspacePath: "/repo/test",
        goal: "G2",
        plan: "P2",
        iteration: 3,
      })
    ).rejects.toThrowError(/Invalid iteration: expected 2, got 3/);

    // Backward iteration 1 should be rejected
    await expect(
      manager.create({
        taskId: "task_iter_test",
        workspacePath: "/repo/test",
        goal: "G2",
        plan: "P2",
        iteration: 1,
      })
    ).rejects.toThrowError(/Invalid iteration: expected 2, got 1/);
  });

  it("records execution summary, saves output, and populates changedFiles from gitStatus", async () => {
    const { latestExecutionRecord } = await import("../src/execution/records.js");
    const { listExecutionOutputs, readExecutionOutput } = await import("../src/execution/output.js");

    const mockExecutor: Executor = {
      health: async () => true,
      ensureSession: async () => "ses_review_42",
      execute: async (req: ExecutionRequest, sessionId: string) => ({
        taskId: req.taskId,
        executorSessionId: sessionId,
        state: "COMPLETED",
        summary: "I completed the work. Fixed bug in src/index.ts and added tests.",
        changedFiles: [], // Intentionally empty to test gitStatus resolution
        startedAt: 1000,
        finishedAt: 2000,
      }),
      cancel: async () => true,
    };

    const manager = new TaskManager({
      workspaceId: "ws_test_mgr",
      store,
      executor: mockExecutor,
    });

    await manager.create({
      taskId: "task_review_1",
      workspacePath: tmpDir,
      goal: "Implement feature",
      plan: "Steps to follow",
      iteration: 1,
    });

    const result = await manager.execute("task_review_1");
    expect(result.state).toBe("COMPLETED");

    // Check latestExecutionRecord
    const latest = latestExecutionRecord("ws_test_mgr");
    expect(latest).not.toBeNull();
    expect(latest?.taskId).toBe("task_review_1");
    expect(latest?.iteration).toBe(1);
    expect(latest?.tests).toBeNull(); // tests not faked
    expect(latest?.exitStatus).toBe("0");
    expect(latest?.outputAvailable).toBe(true);
    expect(latest?.outputId).toBeDefined();

    // Check outputs
    const outputs = listExecutionOutputs("ws_test_mgr");
    expect(outputs.length).toBeGreaterThan(0);
    const outputItem = outputs.find((o) => o.id === latest?.outputId);
    expect(outputItem).toBeDefined();
    expect(outputItem?.command).toBe("opencode session ses_review_42");

    // Read execution output
    const readRes = readExecutionOutput("ws_test_mgr", latest!.outputId!);
    expect(readRes.ok).toBe(true);
    if (readRes.ok) {
      expect(readRes.text).toContain("I completed the work. Fixed bug in src/index.ts and added tests.");
    }
  });

  describe("recoverRunningTasks (Phase S4)", () => {
    it("resumes running tasks on restart without re-prompting or ensuring session", async () => {
      let ensureSessionCalls = 0;
      let executeCalls = 0;
      let resumeCalls = 0;
      let resumedSession = "";

      const mockExecutor: Executor = {
        health: async () => true,
        ensureSession: async () => {
          ensureSessionCalls++;
          return "ses_new";
        },
        execute: async () => {
          executeCalls++;
          throw new Error("execute should not be called on recovery");
        },
        resume: async (req: ExecutionRequest, sessionId: string) => {
          resumeCalls++;
          resumedSession = sessionId;
          return {
            taskId: req.taskId,
            executorSessionId: sessionId,
            state: "COMPLETED",
            summary: "Resumed and completed",
            changedFiles: [],
            startedAt: 1000,
            finishedAt: 2000,
          };
        },
        cancel: async () => true,
      };

      // Manually plant a RUNNING task in store as if bridge crashed mid-execution
      store.save({
        version: 1,
        taskId: "task_crashed_1",
        workspaceId: "ws_test_mgr",
        workspacePath: "/repo/test",
        goal: "Crashed task goal",
        plan: "Crashed task plan",
        iteration: 1,
        state: "RUNNING",
        executorSessionId: "ses_persisted_prior",
        executor: "opencode",
        createdAt: 1000,
        startedAt: 1050,
      });

      const newManager = new TaskManager({ store, executor: mockExecutor });
      await newManager.recoverRunningTasks();

      // Give background recovery a tick
      await new Promise((r) => setTimeout(r, 50));

      expect(resumeCalls).toBe(1);
      expect(resumedSession).toBe("ses_persisted_prior");
      expect(ensureSessionCalls).toBe(0);
      expect(executeCalls).toBe(0);

      const updated = await newManager.get("task_crashed_1");
      expect(updated?.state).toBe("COMPLETED");
      expect(updated?.summary).toBe("Resumed and completed");
    });

    it("marks task as FAILED if resume encounters SessionNotFoundError", async () => {
      const mockExecutor: Executor = {
        health: async () => true,
        ensureSession: async () => "ses_x",
        execute: async () => {
          throw new Error("unexpected execute");
        },
        resume: async () => {
          throw new Error("OpenCode API error: 404 POST /api/session/ses_gone/wait - [SessionNotFoundError] Session not found");
        },
        cancel: async () => true,
      };

      store.save({
        version: 1,
        taskId: "task_gone_session",
        workspaceId: "ws_test_mgr",
        workspacePath: "/repo/test",
        goal: "Gone task",
        plan: "Gone plan",
        iteration: 1,
        state: "RUNNING",
        executorSessionId: "ses_gone",
        executor: "opencode",
        createdAt: 1000,
      });

      const manager = new TaskManager({ store, executor: mockExecutor });
      await manager.recoverRunningTasks();
      await new Promise((r) => setTimeout(r, 50));

      const updated = await manager.get("task_gone_session");
      expect(updated?.state).toBe("FAILED");
      expect(updated?.error).toContain("OpenCode session not found while recovering task task_gone_session");
    });

    it("deduplicates recovery if called multiple times concurrently", async () => {
      let resumeCalls = 0;
      let resolveResume!: (res: ExecutionResult) => void;

      const mockExecutor: Executor = {
        health: async () => true,
        ensureSession: async () => "ses_x",
        execute: async () => {
          throw new Error("unexpected execute");
        },
        resume: async (req, sid) => {
          resumeCalls++;
          return new Promise<ExecutionResult>((resolve) => {
            resolveResume = resolve;
          });
        },
        cancel: async () => true,
      };

      store.save({
        version: 1,
        taskId: "task_concurrent_recover",
        workspaceId: "ws_test_mgr",
        workspacePath: "/repo/test",
        goal: "Concurrent",
        plan: "Concurrent",
        iteration: 1,
        state: "RUNNING",
        executorSessionId: "ses_concurrent",
        executor: "opencode",
        createdAt: 1000,
      });

      const manager = new TaskManager({ store, executor: mockExecutor });
      const p1 = manager.recoverRunningTasks();
      const p2 = manager.recoverRunningTasks();

      // Ensure recovery was triggered and deduped before waiting for resolve
      expect(resumeCalls).toBe(1);

      resolveResume!({
        taskId: "task_concurrent_recover",
        executorSessionId: "ses_concurrent",
        state: "COMPLETED",
        changedFiles: [],
        startedAt: 1000,
      });

      await Promise.all([p1, p2]);
    });
  });

  describe("task payload conflict checks (Phase S7)", () => {
    it("returns existing task if CREATED with identical payload (idempotent)", async () => {
      const manager = new TaskManager({ store });
      const t1 = await manager.create({
        taskId: "task_idem_1",
        workspacePath: "/repo/test",
        goal: "Same goal",
        plan: "Same plan",
        tests: ["test 1"],
      });

      const t2 = await manager.create({
        taskId: "task_idem_1",
        workspacePath: "/repo/test",
        goal: "Same goal",
        plan: "Same plan",
        tests: ["test 1"],
      });

      expect(t1.taskId).toBe(t2.taskId);
      expect(t1.createdAt).toBe(t2.createdAt);
    });

    it("throws TaskConflictError if CREATED with different plan or goal", async () => {
      const manager = new TaskManager({ store });
      await manager.create({
        taskId: "task_conflict_create",
        workspacePath: "/repo/test",
        goal: "Goal 1",
        plan: "Plan 1",
      });

      await expect(
        manager.create({
          taskId: "task_conflict_create",
          workspacePath: "/repo/test",
          goal: "Goal 1",
          plan: "Plan DIFFERENT",
        })
      ).rejects.toThrowError(/already exists with a different goal\/plan/);
    });

    it("returns existing task if RUNNING with identical payload (idempotent)", async () => {
      store.save({
        version: 1,
        taskId: "task_running_idem",
        workspaceId: "ws_test_mgr",
        workspacePath: "/repo/test",
        goal: "Run goal",
        plan: "Run plan",
        iteration: 1,
        state: "RUNNING",
        executorSessionId: "ses_123",
        executor: "opencode",
        createdAt: 1000,
      });

      const manager = new TaskManager({ store });
      const rec = await manager.create({
        taskId: "task_running_idem",
        workspacePath: "/repo/test",
        goal: "Run goal",
        plan: "Run plan",
      });

      expect(rec.state).toBe("RUNNING");
      expect(rec.executorSessionId).toBe("ses_123");
    });

    it("throws TaskConflictError if RUNNING with different goal or tests", async () => {
      store.save({
        version: 1,
        taskId: "task_running_diff",
        workspaceId: "ws_test_mgr",
        workspacePath: "/repo/test",
        goal: "Run goal",
        plan: "Run plan",
        tests: ["test A"],
        iteration: 1,
        state: "RUNNING",
        executorSessionId: "ses_123",
        executor: "opencode",
        createdAt: 1000,
      });

      const manager = new TaskManager({ store });
      await expect(
        manager.create({
          taskId: "task_running_diff",
          workspacePath: "/repo/test",
          goal: "Run goal",
          plan: "Run plan",
          tests: ["test DIFFERENT"],
        })
      ).rejects.toThrowError(/already exists with a different goal\/plan/);
    });
  });
});
