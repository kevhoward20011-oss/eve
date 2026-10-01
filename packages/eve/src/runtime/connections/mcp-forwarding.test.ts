import { describe, expect, it } from "vitest";

import type { SessionAuthContext } from "#channel/types.js";
import { contextStorage, ContextContainer } from "#context/container.js";
import { AuthKey, ConversationIdKey, InitiatorAuthKey, SessionIdKey } from "#context/keys.js";
import {
  encodeForwardedPrincipalHeader,
  MAX_FORWARDED_PRINCIPAL_HEADER_BYTES,
  readForwardedPrincipal,
  readToolSessionKey,
} from "#runtime/connections/mcp-forwarding.js";

function userAuth(id: string, attributes: Record<string, unknown> = {}): SessionAuthContext {
  return {
    attributes,
    authenticator: "jwt-hmac",
    issuer: "idp",
    principalId: id,
    principalType: "user",
  } as SessionAuthContext;
}

function withContext<T>(setup: (ctx: ContextContainer) => void, run: () => T): T {
  const ctx = new ContextContainer();
  setup(ctx);
  return contextStorage.run(ctx, run);
}

describe("encodeForwardedPrincipalHeader", () => {
  it("produces unpadded base64url JSON that round-trips", () => {
    // Characters chosen to produce `+`, `/` and padding in standard base64.
    const principal = { current: userAuth("u-1", { note: "ÿ?>>~~ é ✓" }) };
    for (let pad = 0; pad < 3; pad++) {
      const value = {
        ...principal,
        current: { ...principal.current, principalId: "x".repeat(pad) },
      };
      const encoded = encodeForwardedPrincipalHeader(value, "remote");
      expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/u);
      expect(JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"))).toEqual(value);
    }
  });

  it("accepts a header exactly at the limit and rejects one byte of JSON more", () => {
    // Unpadded base64url of 3n bytes is exactly 4n characters.
    const jsonBytes = (MAX_FORWARDED_PRINCIPAL_HEADER_BYTES / 4) * 3;
    const overhead = JSON.stringify({ current: userAuth("u-1", { blob: "" }) }).length;
    const sized = (extra: number) => ({
      current: userAuth("u-1", { blob: "a".repeat(jsonBytes - overhead + extra) }),
    });

    expect(encodeForwardedPrincipalHeader(sized(0), "remote")).toHaveLength(
      MAX_FORWARDED_PRINCIPAL_HEADER_BYTES,
    );
    expect(() => encodeForwardedPrincipalHeader(sized(1), "remote")).toThrow(
      /Connection "remote" cannot forward.*16384-byte limit/u,
    );
  });
});

describe("readForwardedPrincipal", () => {
  it("is undefined outside a context or without an authenticated caller", () => {
    expect(readForwardedPrincipal()).toBeUndefined();
    expect(withContext((ctx) => ctx.set(AuthKey, null), readForwardedPrincipal)).toBeUndefined();
  });

  it("reads current and initiator", () => {
    const current = userAuth("u-1");
    const initiator = userAuth("u-0");
    expect(withContext((ctx) => ctx.set(AuthKey, current), readForwardedPrincipal)).toEqual({
      current,
    });
    expect(
      withContext((ctx) => {
        ctx.set(AuthKey, current);
        ctx.set(InitiatorAuthKey, initiator);
      }, readForwardedPrincipal),
    ).toEqual({ current, initiator });
  });
});

describe("readToolSessionKey", () => {
  const forSession = (sessionId: string, connection = "remote") =>
    withContext(
      (ctx) => ctx.set(SessionIdKey, sessionId),
      () => readToolSessionKey(connection),
    );

  it("is undefined without a session", () => {
    expect(readToolSessionKey("remote")).toBeUndefined();
  });

  it("is stable per session, differs across sessions and connections, and is short", () => {
    const a = forSession("session-a");
    expect(a).toBeDefined();
    expect(forSession("session-a")).toBe(a);
    expect(forSession("session-b")).not.toBe(a);
    expect(forSession("session-a", "other")).not.toBe(a);
    expect(a!.length).toBeLessThanOrEqual(512);
    expect(a).not.toContain("session-a");
  });

  it("prefers the conversation id over the session id", () => {
    const byConversation = withContext(
      (ctx) => {
        ctx.set(SessionIdKey, "session-a");
        ctx.set(ConversationIdKey, "conv-1");
      },
      () => readToolSessionKey("remote"),
    );
    const otherSessionSameConversation = withContext(
      (ctx) => {
        ctx.set(SessionIdKey, "session-b");
        ctx.set(ConversationIdKey, "conv-1");
      },
      () => readToolSessionKey("remote"),
    );
    expect(byConversation).toBe(otherSessionSameConversation);
    expect(byConversation).not.toBe(forSession("session-a"));
  });
});
