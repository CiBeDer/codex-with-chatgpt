import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "node:http";
import {
  OpenCodeClient,
  OpenCodeExecutor,
  extractLatestAssistantText,
  type OpenCodeContextMessage,
} from "../src/executor/opencode.js";

describe("OpenCodeClient (Phase R1 Align with OpenCode v2 API)", () => {
  let server: http.Server;
  let port: number;
  let baseUrl: string;
  let handler: (req: http.IncomingMessage, res: http.ServerResponse) => void;

  beforeEach(async () => {
    server = http.createServer((req, res) => {
      handler(req, res);
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        if (typeof addr === "object" && addr) {
          port = addr.port;
          baseUrl = `http://127.0.0.1:${port}`;
        }
        resolve();
      });
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  it("health success calls GET /api/info or /api/health and returns true", async () => {
    handler = (req, res) => {
      expect(req.method).toBe("GET");
      expect(["/api/info", "/api/health"]).toContain(req.url);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, version: "2.0.0" }));
    };

    const client = new OpenCodeClient({ baseUrl });
    const healthy = await client.health();
    expect(healthy).toBe(true);
  });

  it("health failure returns false on non-200 or connection error", async () => {
    handler = (req, res) => {
      expect(["/api/info", "/api/health"]).toContain(req.url);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "server error" }));
    };

    const client = new OpenCodeClient({ baseUrl });
    const healthy = await client.health();
    expect(healthy).toBe(false);

    const unreachableClient = new OpenCodeClient({ baseUrl: "http://127.0.0.1:59999" });
    const unreachableHealth = await unreachableClient.health();
    expect(unreachableHealth).toBe(false);
  });

  it("create session success passes location.directory and model (id instead of modelID)", async () => {
    handler = async (req, res) => {
      expect(req.method).toBe("POST");
      expect(req.url).toBe("/api/session");
      let body = "";
      for await (const chunk of req) body += chunk;
      const parsed = JSON.parse(body);

      expect(parsed.title).toBeUndefined(); // No unconfirmed title
      expect(parsed.location).toEqual({ directory: "/test/workspace" });
      expect(parsed.agent).toBe("coder");
      expect(parsed.model).toEqual({
        providerID: "anthropic",
        id: "claude-3-5-sonnet",
        variant: "high",
      });
      expect(parsed.model.modelID).toBeUndefined();

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: { id: "ses_12345" } }));
    };

    const client = new OpenCodeClient({ baseUrl });
    const session = await client.createSession({
      directory: "/test/workspace",
      agent: "coder",
      model: {
        providerID: "anthropic",
        id: "claude-3-5-sonnet",
        variant: "high",
      },
    });
    expect(session.id).toBe("ses_12345");
  });

  it("create session 500 throws descriptive error without leaking auth password", async () => {
    handler = (req, res) => {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ message: "Failed to initialize session" }));
    };

    const client = new OpenCodeClient({
      baseUrl,
      username: "user",
      password: "SUPER_SECRET_PASSWORD_123",
    });

    await expect(client.createSession({ directory: "/test" })).rejects.toThrowError(
      /OpenCode API error: 500 POST \/api\/session/
    );

    try {
      await client.createSession({ directory: "/test" });
    } catch (err: any) {
      expect(err.message).not.toContain("SUPER_SECRET_PASSWORD_123");
    }
  });

  it("prompt sends { prompt: { text } } body and returns response", async () => {
    handler = async (req, res) => {
      expect(req.method).toBe("POST");
      expect(req.url).toBe("/api/session/ses_12345/prompt");
      let body = "";
      for await (const chunk of req) body += chunk;
      const parsed = JSON.parse(body);

      expect(parsed.text).toBeUndefined();
      expect(parsed.files).toBeUndefined();
      expect(parsed.prompt).toBeDefined();
      expect(parsed.prompt.text).toBe("Hello executor");

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    };

    const client = new OpenCodeClient({ baseUrl });
    const result = await client.prompt("ses_12345", { text: "Hello executor" });
    expect(result).toBeDefined();
  });

  it("request timeout throws timeout error", async () => {
    handler = (_req, _res) => {
      // Intentionally hang
    };

    const client = new OpenCodeClient({ baseUrl, requestTimeoutMs: 50 });
    await expect(client.prompt("ses_12345", { text: "Hello" })).rejects.toThrowError(
      /OpenCode API request timed out after 50ms/
    );
  });

  it("waitForIdle posts to /api/session/{id}/wait and handles 204 No Content with empty body", async () => {
    handler = (req, res) => {
      expect(req.method).toBe("POST");
      expect(req.url).toBe("/api/session/ses_12345/wait");
      res.writeHead(204);
      res.end();
    };

    const client = new OpenCodeClient({ baseUrl });
    await expect(client.waitForIdle("ses_12345")).resolves.toBeUndefined();
  });

  it("getContext gets context messages from /api/session/{id}/context", async () => {
    handler = (req, res) => {
      expect(req.method).toBe("GET");
      expect(req.url).toBe("/api/session/ses_12345/context");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          data: [
            { type: "user", content: [{ type: "text", text: "Do work" }] },
            {
              type: "assistant",
              time: { completed: 1000 },
              content: [
                { type: "reasoning", text: "Let me think..." },
                { type: "text", text: "Finished the task successfully." },
              ],
            },
          ],
        })
      );
    };

    const client = new OpenCodeClient({ baseUrl });
    const context = await client.getContext("ses_12345");
    expect(context.data).toHaveLength(2);
  });

  it("extractLatestAssistantText extracts only text from latest assistant completed message", () => {
    const messages: OpenCodeContextMessage[] = [
      {
        type: "assistant",
        time: { completed: 100 },
        content: [{ type: "text", text: "Old message" }],
      },
      {
        type: "user",
        content: [{ type: "text", text: "Followup" }],
      },
      {
        type: "assistant",
        time: { completed: 200 },
        content: [
          { type: "reasoning", text: "Secret reasoning that shouldn't appear" } as any,
          { type: "text", text: "Changed files: src/app.ts" },
          { type: "text", text: "All tests passing." },
        ],
      },
    ];

    const extracted = extractLatestAssistantText(messages);
    expect(extracted).toBe("Changed files: src/app.ts\nAll tests passing.");
    expect(extracted).not.toContain("Secret reasoning");
    expect(extracted).not.toContain("Old message");

    expect(extractLatestAssistantText([])).toBe("");
    expect(extractLatestAssistantText(null as any)).toBe("");
  });

  it("interrupt session sends POST /api/session/{id}/interrupt and handles 204", async () => {
    handler = (req, res) => {
      expect(req.method).toBe("POST");
      expect(req.url).toBe("/api/session/ses_12345/interrupt");
      res.writeHead(204);
      res.end();
    };

    const client = new OpenCodeClient({ baseUrl });
    const success = await client.interrupt("ses_12345");
    expect(success).toBe(true);
  });

  it("invalid JSON response throws error with snippet", async () => {
    handler = (_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html>Not JSON</html>");
    };

    const client = new OpenCodeClient({ baseUrl });
    await expect(client.createSession()).rejects.toThrowError(
      /Invalid JSON response from OpenCode API/
    );
  });

  describe("OpenCodeExecutor execution flow (Phase R8 API Contract)", () => {
    it("executes request with strict v2 call order: session -> prompt -> wait -> context", async () => {
      const callLog: string[] = [];

      handler = async (req, res) => {
        let body = "";
        for await (const chunk of req) body += chunk;
        const parsed = body ? JSON.parse(body) : {};

        if (req.method === "POST" && req.url === "/api/session") {
          callLog.push("1. POST /api/session");
          expect(parsed.location?.directory).toBe("/repo/workspace");
          expect(parsed.model?.id).toBe("test-model");
          expect(parsed.model?.providerID).toBe("test-provider");
          expect(parsed.model?.variant).toBe("high");
          expect(parsed.model?.modelID).toBeUndefined(); // Must NOT have modelID
          expect(parsed.title).toBeUndefined(); // Must NOT send title
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ data: { id: "ses_exec_123" } }));
          return;
        }

        if (req.method === "POST" && req.url === "/api/session/ses_exec_123/prompt") {
          callLog.push("2. POST /api/session/{id}/prompt");
          expect(parsed.text).toBeUndefined(); // Top-level text must NOT be present
          expect(parsed.files).toBeUndefined(); // Top-level files must NOT be present
          expect(parsed.prompt).toBeDefined();
          expect(parsed.prompt.text).toBeDefined();
          expect(parsed.prompt.text).toContain("WORKSPACE:\n/repo/workspace");
          expect(parsed.prompt.text).toContain("GOAL:\nFix calculation bug");
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
          return;
        }

        if (req.method === "POST" && req.url === "/api/session/ses_exec_123/wait") {
          callLog.push("3. POST /api/session/{id}/wait");
          res.writeHead(204); // 204 No Content
          res.end();
          return;
        }

        if (req.method === "GET" && req.url === "/api/session/ses_exec_123/context") {
          callLog.push("4. GET /api/session/{id}/context");
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              data: [
                {
                  type: "assistant",
                  time: { created: 1000, completed: 2000 },
                  content: [
                    { type: "reasoning", text: "private reasoning" },
                    { type: "text", text: "Implementation completed." },
                  ],
                },
              ],
            })
          );
          return;
        }

        res.writeHead(404).end();
      };

      const executor = new OpenCodeExecutor({
        baseUrl,
        providerId: "test-provider",
        modelId: "test-model",
        variant: "high",
      });

      const req = {
        taskId: "task_456",
        workspacePath: "/repo/workspace",
        goal: "Fix calculation bug",
        plan: "Modify add() function and run tests",
        tests: ["pnpm test"],
      };

      const sessionId = await executor.ensureSession(req);
      expect(sessionId).toBe("ses_exec_123");

      const res = await executor.execute(req, sessionId);

      // Verify strict call order
      expect(callLog).toEqual([
        "1. POST /api/session",
        "2. POST /api/session/{id}/prompt",
        "3. POST /api/session/{id}/wait",
        "4. GET /api/session/{id}/context",
      ]);

      expect(res.taskId).toBe("task_456");
      expect(res.executorSessionId).toBe("ses_exec_123");
      expect(res.state).toBe("COMPLETED");
      expect(res.summary).toBe("Implementation completed.");
      expect(res.summary).not.toContain("private reasoning");
      expect(res.changedFiles).toEqual([]);
      expect(res.finishedAt).toBeDefined();
    });

    it("returns FAILED state on execution error", async () => {
      handler = (req, res) => {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ message: "LLM rate limit reached" }));
      };

      const executor = new OpenCodeExecutor({ baseUrl });

      const res = await executor.execute(
        {
          taskId: "task_fail_1",
          workspacePath: "/repo/workspace",
          goal: "Fail test",
          plan: "Fail plan",
        },
        "ses_fail_1"
      );

      expect(res.taskId).toBe("task_fail_1");
      expect(res.executorSessionId).toBe("ses_fail_1");
      expect(res.state).toBe("FAILED");
      expect(res.error).toContain("LLM rate limit reached");
    });
  });
});
