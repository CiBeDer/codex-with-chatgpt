import type { OpenCodeConfig } from "./opencode.js";

const DEFAULT_BASE_URL = "http://127.0.0.1:4096";

export function parsePositiveIntEnv(
  value: string | undefined,
  fallback: number
): number {
  if (value === undefined || value === null || value.trim() === "") {
    return fallback;
  }
  const parsed = Number(value.trim());
  if (isNaN(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

export function isValidLoopbackUrl(urlStr: string): boolean {
  try {
    const parsed = new URL(urlStr);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return false;
    }
    const host = parsed.hostname.toLowerCase();
    return (
      host === "127.0.0.1" ||
      host === "localhost" ||
      host === "::1" ||
      host === "[::1]"
    );
  } catch {
    return false;
  }
}

export function loadOpenCodeConfig(
  env: NodeJS.ProcessEnv = process.env
): OpenCodeConfig {
  let baseUrl = env.C2C_OPENCODE_BASE_URL?.trim();
  if (!baseUrl) {
    baseUrl = DEFAULT_BASE_URL;
  } else {
    if (!isValidLoopbackUrl(baseUrl)) {
      throw new Error(
        `Invalid C2C_OPENCODE_BASE_URL: "${baseUrl}". Only loopback addresses (127.0.0.1, localhost, ::1) are allowed.`
      );
    }
  }

  const password = env.C2C_OPENCODE_PASSWORD || undefined;
  const username =
    env.C2C_OPENCODE_USERNAME?.trim() || (password ? "opencode" : undefined);
  const agent = env.C2C_OPENCODE_AGENT?.trim() || undefined;
  const providerId = env.C2C_OPENCODE_PROVIDER_ID?.trim() || undefined;
  const modelId = env.C2C_OPENCODE_MODEL_ID?.trim() || undefined;
  const variant = env.C2C_OPENCODE_VARIANT?.trim() || undefined;

  const requestTimeoutMs = parsePositiveIntEnv(
    env.C2C_OPENCODE_REQUEST_TIMEOUT_MS,
    30_000
  );
  const executionTimeoutMs = parsePositiveIntEnv(
    env.C2C_OPENCODE_EXECUTION_TIMEOUT_MS,
    3_600_000
  );

  return {
    baseUrl,
    username,
    password,
    agent,
    providerId,
    modelId,
    variant,
    requestTimeoutMs,
    executionTimeoutMs,
  };
}
