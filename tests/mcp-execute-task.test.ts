import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createMcpServer } from "../src/mcp/server.js";
import { Workspace } from "../src/workspace/manager.js";
import { nullLogger } from "../src/logger/index.js";
import { makeTmpDir, cleanup, write } from "./helpers.js";
import type { TaskManager } from "../src/execution/task-manager.js";
import type { ExecutionResult } from "../src/executor/types.js";

describe("MCP execute_task (Phase 8)", () => {
  let root: string;
  let workspace: Workspace;

  beforeEach(() => {
    root = makeTmpDir("mcp-execute-test");
    write(root, "README.md", "# Test\n");
    workspace = new Workspace(root);
  });

  afterEach(() => {
    cleanup(root);
  });

  it("fails with INSUFFICIENT_SCOPE when execution.submit scope is missing", async () => {
    const server = createMcpServer({ workspace, logger: nullLogger });
    const tool = (server as any)._registeredTools["execute_task"];
    expect(tool).toBeDefined();

    const res = await tool.handler(
      {
        task_id: "task_1",
        goal: "Fix bug",
        plan: "Fix it",
      },
      { authInfo: { scopes: ["workspace.read", "execution.read"] } }
    );

    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content[0].text).error).toBe("INSUFFICIENT_SCOPE");
  });

  it("completes task successfully within wait timeout", async () => {
    const mockTaskManager: Partial<TaskManager> = {
      create: async (opts) => ({
        version: 1,
        taskId: opts.taskId,
        workspacePath: opts.workspacePath,
        goal: opts.goal,
        plan: opts.plan,
        iteration: opts.iteration ?? 1,
        state: "CREATED",
        executor: "opencode",
        createdAt: Date.now(),
      }),
      execute: async (taskId) => ({
        taskId,
        state: "COMPLETED",
        summary: "Execution succeeded",
        changedFiles: ["src/app.ts"],
        startedAt: 1000,
        finishedAt: 2000,
      }),
    };

    const server = createMcpServer({
      workspace,
      logger: nullLogger,
      taskManager: mockTaskManager as TaskManager,
    });
    const tool = (server as any)._registeredTools["execute_task"];

    const res = await tool.handler(
      {
        task_id: "task_ok",
        goal: "Fix bug",
        plan: "Do A, B, C",
        tests: ["pnpm test"],
      },
      { authInfo: { scopes: ["execution.submit"] } }
    );

    expect(res.isError).toBeUndefined();
    const data = res.structuredContent;
    expect(data.task_id).toBe("task_ok");
    expect(data.state).toBe("COMPLETED");
    expect(data.summary).toBe("Execution succeeded");
    expect(data.changed_files).toEqual(["src/app.ts"]);
  });

  it("returns RUNNING status if execution exceeds wait timeout without cancelling task", async () => {
    const mockTaskManager: Partial<TaskManager> = {
      create: async (opts) => ({
        version: 1,
        taskId: opts.taskId,
        workspacePath: opts.workspacePath,
        goal: opts.goal,
        plan: opts.plan,
        iteration: 1,
        state: "CREATED",
        executor: "opencode",
        createdAt: Date.now(),
      }),
      execute: (taskId) =>
        new Promise<ExecutionResult>((resolve) => {
          setTimeout(() => {
            resolve({
              taskId,
              state: "COMPLETED",
              changedFiles: [],
              startedAt: 1000,
              finishedAt: 5000,
            });
          }, 300);
        }),
    };

    const server = createMcpServer({
      workspace,
      logger: nullLogger,
      taskManager: mockTaskManager as TaskManager,
      executionWaitMs: 50, // Short timeout for test
    });
    const tool = (server as any)._registeredTools["execute_task"];

    const res = await tool.handler(
      {
        task_id: "task_timeout",
        goal: "Long task",
        plan: "Take long time",
      },
      { authInfo: { scopes: ["execution.submit"] } }
    );

    expect(res.isError).toBeUndefined();
    const data = res.structuredContent;
    expect(data.task_id).toBe("task_timeout");
    expect(data.state).toBe("RUNNING");
    expect(data.message).toContain("task_status");
  });

  it("handles TASK_CONFLICT error gracefully when submitting different payload for existing task", async () => {
    const mockTaskManager: Partial<TaskManager> = {
      create: async (opts) => {
        const error = new Error(
          `Task ${opts.taskId} already exists with a different goal/plan. Wait for the existing task to finish or use a different task_id.`
        );
        (error as any).code = "TASK_CONFLICT";
        throw error;
      },
    };

    const server = createMcpServer({
      workspace,
      logger: nullLogger,
      taskManager: mockTaskManager as TaskManager,
    });
    const tool = (server as any)._registeredTools["execute_task"];

    const res = await tool.handler(
      {
        task_id: "task_conflict_1",
        goal: "Different goal",
        plan: "Different plan",
      },
      { authInfo: { scopes: ["execution.submit"] } }
    );

    expect(res.isError).toBe(true);
    const parsed = JSON.parse(res.content[0].text);
    expect(parsed.error).toBe("TASK_CONFLICT");
    expect(parsed.message).toContain("Task task_conflict_1 already exists with a different goal/plan");
  });
});
