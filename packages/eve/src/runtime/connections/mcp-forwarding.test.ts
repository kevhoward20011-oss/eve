import { describe, expect, it } from "vitest";

import type { SessionAuthContext } from "#channel/types.js";
import {
  encodeForwardedPrincipalHeader,
  MAX_FORWARDED_PRINCIPAL_HEADER_BYTES,
} from "#runtime/connections/mcp-forwarding.js";

function principal(principalId: string, blob: string) {
  const current: SessionAuthContext = {
    attributes: { blob },
    authenticator: "jwt-hmac",
    issuer: "idp",
    principalId,
    principalType: "user",
  };
  return { current };
}

// Unpadded base64url of 3n bytes is exactly 4n characters.
const atLimit =
  (MAX_FORWARDED_PRINCIPAL_HEADER_BYTES / 4) * 3 - JSON.stringify(principal("u-1", "")).length;

describe("encodeForwardedPrincipalHeader", () => {
  // The note's characters produce `+`, `/`, and padding in standard base64;
  // the id lengths walk all three padding remainders.
  it.each<[string, ReturnType<typeof principal>, "fits" | "at-limit" | "too-large"]>([
    ["no padding", principal("", "ÿ?>>~~ é ✓"), "fits"],
    ["one padding byte", principal("x", "ÿ?>>~~ é ✓"), "fits"],
    ["two padding bytes", principal("xx", "ÿ?>>~~ é ✓"), "fits"],
    ["exactly the size limit", principal("u-1", "a".repeat(atLimit)), "at-limit"],
    ["one byte over the size limit", principal("u-1", "a".repeat(atLimit + 1)), "too-large"],
  ])("encodes a principal with %s", (_label, value, size) => {
    if (size === "too-large") {
      expect(() => encodeForwardedPrincipalHeader(value, "remote")).toThrow(
        /Connection "remote" cannot forward.*16384-byte limit/u,
      );
      return;
    }
    const encoded = encodeForwardedPrincipalHeader(value, "remote");
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/u);
    if (size === "at-limit") expect(encoded).toHaveLength(MAX_FORWARDED_PRINCIPAL_HEADER_BYTES);
    expect(JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"))).toEqual(value);
  });
});
