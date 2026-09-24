import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import http from "node:http";
import { OpenCodeClient } from "../src/executor/opencode.js";

describe("OpenCodeClient (Phase 3 HTTP Client)", () => {
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

  it("health success returns true", async () => {
    handler = (req, res) => {
      expect(req.method).toBe("GET");
      expect(req.url).toBe("/api/info");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, version: "2.0.0" }));
    };

    const client = new OpenCodeClient({ baseUrl });
    const healthy = await client.health();
    expect(healthy).toBe(true);
  });

  it("health failure returns false on non-200 or connection error", async () => {
    handler = (req, res) => {
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

  it("create session success returns sessionId", async () => {
    handler = async (req, res) => {
      expect(req.method).toBe("POST");
      expect(req.url).toBe("/api/session");
      let body = "";
      for await (const chunk of req) body += chunk;
      const parsed = JSON.parse(body);
      expect(parsed.title).toBe("Test Session");

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: { id: "ses_12345", title: "Test Session" } }));
    };

    const client = new OpenCodeClient({ baseUrl });
    const session = await client.createSession({ title: "Test Session" });
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

    await expect(client.createSession({ title: "Test Session" })).rejects.toThrowError(
      /OpenCode API error: 500 POST \/api\/session/
    );

    try {
      await client.createSession({ title: "Test Session" });
    } catch (err: any) {
      expect(err.message).not.toContain("SUPER_SECRET_PASSWORD_123");
    }
  });

  it("prompt success sends text and returns response data", async () => {
    handler = async (req, res) => {
      expect(req.method).toBe("POST");
      expect(req.url).toBe("/api/session/ses_12345/prompt");
      let body = "";
      for await (const chunk of req) body += chunk;
      const parsed = JSON.parse(body);
      expect(parsed.text).toBe("Hello executor");

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: { text: "Task completed successfully" } }));
    };

    const client = new OpenCodeClient({ baseUrl });
    const result = await client.prompt("ses_12345", { text: "Hello executor" });
    expect(result).toBeDefined();
    expect(result.data.text).toBe("Task completed successfully");
  });

  it("prompt timeout throws timeout error", async () => {
    handler = (_req, _res) => {
      // Intentionally do not respond
    };

    const client = new OpenCodeClient({ baseUrl, timeoutMs: 50 });
    await expect(client.prompt("ses_12345", { text: "Hello" })).rejects.toThrowError(
      /OpenCode API request timed out after 50ms/
    );
  });

  it("interrupt session success", async () => {
    handler = (req, res) => {
      expect(req.method).toBe("POST");
      expect(req.url).toBe("/api/session/ses_12345/interrupt");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
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

  describe("OpenCodeExecutor execution flow (Phase 4)", () => {
    it("executes request successfully formatting prompt and parsing result", async () => {
      let receivedSessionPayload: any;
      let receivedPromptPayload: any;

      handler = async (req, res) => {
        let body = "";
        for await (const chunk of req) body += chunk;
        const parsed = body ? JSON.parse(body) : {};

        if (req.method === "POST" && req.url === "/api/session") {
          receivedSessionPayload = parsed;
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ data: { id: "ses_exec_123" } }));
          return;
        }

        if (req.method === "POST" && req.url === "/api/session/ses_exec_123/prompt") {
          receivedPromptPayload = parsed;
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              data: {
                text: "Changed files: src/a.ts\nTests: 5 passed\nExecution completed.",
              },
            })
          );
          return;
        }

        res.writeHead(404).end();
      };

      const executor = new (await import("../src/executor/opencode.js")).OpenCodeExecutor({
        baseUrl,
      });

      const res = await executor.execute({
        taskId: "task_456",
        workspacePath: "/repo/workspace",
        goal: "Fix calculation bug",
        plan: "Modify add() function and run tests",
        tests: ["pnpm test"],
      });

      expect(receivedSessionPayload.location?.directory).toBe("/repo/workspace");
      expect(receivedSessionPayload.title).toBe("Task task_456");

      expect(receivedPromptPayload.text).toContain("WORKSPACE:\n/repo/workspace");
      expect(receivedPromptPayload.text).toContain("GOAL:\nFix calculation bug");
      expect(receivedPromptPayload.text).toContain("IMPLEMENTATION PLAN:\nModify add() function and run tests");
      expect(receivedPromptPayload.text).toContain("REQUESTED TESTS:\npnpm test");
      expect(receivedPromptPayload.text).not.toContain("password");

      expect(res.taskId).toBe("task_456");
      expect(res.state).toBe("COMPLETED");
      expect(res.changedFiles).toEqual(["src/a.ts"]);
      expect(res.finishedAt).toBeDefined();
    });

    it("returns FAILED state on execution error", async () => {
      handler = (req, res) => {
        if (req.method === "POST" && req.url === "/api/session") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ data: { id: "ses_exec_fail" } }));
          return;
        }
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ message: "LLM rate limit reached" }));
      };

      const executor = new (await import("../src/executor/opencode.js")).OpenCodeExecutor({
        baseUrl,
      });

      const res = await executor.execute({
        taskId: "task_fail_1",
        workspacePath: "/repo/workspace",
        goal: "Fail test",
        plan: "Fail plan",
      });

      expect(res.taskId).toBe("task_fail_1");
      expect(res.state).toBe("FAILED");
      expect(res.error).toContain("LLM rate limit reached");
    });
  });
});
