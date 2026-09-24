import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { ensureDir, getStateDir } from "../config/paths.js";
import type { ExecutionState } from "../executor/types.js";

export interface TaskRecord {
  version: 1;

  taskId: string;
  workspacePath: string;

  goal: string;
  plan: string;
  tests?: string[];
  iteration: number;

  state: ExecutionState;

  executor: "opencode";
  executorSessionId?: string;

  createdAt: number;
  startedAt?: number;
  finishedAt?: number;

  summary?: string;
  error?: string;
}

const TASK_ID_REGEX = /^[A-Za-z0-9_-]{1,64}$/;

export interface TaskStoreOptions {
  stateDir?: string;
}

export class TaskStore {
  private baseDir: string;

  constructor(opts: TaskStoreOptions = {}) {
    const root = opts.stateDir ?? getStateDir();
    this.baseDir = ensureDir(path.join(root, "tasks"));
  }

  private validateTaskId(taskId: string): void {
    if (!taskId || !TASK_ID_REGEX.test(taskId)) {
      throw new Error(`Invalid taskId: ${taskId}`);
    }
  }

  private getTaskFilePath(taskId: string): string {
    this.validateTaskId(taskId);
    return path.join(this.baseDir, `${taskId}.json`);
  }

  save(record: TaskRecord): void {
    this.validateTaskId(record.taskId);
    const targetFile = this.getTaskFilePath(record.taskId);
    const tempFile = path.join(
      this.baseDir,
      `.${record.taskId}.${randomBytes(8).toString("hex")}.tmp`
    );

    const data = JSON.stringify(record, null, 2);
    const fd = fs.openSync(tempFile, "w", 0o600);
    try {
      fs.writeSync(fd, data);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }

    try {
      fs.renameSync(tempFile, targetFile);
    } catch (err) {
      if (fs.existsSync(tempFile)) {
        try {
          fs.unlinkSync(tempFile);
        } catch {
          // ignore cleanup error
        }
      }
      throw err;
    }
  }

  get(taskId: string): TaskRecord | null {
    this.validateTaskId(taskId);
    const targetFile = this.getTaskFilePath(taskId);
    if (!fs.existsSync(targetFile)) {
      return null;
    }

    try {
      const content = fs.readFileSync(targetFile, "utf8");
      return JSON.parse(content) as TaskRecord;
    } catch {
      return null;
    }
  }

  update(taskId: string, patch: Partial<TaskRecord>): TaskRecord {
    const existing = this.get(taskId);
    if (!existing) {
      throw new Error(`Task not found: ${taskId}`);
    }

    const updated: TaskRecord = {
      ...existing,
      ...patch,
      taskId: existing.taskId,
      version: 1,
    };

    this.save(updated);
    return updated;
  }
}
