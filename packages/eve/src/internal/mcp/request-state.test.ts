import { describe, expect, it } from "vitest";

import {
  MCP_REQUEST_STATE_SECRET_ENV as ENV,
  resolveMcpRequestStateSecret as resolve,
} from "#internal/mcp/request-state.js";

const SECRET = "s".repeat(32);

describe("resolveMcpRequestStateSecret", () => {
  it("prefers the option, then the env, and falls back to a random key in development only", () => {
    expect(resolve(SECRET, {})).toEqual({ key: SECRET, kind: "configured" });
    expect(() => resolve("short", {})).toThrow("at least 32 bytes");
    expect(resolve(undefined, { [ENV]: SECRET })).toEqual({ key: SECRET, kind: "configured" });
    for (const env of [{ [ENV]: "short" }, { NODE_ENV: "production" }]) {
      expect(resolve(undefined, env)).toMatchObject({
        kind: "missing",
        reason: expect.stringContaining(ENV),
      });
    }
    const dev = resolve(undefined, { EVE_DEV: "1" });
    expect(dev.kind).toBe("development");
    expect(resolve(undefined, { NODE_ENV: "development" })).toEqual(dev);
  });
});
