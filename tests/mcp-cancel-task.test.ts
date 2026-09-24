import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createMcpServer } from "../src/mcp/server.js";
import { Workspace } from "../src/workspace/manager.js";
import { nullLogger } from "../src/logger/index.js";
import { makeTmpDir, cleanup, write } from "./helpers.js";
import type { TaskManager } from "../src/execution/task-manager.js";

describe("MCP cancel_task (Phase 10)", () => {
  let root: string;
  let workspace: Workspace;

  beforeEach(() => {
    root = makeTmpDir("mcp-cancel-test");
    write(root, "README.md", "# Test\n");
    workspace = new Workspace(root);
  });

  afterEach(() => {
    cleanup(root);
  });

  it("fails with INSUFFICIENT_SCOPE when execution.submit scope is missing", async () => {
    const server = createMcpServer({ workspace, logger: nullLogger });
    const tool = (server as any)._registeredTools["cancel_task"];
    expect(tool).toBeDefined();

    const res = await tool.handler(
      { task_id: "task_1" },
      { authInfo: { scopes: ["execution.read"] } }
    );

    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content[0].text).error).toBe("INSUFFICIENT_SCOPE");
  });

  it("cancels running task successfully", async () => {
    let cancelCalledWith: string | null = null;
    const mockTaskManager: Partial<TaskManager> = {
      cancel: async (taskId) => {
        cancelCalledWith = taskId;
        return true;
      },
    };

    const server = createMcpServer({
      workspace,
      logger: nullLogger,
      taskManager: mockTaskManager as TaskManager,
    });
    const tool = (server as any)._registeredTools["cancel_task"];

    const res = await tool.handler(
      { task_id: "task_running_1" },
      { authInfo: { scopes: ["execution.submit"] } }
    );

    expect(res.isError).toBeUndefined();
    expect(cancelCalledWith).toBe("task_running_1");
    expect(res.structuredContent).toEqual({
      task_id: "task_running_1",
      cancelled: true,
      state: "CANCELLED",
    });
  });

  it("is idempotent when canceling already cancelled task", async () => {
    const mockTaskManager: Partial<TaskManager> = {
      cancel: async () => true,
    };

    const server = createMcpServer({
      workspace,
      logger: nullLogger,
      taskManager: mockTaskManager as TaskManager,
    });
    const tool = (server as any)._registeredTools["cancel_task"];

    const res = await tool.handler(
      { task_id: "task_already_cancelled" },
      { authInfo: { scopes: ["execution.submit"] } }
    );

    expect(res.isError).toBeUndefined();
    expect(res.structuredContent.cancelled).toBe(true);
  });

  it("refuses to cancel completed or failed task", async () => {
    const mockTaskManager: Partial<TaskManager> = {
      cancel: async () => false,
    };

    const server = createMcpServer({
      workspace,
      logger: nullLogger,
      taskManager: mockTaskManager as TaskManager,
    });
    const tool = (server as any)._registeredTools["cancel_task"];

    const res = await tool.handler(
      { task_id: "task_completed" },
      { authInfo: { scopes: ["execution.submit"] } }
    );

    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content[0].text).error).toBe("CANNOT_CANCEL");
  });
});
