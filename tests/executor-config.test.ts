import { describe, it, expect } from "vitest";
import {
  parsePositiveIntEnv,
  isValidLoopbackUrl,
  loadOpenCodeConfig,
} from "../src/executor/config.js";

describe("OpenCode config loader (Phase S5)", () => {
  it("parses positive integer envs with fallback", () => {
    expect(parsePositiveIntEnv(undefined, 100)).toBe(100);
    expect(parsePositiveIntEnv("", 100)).toBe(100);
    expect(parsePositiveIntEnv("   ", 100)).toBe(100);
    expect(parsePositiveIntEnv("abc", 100)).toBe(100);
    expect(parsePositiveIntEnv("-1", 100)).toBe(100);
    expect(parsePositiveIntEnv("0", 100)).toBe(100);
    expect(parsePositiveIntEnv("12.34", 100)).toBe(100);
    expect(parsePositiveIntEnv("500", 100)).toBe(500);
    expect(parsePositiveIntEnv(" 1234 ", 100)).toBe(1234);
  });

  it("validates loopback URLs correctly", () => {
    expect(isValidLoopbackUrl("http://127.0.0.1:4096")).toBe(true);
    expect(isValidLoopbackUrl("http://localhost:7110")).toBe(true);
    expect(isValidLoopbackUrl("http://[::1]:8080")).toBe(true);

    expect(isValidLoopbackUrl("http://google.com")).toBe(false);
    expect(isValidLoopbackUrl("http://192.168.1.100:4096")).toBe(false);
    expect(isValidLoopbackUrl("not-a-url")).toBe(false);
  });

  it("loads default loopback baseUrl when none provided", () => {
    const config = loadOpenCodeConfig({});
    expect(config.baseUrl).toBe("http://127.0.0.1:4096");
    expect(config.requestTimeoutMs).toBe(30_000);
    expect(config.executionTimeoutMs).toBe(300_000);
    expect(config.username).toBeUndefined();
    expect(config.password).toBeUndefined();
    expect(config.agent).toBeUndefined();
    expect(config.providerId).toBeUndefined();
    expect(config.modelId).toBeUndefined();
    expect(config.variant).toBeUndefined();
  });

  it("loads custom loopback port and agent/model options", () => {
    const config = loadOpenCodeConfig({
      C2C_OPENCODE_BASE_URL: "http://localhost:7110",
      C2C_OPENCODE_USERNAME: "opencode",
      C2C_OPENCODE_PASSWORD: "secret-token",
      C2C_OPENCODE_AGENT: "coder",
      C2C_OPENCODE_PROVIDER_ID: "myai",
      C2C_OPENCODE_MODEL_ID: "gemini-3.8-flash-high",
      C2C_OPENCODE_VARIANT: "high",
      C2C_OPENCODE_REQUEST_TIMEOUT_MS: "15000",
      C2C_OPENCODE_EXECUTION_TIMEOUT_MS: "600000",
    });

    expect(config.baseUrl).toBe("http://localhost:7110");
    expect(config.username).toBe("opencode");
    expect(config.password).toBe("secret-token");
    expect(config.agent).toBe("coder");
    expect(config.providerId).toBe("myai");
    expect(config.modelId).toBe("gemini-3.8-flash-high");
    expect(config.variant).toBe("high");
    expect(config.requestTimeoutMs).toBe(15_000);
    expect(config.executionTimeoutMs).toBe(600_000);
  });

  it("rejects public non-loopback base URL", () => {
    expect(() =>
      loadOpenCodeConfig({
        C2C_OPENCODE_BASE_URL: "https://api.opencode.ai",
      })
    ).toThrowError(/Invalid C2C_OPENCODE_BASE_URL/);
  });

  it("falls back to default timeouts when invalid or non-positive values given", () => {
    const config = loadOpenCodeConfig({
      C2C_OPENCODE_REQUEST_TIMEOUT_MS: "0",
      C2C_OPENCODE_EXECUTION_TIMEOUT_MS: "-500",
    });

    expect(config.requestTimeoutMs).toBe(30_000);
    expect(config.executionTimeoutMs).toBe(300_000);
  });
});
