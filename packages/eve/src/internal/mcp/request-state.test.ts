import { describe, expect, it } from "vitest";

import {
  createMcpRequestStateCodec,
  MCP_REQUEST_STATE_SECRET_ENV,
  resolveMcpRequestStateSecret,
  type McpRequestStatePayload,
} from "#internal/mcp/request-state.js";

const SECRET = "s".repeat(32);
const ctx = {} as never;

const payload: McpRequestStatePayload = {
  args: "a".repeat(64),
  callId: "call_1",
  kind: "approval",
  nonce: "n".repeat(32),
  sid: "ts_abc",
  tool: "deploy",
  v: 1,
};

// MAC, expiry, and argument binding are owned by the forged-state table in
// mcpChannel's route tests; this owns only the eve payload shape.
describe("MCP requestState codec", () => {
  it("rejects a signed payload that is not eve's shape", async () => {
    const codec = createMcpRequestStateCodec(SECRET);
    for (const bad of [
      { ...payload, v: 2 },
      { ...payload, kind: "other" },
      { ...payload, sid: "" },
      { ...payload, nonce: 1 },
      { ...payload, approval: { approved: "yes" } },
      "a string",
    ]) {
      const state = await codec.mint(bad as never);
      await expect(codec.verify(state, ctx)).rejects.toThrow("malformed");
    }
  });
});

describe("resolveMcpRequestStateSecret", () => {
  it("prefers the option and throws when it is too short", () => {
    expect(resolveMcpRequestStateSecret(SECRET, {})).toEqual({ key: SECRET, kind: "configured" });
    expect(() => resolveMcpRequestStateSecret("short", {})).toThrow("at least 32 bytes");
  });

  it("reads the environment and reports a short value as missing", () => {
    expect(
      resolveMcpRequestStateSecret(undefined, { [MCP_REQUEST_STATE_SECRET_ENV]: SECRET }),
    ).toEqual({ key: SECRET, kind: "configured" });
    const short = resolveMcpRequestStateSecret(undefined, {
      [MCP_REQUEST_STATE_SECRET_ENV]: "short",
    });
    expect(short.kind).toBe("missing");
    expect(short.kind === "missing" && short.reason).toContain(MCP_REQUEST_STATE_SECRET_ENV);
  });

  it("falls back to one per-process random key in development only", () => {
    const first = resolveMcpRequestStateSecret(undefined, { EVE_DEV: "1" });
    const second = resolveMcpRequestStateSecret(undefined, { NODE_ENV: "development" });
    expect(first.kind).toBe("development");
    expect(second).toEqual(first);

    const production = resolveMcpRequestStateSecret(undefined, { NODE_ENV: "production" });
    expect(production.kind).toBe("missing");
    expect(production.kind === "missing" && production.reason).toContain(
      MCP_REQUEST_STATE_SECRET_ENV,
    );
  });
});
