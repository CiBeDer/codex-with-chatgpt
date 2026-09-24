import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { TaskStore } from "../src/execution/task-store.js";
import type { TaskRecord } from "../src/execution/task-store.js";

describe("TaskStore (Phase 5)", () => {
  let tmpDir: string;
  let store: TaskStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "c2c-task-store-test-"));
    store = new TaskStore({ stateDir: tmpDir });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("save and load task record", () => {
    const record: TaskRecord = {
      version: 1,
      taskId: "task_123",
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
  });

  it("updates task record atomically", () => {
    const record: TaskRecord = {
      version: 1,
      taskId: "task_update_1",
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

  it("restart simulation: re-instantiated store loads previously written tasks", () => {
    const record: TaskRecord = {
      version: 1,
      taskId: "task_restart",
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

    const newStoreInstance = new TaskStore({ stateDir: tmpDir });
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

  it("handles corrupted json gracefully by returning null", () => {
    const file = path.join(tmpDir, "tasks", "task_corrupt.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{ bad json");

    const loaded = store.get("task_corrupt");
    expect(loaded).toBeNull();
  });
});
