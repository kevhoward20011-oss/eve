import { afterEach, describe, expect, it, vi } from "vitest";

import {
  canonicalJson,
  createMcpRequestStateCodec,
  hashToolArguments,
  MCP_REQUEST_STATE_SECRET_ENV,
  MCP_REQUEST_STATE_TTL_SECONDS,
  resolveMcpRequestStateSecret,
  type McpRequestStatePayload,
} from "#internal/mcp/request-state.js";

const SECRET = "s".repeat(32);
const ctx = {} as never;

const payload: McpRequestStatePayload = {
  args: hashToolArguments({ a: 1 }),
  callId: "call_1",
  kind: "approval",
  nonce: "n".repeat(32),
  sid: "ts_abc",
  tool: "deploy",
  v: 1,
};

afterEach(() => {
  vi.useRealTimers();
});

describe("MCP requestState codec", () => {
  it("round-trips a payload, and a second codec with only the same secret verifies it", async () => {
    const state = await createMcpRequestStateCodec(SECRET).mint(payload);
    expect(state.startsWith("v1.")).toBe(true);

    await expect(createMcpRequestStateCodec(SECRET).verify(state, ctx)).resolves.toEqual(payload);
  });

  it("rejects a state signed with another secret", async () => {
    const state = await createMcpRequestStateCodec(SECRET).mint(payload);
    await expect(createMcpRequestStateCodec("t".repeat(32)).verify(state, ctx)).rejects.toThrow(
      "mac",
    );
  });

  it("rejects an edited body", async () => {
    const state = await createMcpRequestStateCodec(SECRET).mint(payload);
    const [prefix, body, mac] = state.split(".");
    const decoded = JSON.parse(Buffer.from(body!, "base64url").toString("utf8")) as {
      p: McpRequestStatePayload;
    };
    const edited = Buffer.from(
      JSON.stringify({ ...decoded, p: { ...decoded.p, tool: "other" } }),
    ).toString("base64url");

    await expect(
      createMcpRequestStateCodec(SECRET).verify(`${prefix}.${edited}.${mac}`, ctx),
    ).rejects.toThrow("mac");
  });

  it("rejects an unsigned state", async () => {
    const unsigned = Buffer.from(JSON.stringify({ exp: 9e9, p: payload })).toString("base64url");
    const codec = createMcpRequestStateCodec(SECRET);

    await expect(codec.verify(JSON.stringify(payload), ctx)).rejects.toThrow("malformed");
    await expect(codec.verify(`v1.${unsigned}.`, ctx)).rejects.toThrow();
    await expect(codec.verify(`v1.${unsigned}`, ctx)).rejects.toThrow();
  });

  it("rejects an expired state", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-01T00:00:00Z"));
    const codec = createMcpRequestStateCodec(SECRET);
    const state = await codec.mint(payload);

    vi.setSystemTime(new Date(Date.now() + (MCP_REQUEST_STATE_TTL_SECONDS - 1) * 1000));
    await expect(codec.verify(state, ctx)).resolves.toEqual(payload);
    vi.setSystemTime(new Date(Date.now() + 2000));
    await expect(codec.verify(state, ctx)).rejects.toThrow("expired");
  });

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

describe("hashToolArguments", () => {
  it("hashes canonical JSON, so key order does not matter", () => {
    expect(canonicalJson({ b: [{ d: 1, c: 2 }], a: null })).toBe('{"a":null,"b":[{"c":2,"d":1}]}');
    expect(hashToolArguments({ a: 1, b: { c: 2, d: 3 } })).toBe(
      hashToolArguments({ b: { d: 3, c: 2 }, a: 1 }),
    );
    expect(hashToolArguments({ a: 1 })).not.toBe(hashToolArguments({ a: 2 }));
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
