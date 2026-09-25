import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { ensureDir, getStateDir } from "../config/paths.js";
import type { ExecutionState } from "../executor/types.js";

export interface TaskRecord {
  version: 1;

  taskId: string;
  workspaceId: string;
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
  workspaceId: string;
}

export class TaskStore {
  readonly workspaceId: string;
  private baseDir: string;

  constructor(opts: TaskStoreOptions) {
    if (!opts.workspaceId) {
      throw new Error("TaskStore requires a workspaceId");
    }
    this.workspaceId = opts.workspaceId;
    const root = opts.stateDir ?? getStateDir();
    this.baseDir = ensureDir(path.join(root, "tasks", opts.workspaceId));
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
    if (record.workspaceId !== this.workspaceId) {
      throw new Error(
        `TaskRecord workspaceId mismatch: expected ${this.workspaceId}, got ${record.workspaceId}`
      );
    }
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
      const record = JSON.parse(content) as TaskRecord;
      if (record.workspaceId !== this.workspaceId) {
        return null;
      }
      return record;
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
      workspaceId: this.workspaceId,
      version: 1,
    };

    this.save(updated);
    return updated;
  }

  list(): TaskRecord[] {
    const dir = this.baseDir;
    if (!fs.existsSync(dir)) {
      return [];
    }

    try {
      const files = fs.readdirSync(dir);
      const records: TaskRecord[] = [];

      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        const filePath = path.join(dir, file);
        try {
          const content = fs.readFileSync(filePath, "utf8");
          const record = JSON.parse(content) as TaskRecord;
          if (record && record.workspaceId === this.workspaceId && record.taskId) {
            records.push(record);
          }
        } catch {
          // Ignore unparseable or corrupted files safely
        }
      }

      return records;
    } catch {
      return [];
    }
  }
}
