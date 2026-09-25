import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { TaskStore } from "../src/execution/task-store.js";
import type { TaskRecord } from "../src/execution/task-store.js";

describe("TaskStore (Phase R3 Workspace Isolation)", () => {
  let tmpDir: string;
  let store: TaskStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "c2c-task-store-test-"));
    store = new TaskStore({ stateDir: tmpDir, workspaceId: "ws_alpha" });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("save and load task record scoped to workspace", () => {
    const record: TaskRecord = {
      version: 1,
      taskId: "task_123",
      workspaceId: "ws_alpha",
      workspacePath: "/test/workspace",
      goal: "Fix bug",
      plan: "Do changes",
      iteration: 1,
      state: "CREATED",
      executor: "opencode",
      createdAt: Date.now(),
    };

    store.save(record);
    const loaded = store.get("task_123");
    expect(loaded).toEqual(record);

    // Check directory layout: tasks/<workspaceId>/<taskId>.json
    const expectedPath = path.join(tmpDir, "tasks", "ws_alpha", "task_123.json");
    expect(fs.existsSync(expectedPath)).toBe(true);
  });

  it("isolates tasks between different workspaces with same taskId", () => {
    const storeBeta = new TaskStore({ stateDir: tmpDir, workspaceId: "ws_beta" });

    const recordAlpha: TaskRecord = {
      version: 1,
      taskId: "task_shared_id",
      workspaceId: "ws_alpha",
      workspacePath: "/repo/alpha",
      goal: "Alpha goal",
      plan: "Alpha plan",
      iteration: 1,
      state: "CREATED",
      executor: "opencode",
      createdAt: 1000,
    };

    const recordBeta: TaskRecord = {
      version: 1,
      taskId: "task_shared_id",
      workspaceId: "ws_beta",
      workspacePath: "/repo/beta",
      goal: "Beta goal",
      plan: "Beta plan",
      iteration: 1,
      state: "RUNNING",
      executor: "opencode",
      createdAt: 2000,
    };

    store.save(recordAlpha);
    storeBeta.save(recordBeta);

    const loadedAlpha = store.get("task_shared_id");
    const loadedBeta = storeBeta.get("task_shared_id");

    expect(loadedAlpha?.workspaceId).toBe("ws_alpha");
    expect(loadedAlpha?.workspacePath).toBe("/repo/alpha");
    expect(loadedAlpha?.state).toBe("CREATED");

    expect(loadedBeta?.workspaceId).toBe("ws_beta");
    expect(loadedBeta?.workspacePath).toBe("/repo/beta");
    expect(loadedBeta?.state).toBe("RUNNING");
  });

  it("rejects saving a record with mismatched workspaceId", () => {
    const mismatchRecord: TaskRecord = {
      version: 1,
      taskId: "task_mismatch",
      workspaceId: "ws_different",
      workspacePath: "/test",
      goal: "g",
      plan: "p",
      iteration: 1,
      state: "CREATED",
      executor: "opencode",
      createdAt: Date.now(),
    };

    expect(() => store.save(mismatchRecord)).toThrowError(/workspaceId mismatch/);
  });

  it("updates task record atomically within workspace", () => {
    const record: TaskRecord = {
      version: 1,
      taskId: "task_update_1",
      workspaceId: "ws_alpha",
      workspacePath: "/test/workspace",
      goal: "Fix bug",
      plan: "Do changes",
      iteration: 1,
      state: "CREATED",
      executor: "opencode",
      createdAt: Date.now(),
    };
    store.save(record);

    store.update("task_update_1", {
      state: "RUNNING",
      startedAt: Date.now(),
      executorSessionId: "ses_abc",
    });

    const updated = store.get("task_update_1");
    expect(updated?.state).toBe("RUNNING");
    expect(updated?.executorSessionId).toBe("ses_abc");
    expect(updated?.startedAt).toBeDefined();
  });

  it("restart simulation: re-instantiated store loads previously written tasks for workspace", () => {
    const record: TaskRecord = {
      version: 1,
      taskId: "task_restart",
      workspaceId: "ws_alpha",
      workspacePath: "/test/workspace",
      goal: "Restart goal",
      plan: "Restart plan",
      iteration: 1,
      state: "COMPLETED",
      executor: "opencode",
      createdAt: 1000,
      finishedAt: 2000,
      summary: "Done successfully",
    };
    store.save(record);

    const newStoreInstance = new TaskStore({ stateDir: tmpDir, workspaceId: "ws_alpha" });
    const loaded = newStoreInstance.get("task_restart");
    expect(loaded).toEqual(record);
  });

  it("rejects invalid task id with directory traversal or forbidden characters", () => {
    const invalidIds = ["../task", "task/123", "task\\123", "task:123", "", "a".repeat(65)];

    for (const id of invalidIds) {
      expect(() =>
        store.save({
          version: 1,
          taskId: id,
          workspaceId: "ws_alpha",
          workspacePath: "/test",
          goal: "g",
          plan: "p",
          iteration: 1,
          state: "CREATED",
          executor: "opencode",
          createdAt: Date.now(),
        })
      ).toThrowError(/Invalid taskId/);

      expect(() => store.get(id)).toThrowError(/Invalid taskId/);
    }
  });

  it("lists all task records belonging to current workspace and ignores corrupted files", () => {
    store.save({
      version: 1,
      taskId: "task_list_1",
      workspaceId: "ws_alpha",
      workspacePath: "/test",
      goal: "g1",
      plan: "p1",
      iteration: 1,
      state: "CREATED",
      executor: "opencode",
      createdAt: 100,
    });
    store.save({
      version: 1,
      taskId: "task_list_2",
      workspaceId: "ws_alpha",
      workspacePath: "/test",
      goal: "g2",
      plan: "p2",
      iteration: 1,
      state: "RUNNING",
      executorSessionId: "ses_list_2",
      executor: "opencode",
      createdAt: 200,
    });

    // Write a non-json file and a corrupted json file
    const tasksDir = path.join(tmpDir, "tasks", "ws_alpha");
    fs.writeFileSync(path.join(tasksDir, "notes.txt"), "some notes");
    fs.writeFileSync(path.join(tasksDir, "corrupted.json"), "invalid json content");

    const list = store.list();
    expect(list).toHaveLength(2);
    const taskIds = list.map((t) => t.taskId).sort();
    expect(taskIds).toEqual(["task_list_1", "task_list_2"]);
  });

  it("handles corrupted json gracefully by returning null", () => {
    const file = path.join(tmpDir, "tasks", "ws_alpha", "task_corrupt.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{ bad json");

    const loaded = store.get("task_corrupt");
    expect(loaded).toBeNull();
  });
});
