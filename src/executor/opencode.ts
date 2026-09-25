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
  requestTimeoutMs?: number;
  executionTimeoutMs?: number;
  /** @deprecated use requestTimeoutMs instead */
  timeoutMs?: number;
}

export interface CreateSessionOptions {
  directory?: string;
  agent?: string;
  model?: {
    providerID: string;
    id: string;
    variant?: string;
  };
}

export interface PromptOptions {
  text: string;
}

export interface OpenCodeStructuredError {
  type?: string;
  message: string;
}

export type OpenCodeAssistantMessage = {
  type: "assistant";
  time?: {
    created?: number;
    completed?: number;
  };
  finish?: "stop" | "length" | "tool-calls" | "content-filter" | "error" | "unknown";
  error?: OpenCodeStructuredError;
  content?: Array<
    | { type: "text"; text: string }
    | { type: "reasoning"; text?: string }
    | { type: string; [key: string]: unknown }
  >;
};

export type OpenCodeContextMessage =
  | OpenCodeAssistantMessage
  | {
      type: string;
      [key: string]: unknown;
    };

export interface ParsedAssistantResult {
  found: boolean;
  completed: boolean;
  text: string;
  finish?: string;
  error?: {
    type?: string;
    message: string;
  };
}

export function parseLatestCompletedAssistant(
  messages: OpenCodeContextMessage[]
): ParsedAssistantResult {
  if (!Array.isArray(messages)) {
    return { found: false, completed: false, text: "" };
  }

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (
      msg &&
      msg.type === "assistant" &&
      typeof (msg as OpenCodeAssistantMessage).time?.completed === "number"
    ) {
      const assistantMsg = msg as OpenCodeAssistantMessage;
      const texts: string[] = [];
      if (Array.isArray(assistantMsg.content)) {
        for (const part of assistantMsg.content) {
          if (part && part.type === "text" && typeof (part as any).text === "string") {
            texts.push((part as any).text);
          }
        }
      }

      return {
        found: true,
        completed: true,
        text: texts.join("\n"),
        finish: assistantMsg.finish,
        error: assistantMsg.error,
      };
    }
  }

  return { found: false, completed: false, text: "" };
}

export function extractLatestAssistantText(messages: OpenCodeContextMessage[]): string {
  return parseLatestCompletedAssistant(messages).text;
}

export class OpenCodeClient {
  readonly baseUrl: string;
  private readonly username?: string;
  private readonly password?: string;
  private readonly requestTimeoutMs: number;
  private readonly executionTimeoutMs: number;

