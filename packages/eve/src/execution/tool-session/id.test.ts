import { describe, expect, it } from "vitest";

import type { SessionAuthContext } from "#channel/types.js";
import { deriveToolSessionId, validateToolSessionKey } from "#execution/tool-session/id.js";

const principal = (id: string, extra: Partial<SessionAuthContext> = {}): SessionAuthContext => ({
  attributes: {},
  authenticator: "oauth",
  principalId: id,
  principalType: "user",
  ...extra,
});
const key = { kind: "key", value: "conversation-1" } as const;
const base = deriveToolSessionId({ current: principal("alice"), key });

describe("deriveToolSessionId", () => {
  it.each([
    ["another caller", { current: principal("bob"), key }],
    ["another issuer", { current: principal("alice", { issuer: "https://other" }), key }],
    ["a forwarder", { current: principal("alice"), forwarder: principal("gw-1"), key }],
    ["another key", { current: principal("alice"), key: { kind: "key", value: "other" } }],
    ["a one-off nonce", { current: principal("alice"), key: { kind: "one-off", nonce: "n" } }],
  ] as const)("separates %s", (_label, input) => {
    expect(base).toMatch(/^ts_[0-9a-f]{64}$/);
    expect(deriveToolSessionId(input)).not.toBe(base);
  });

  it("ignores attributes and cannot be confused by delimiters inside identity fields", () => {
    const withAttributes = principal("alice", { attributes: { plan: "pro" } });
    expect(deriveToolSessionId({ current: withAttributes, key })).toBe(base);
    expect(deriveToolSessionId({ current: principal("a:b"), key })).not.toBe(
      deriveToolSessionId({ current: principal("a", { subject: "b" }), key }),
    );
  });
});

it("accepts tool session keys of 1 to 512 characters", () => {
  expect(
    ["", "k", "k".repeat(512), "k".repeat(513)].map((key) => validateToolSessionKey(key)),
  ).toEqual([expect.any(String), undefined, undefined, expect.any(String)]);
});
