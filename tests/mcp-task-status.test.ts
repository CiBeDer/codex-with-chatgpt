import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createMcpServer } from "../src/mcp/server.js";
import { Workspace } from "../src/workspace/manager.js";
import { nullLogger } from "../src/logger/index.js";
import { makeTmpDir, cleanup, write } from "./helpers.js";
import type { TaskManager } from "../src/execution/task-manager.js";

describe("MCP task_status (Phase 9)", () => {
  let root: string;
  let workspace: Workspace;

  beforeEach(() => {
    root = makeTmpDir("mcp-status-test");
    write(root, "README.md", "# Test\n");
    workspace = new Workspace(root);
  });

  afterEach(() => {
    cleanup(root);
  });

  it("fails with INSUFFICIENT_SCOPE when execution.read scope is missing", async () => {
    const server = createMcpServer({ workspace, logger: nullLogger });
    const tool = (server as any)._registeredTools["task_status"];
    expect(tool).toBeDefined();

    const res = await tool.handler(
      { task_id: "task_1" },
      { authInfo: { scopes: ["workspace.read"] } }
    );

    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content[0].text).error).toBe("INSUFFICIENT_SCOPE");
  });

  it("returns RUNNING status for running task with execution.read scope", async () => {
    const mockTaskManager: Partial<TaskManager> = {
      get: async (taskId) => ({
        version: 1,
        taskId,
        workspacePath: "/repo",
        goal: "Goal",
        plan: "Plan",
        iteration: 1,
        state: "RUNNING",
        executor: "opencode",
        createdAt: 1000,
        startedAt: 1500,
      }),
    };

    const server = createMcpServer({
      workspace,
      logger: nullLogger,
      taskManager: mockTaskManager as TaskManager,
    });
    const tool = (server as any)._registeredTools["task_status"];

    const res = await tool.handler(
      { task_id: "task_running" },
      { authInfo: { scopes: ["execution.read"] } }
    );

    expect(res.isError).toBeUndefined();
    expect(res.structuredContent).toEqual({
      task_id: "task_running",
      state: "RUNNING",
      started_at: 1500,
    });
  });

  it("returns COMPLETED status for completed task", async () => {
    const mockTaskManager: Partial<TaskManager> = {
      get: async (taskId) => ({
        version: 1,
        taskId,
        workspacePath: "/repo",
        goal: "Goal",
        plan: "Plan",
        iteration: 1,
        state: "COMPLETED",
        executor: "opencode",
        summary: "Execution passed all tests",
        createdAt: 1000,
        startedAt: 1500,
        finishedAt: 2500,
      }),
    };

    const server = createMcpServer({
      workspace,
      logger: nullLogger,
      taskManager: mockTaskManager as TaskManager,
    });
    const tool = (server as any)._registeredTools["task_status"];

    const res = await tool.handler(
      { task_id: "task_done" },
      { authInfo: { scopes: ["execution.read"] } }
    );

    expect(res.isError).toBeUndefined();
    expect(res.structuredContent).toEqual({
      task_id: "task_done",
      state: "COMPLETED",
      summary: "Execution passed all tests",
      finished_at: 2500,
    });
  });

  it("returns FAILED status for failed task", async () => {
    const mockTaskManager: Partial<TaskManager> = {
      get: async (taskId) => ({
        version: 1,
        taskId,
        workspacePath: "/repo",
        goal: "Goal",
        plan: "Plan",
        iteration: 1,
        state: "FAILED",
        executor: "opencode",
        error: "Compilation error",
        createdAt: 1000,
        finishedAt: 2000,
      }),
    };

    const server = createMcpServer({
      workspace,
      logger: nullLogger,
      taskManager: mockTaskManager as TaskManager,
    });
    const tool = (server as any)._registeredTools["task_status"];

    const res = await tool.handler(
      { task_id: "task_failed" },
      { authInfo: { scopes: ["execution.read"] } }
    );

    expect(res.isError).toBeUndefined();
    expect(res.structuredContent).toEqual({
      task_id: "task_failed",
      state: "FAILED",
      error: "Compilation error",
    });
  });

  it("returns NOT_FOUND error when task does not exist", async () => {
    const mockTaskManager: Partial<TaskManager> = {
      get: async () => null,
    };

    const server = createMcpServer({
      workspace,
      logger: nullLogger,
      taskManager: mockTaskManager as TaskManager,
    });
    const tool = (server as any)._registeredTools["task_status"];

    const res = await tool.handler(
      { task_id: "task_non_exist" },
      { authInfo: { scopes: ["execution.read"] } }
    );

    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content[0].text).error).toBe("NOT_FOUND");
  });
});