  constructor(config: OpenCodeConfig = {}) {
    let base = config.baseUrl || "http://127.0.0.1:4096";
    this.baseUrl = base.replace(/\/+$/, "");
    this.username = config.username;
    this.password = config.password;
    this.requestTimeoutMs = config.requestTimeoutMs ?? config.timeoutMs ?? 30000;
    this.executionTimeoutMs = config.executionTimeoutMs ?? 60 * 60 * 1000;
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

    const timeoutMs = overrideTimeoutMs ?? this.requestTimeoutMs;
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
        let errorDetail = "";
        if (data && typeof data === "object") {
          if (data._tag && data.message) {
            errorDetail = `[${data._tag}] ${data.message}`;
          } else {
            errorDetail = data.message || data.error || JSON.stringify(data);
          }
        } else {
          errorDetail = text.slice(0, 200);
        }
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
      await this.request<{ ok?: boolean }>("GET", "/api/health", undefined, 5000);
      return true;
    } catch {
      return false;
    }
  }

  async createSession(opts: CreateSessionOptions = {}): Promise<{ id: string }> {
    const payload: Record<string, any> = {};
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
    const payload = {
      prompt: {
        text: opts.text,
      },
    };
    return this.request<any>("POST", `/api/session/${encodeURIComponent(sessionId)}/prompt`, payload);
  }

  async waitForIdle(sessionId: string, timeoutMs?: number): Promise<void> {
    await this.request<void>(
      "POST",
      `/api/session/${encodeURIComponent(sessionId)}/wait`,
      undefined,
      timeoutMs ?? this.executionTimeoutMs
    );
  }

  async getContext(sessionId: string): Promise<{ data: OpenCodeContextMessage[] }> {
    return this.request<{ data: OpenCodeContextMessage[] }>(
      "GET",
      `/api/session/${encodeURIComponent(sessionId)}/context`
    );
  }

  async interrupt(sessionId: string): Promise<boolean> {
    await this.request<void>(
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

  constructor(readonly config: OpenCodeConfig = {}) {
    this.client = new OpenCodeClient(config);
  }

  async health(): Promise<boolean> {
    return this.client.health();
  }

  async ensureSession(request: ExecutionRequest): Promise<string> {
    const session = await this.client.createSession({
      directory: request.workspacePath,
      agent: this.config.agent,
      model:
        this.config.providerId && this.config.modelId
          ? {
              providerID: this.config.providerId,
              id: this.config.modelId,
              variant: this.config.variant,
            }
          : undefined,
    });
    return session.id;
  }

  private async collectResult(
    request: ExecutionRequest,
    sessionId: string,
    startedAt: number
  ): Promise<ExecutionResult> {
    try {
      await this.client.waitForIdle(sessionId);

      const contextRes = await this.client.getContext(sessionId);
      const parsedAssistant = parseLatestCompletedAssistant(contextRes.data);

      if (!parsedAssistant.found || !parsedAssistant.completed) {
        return {
          taskId: request.taskId,
          executorSessionId: sessionId,
          state: "FAILED",
          error: "No completed assistant message found after OpenCode session became idle",
          changedFiles: [],
          startedAt,
          finishedAt: Date.now(),
        };
      }

      if (parsedAssistant.error) {
        const typePrefix = parsedAssistant.error.type ? `${parsedAssistant.error.type}: ` : "";
        return {
          taskId: request.taskId,
          executorSessionId: sessionId,
          state: "FAILED",
          error: `${typePrefix}${parsedAssistant.error.message}`,
          changedFiles: [],
          startedAt,
          finishedAt: Date.now(),
        };
      }

      if (parsedAssistant.finish === "error" || parsedAssistant.finish === "content-filter") {
        return {
          taskId: request.taskId,
          executorSessionId: sessionId,
          state: "FAILED",
          error:
            parsedAssistant.finish === "content-filter"
              ? "OpenCode assistant execution was blocked by content-filter"
              : "OpenCode assistant finished with error",
          changedFiles: [],
          startedAt,
          finishedAt: Date.now(),
        };
      }

      return {
        taskId: request.taskId,
        executorSessionId: sessionId,
        state: "COMPLETED",
        summary: parsedAssistant.text,
        changedFiles: [],
        startedAt,
        finishedAt: Date.now(),
      };
    } catch (err: any) {
      return {
        taskId: request.taskId,
        executorSessionId: sessionId,
        state: "FAILED",
        error: err instanceof Error ? err.message : String(err),
        changedFiles: [],
        startedAt,
        finishedAt: Date.now(),
      };
    }
  }

  async execute(request: ExecutionRequest, sessionId: string): Promise<ExecutionResult> {
    const startedAt = Date.now();
    try {
      const promptText = buildExecutionPrompt(request);
      await this.client.prompt(sessionId, { text: promptText });
      return await this.collectResult(request, sessionId, startedAt);
    } catch (err: any) {
      return {
        taskId: request.taskId,
        executorSessionId: sessionId,
        state: "FAILED",
        error: err instanceof Error ? err.message : String(err),
        changedFiles: [],
        startedAt,
        finishedAt: Date.now(),
      };
    }
  }

  async resume(request: ExecutionRequest, sessionId: string): Promise<ExecutionResult> {
    const startedAt = Date.now();
    return this.collectResult(request, sessionId, startedAt);
  }

  async cancel(taskId: string, sessionId: string): Promise<boolean> {
    if (!sessionId) return false;
    return this.client.interrupt(sessionId);
  }
}
