import { describe, expect, it } from "vitest";

import type { SessionAuthContext } from "#channel/types.js";
import {
  createToolSessionOneOffNonce,
  deriveToolSessionId,
  validateToolSessionKey,
} from "#execution/tool-session/id.js";

function principal(id: string, extra: Partial<SessionAuthContext> = {}): SessionAuthContext {
  return {
    attributes: {},
    authenticator: "oauth",
    principalId: id,
    principalType: "user",
    ...extra,
  };
}

const key = { kind: "key", value: "conversation-1" } as const;

describe("deriveToolSessionId", () => {
  it("is stable for the same forwarder, caller, and key", () => {
    const a = deriveToolSessionId({ current: principal("alice"), key });
    expect(a).toMatch(/^ts_[0-9a-f]{64}$/);
    expect(deriveToolSessionId({ current: principal("alice"), key })).toBe(a);
  });

  it("ignores attributes, which are not identity", () => {
    expect(
      deriveToolSessionId({ current: principal("alice", { attributes: { plan: "pro" } }), key }),
    ).toBe(deriveToolSessionId({ current: principal("alice"), key }));
  });

  it("separates callers, issuers, forwarders, and keys", () => {
    const ids = [
      deriveToolSessionId({ current: principal("alice"), key }),
      deriveToolSessionId({ current: principal("bob"), key }),
      deriveToolSessionId({ current: principal("alice", { issuer: "https://other" }), key }),
      deriveToolSessionId({ current: principal("alice"), forwarder: principal("gw-1"), key }),
      deriveToolSessionId({ current: principal("alice"), forwarder: principal("gw-2"), key }),
      deriveToolSessionId({ current: principal("alice"), key: { kind: "key", value: "other" } }),
      deriveToolSessionId({ current: principal("alice"), key: { kind: "one-off", nonce: "n" } }),
    ];
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("cannot be confused by delimiters inside identity fields", () => {
    expect(deriveToolSessionId({ current: principal("a:b"), key })).not.toBe(
      deriveToolSessionId({ current: principal("a", { subject: "b" }), key }),
    );
  });
});

describe("tool session keys and nonces", () => {
  it("accepts 1 to 512 characters", () => {
    expect(validateToolSessionKey("")).toBeDefined();
    expect(validateToolSessionKey("k")).toBeUndefined();
    expect(validateToolSessionKey("k".repeat(512))).toBeUndefined();
    expect(validateToolSessionKey("k".repeat(513))).toBeDefined();
  });

  it("mints distinct random nonces", () => {
    expect(createToolSessionOneOffNonce()).toMatch(/^[0-9a-f]{32}$/);
    expect(createToolSessionOneOffNonce()).not.toBe(createToolSessionOneOffNonce());
  });
});
