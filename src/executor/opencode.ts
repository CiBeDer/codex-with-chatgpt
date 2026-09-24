import type { Executor } from "./executor.js";
import type { ExecutionRequest, ExecutionResult, ExecutionState } from "./types.js";

export interface OpenCodeConfig {
  baseUrl?: string;
  username?: string;
  password?: string;
  agent?: string;
  providerId?: string;
  modelId?: string;
  variant?: string;
  timeoutMs?: number;
}

export interface CreateSessionOptions {
  title?: string;
  directory?: string;
  agent?: string;
  model?: {
    providerID: string;
    modelID: string;
  };
}

export interface PromptOptions {
  text: string;
  files?: Array<{ path: string; content?: string }>;
}

export class OpenCodeClient {
  readonly baseUrl: string;
  private readonly username?: string;
  private readonly password?: string;
  private readonly timeoutMs: number;

  constructor(config: OpenCodeConfig = {}) {
    let base = config.baseUrl || "http://127.0.0.1:4096";
    this.baseUrl = base.replace(/\/+$/, "");
    this.username = config.username;
    this.password = config.password;
    this.timeoutMs = config.timeoutMs ?? 30000;
  }

  private getAuthHeader(): string | undefined {
    if (this.username || this.password) {
      const user = this.username ?? "";
      const pass = this.password ?? "";
      return "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");
    }
    return undefined;
  }

  private async request<T>(
    method: string,
    endpoint: string,
    body?: unknown,
    overrideTimeoutMs?: number
  ): Promise<T> {
    const url = `${this.baseUrl}${endpoint.startsWith("/") ? "" : "/"}${endpoint}`;
    const headers: Record<string, string> = {};
    const authHeader = this.getAuthHeader();
    if (authHeader) {
      headers["Authorization"] = authHeader;
    }

    let bodyStr: string | undefined;
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      bodyStr = JSON.stringify(body);
    }

    const timeoutMs = overrideTimeoutMs ?? this.timeoutMs;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(url, {
        method,
        headers,
        body: bodyStr,
        signal: controller.signal,
      });

      const text = await res.text();
      let data: any;
      if (text.length > 0) {
        try {
          data = JSON.parse(text);
        } catch {
          const snippet = text.slice(0, 100);
          throw new Error(
            `Invalid JSON response from OpenCode API (${method} ${endpoint}): ${snippet}`
          );
        }
      }

      if (!res.ok) {
        const errorDetail =
          data && typeof data === "object"
            ? data.message || data.error || JSON.stringify(data)
            : text.slice(0, 200);
        throw new Error(
          `OpenCode API error: ${res.status} ${method} ${endpoint} - ${errorDetail}`
        );
      }

      return data as T;
    } catch (err: any) {
      if (err.name === "AbortError") {
        throw new Error(
          `OpenCode API request timed out after ${timeoutMs}ms (${method} ${endpoint})`
        );
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  async health(): Promise<boolean> {
    try {
      await this.request<{ ok?: boolean }>("GET", "/api/info", undefined, 5000);
      return true;
    } catch {
      return false;
    }
  }

  async createSession(opts: CreateSessionOptions = {}): Promise<{ id: string }> {
    const payload: Record<string, any> = {};
    if (opts.title) payload.title = opts.title;
    if (opts.directory) {
      payload.location = { directory: opts.directory };
    }
    if (opts.agent) payload.agent = opts.agent;
    if (opts.model) payload.model = opts.model;

    const res = await this.request<{ data: { id: string } }>(
      "POST",
      "/api/session",
      payload
    );
    return res.data;
  }

  async prompt(sessionId: string, opts: PromptOptions): Promise<any> {
    return this.request<any>("POST", `/api/session/${encodeURIComponent(sessionId)}/prompt`, opts);
  }

  async interrupt(sessionId: string): Promise<boolean> {
    await this.request<any>(
      "POST",
      `/api/session/${encodeURIComponent(sessionId)}/interrupt`
    );
    return true;
  }
}

export function buildExecutionPrompt(req: ExecutionRequest): string {
  const tests = req.tests && req.tests.length > 0 ? req.tests.join("\n") : "None specified";

  return `You are the execution agent.

The architectural analysis and implementation plan have already
been produced by ChatGPT.

Your responsibility is execution.

WORKSPACE:
${req.workspacePath}

GOAL:
${req.goal}

IMPLEMENTATION PLAN:
${req.plan}

REQUESTED TESTS:
${tests}

Rules:

1. Execute the supplied plan.
2. Inspect additional files only when necessary for execution.
3. You may edit/create/delete project files when required.
4. You may run build/test/lint commands.
5. Fix implementation-level errors you encounter.
6. Do not redesign the architecture unless the supplied plan is impossible.
7. Do not commit or push Git changes.
8. Never modify files outside the supplied workspace.
9. When finished, summarize:
   - what changed
   - files changed
   - tests run
   - tests passed/failed
   - unresolved problems`;
}

export class OpenCodeExecutor implements Executor {
  private client: OpenCodeClient;
  private activeSessions = new Map<string, string>(); // taskId -> sessionId

  constructor(readonly config: OpenCodeConfig = {}) {
    this.client = new OpenCodeClient(config);
  }

  async health(): Promise<boolean> {
    return this.client.health();
  }

  async execute(request: ExecutionRequest): Promise<ExecutionResult> {
    const startedAt = Date.now();
    try {
      let sessionId = this.activeSessions.get(request.taskId);
      if (!sessionId) {
        const session = await this.client.createSession({
          title: `Task ${request.taskId}`,
          directory: request.workspacePath,
          agent: this.config.agent,
          model:
            this.config.providerId && this.config.modelId
              ? { providerID: this.config.providerId, modelID: this.config.modelId }
              : undefined,
        });
        sessionId = session.id;
        this.activeSessions.set(request.taskId, sessionId);
      }

      const promptText = buildExecutionPrompt(request);
      const promptResult = await this.client.prompt(sessionId, { text: promptText });

      const outputText =
        promptResult?.data?.text ||
        (typeof promptResult?.data === "string" ? promptResult.data : "") ||
        "";

      // Parse changed files from outputText if present
      const changedFiles: string[] = [];
      const changedMatch = outputText.match(/(?:Changed files|files changed):\s*([^\n]+)/i);
      if (changedMatch && changedMatch[1]) {
        for (const file of changedMatch[1].split(/[,;\s]+/)) {
          const trimmed = file.trim();
          if (trimmed && !changedFiles.includes(trimmed)) {
            changedFiles.push(trimmed);
          }
        }
      }

      return {
        taskId: request.taskId,
        state: "COMPLETED",
        summary: outputText,
        changedFiles,
        startedAt,
        finishedAt: Date.now(),
      };
    } catch (err: any) {
      return {
        taskId: request.taskId,
        state: "FAILED",
        error: err instanceof Error ? err.message : String(err),
        changedFiles: [],
        startedAt,
        finishedAt: Date.now(),
      };
    }
  }

  async cancel(taskId: string): Promise<boolean> {
    const sessionId = this.activeSessions.get(taskId);
    if (!sessionId) return false;
    return this.client.interrupt(sessionId);
  }
}
