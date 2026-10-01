import { describe, expect, it, vi } from "vitest";

import type { SessionAuthContext } from "#channel/types.js";
import {
  decodeForwardedPrincipalHeader,
  encodeForwardedPrincipalHeader,
  MCP_FORWARDED_PRINCIPAL_HEADER,
  MCP_FORWARDED_PRINCIPAL_HEADER_MAX_BYTES,
  resolveMcpRequestPrincipals,
} from "#internal/mcp/forwarded-principal-header.js";

const forwarder: SessionAuthContext = {
  attributes: {},
  authenticator: "service",
  principalId: "router",
  principalType: "service",
};
const user: SessionAuthContext = {
  attributes: { team: "infra" },
  authenticator: "oidc",
  principalId: "user-7",
  principalType: "user",
};

function request(header?: string): Request {
  return new Request("https://agent.example/mcp", {
    headers: header === undefined ? {} : { [MCP_FORWARDED_PRINCIPAL_HEADER]: header },
    method: "POST",
  });
}

describe("eve-forwarded-principal header", () => {
  it("is ignored entirely without trustedForwarders, even when malformed", async () => {
    await expect(
      resolveMcpRequestPrincipals(request("%%%"), forwarder, undefined),
    ).resolves.toEqual({
      current: forwarder,
    });
  });

  it("leaves the route principal alone when no header is sent", async () => {
    const trusted = vi.fn(() => true);
    await expect(resolveMcpRequestPrincipals(request(), forwarder, trusted)).resolves.toEqual({
      current: forwarder,
    });
    expect(trusted).not.toHaveBeenCalled();
  });

  it("fails a malformed or oversized header with 400 before the predicate runs", async () => {
    const trusted = vi.fn(() => true);
    for (const header of [
      "not base64!",
      `${encodeForwardedPrincipalHeader({ current: user })}=`,
      Buffer.from("{not json").toString("base64url"),
      Buffer.from([0xff, 0xfe]).toString("base64url"),
      "a".repeat(MCP_FORWARDED_PRINCIPAL_HEADER_MAX_BYTES + 1),
      encodeForwardedPrincipalHeader({ current: { principalId: "x" } }),
      encodeForwardedPrincipalHeader(null),
    ]) {
      const response = await resolveMcpRequestPrincipals(request(header), forwarder, trusted);
      expect(response).toBeInstanceOf(Response);
      expect((response as Response).status).toBe(400);
    }
    expect(trusted).not.toHaveBeenCalled();
  });

  it("refuses with 403 when the predicate says no", async () => {
    const response = await resolveMcpRequestPrincipals(
      request(encodeForwardedPrincipalHeader({ current: user })),
      forwarder,
      () => false,
    );
    expect((response as Response).status).toBe(403);
  });

  it("refuses an anonymous route principal with 403: there is no forwarder", async () => {
    const trusted = vi.fn(() => true);
    const response = await resolveMcpRequestPrincipals(
      request(encodeForwardedPrincipalHeader({ current: user })),
      {
        attributes: {},
        authenticator: "none",
        principalId: "anonymous",
        principalType: "anonymous",
      },
      trusted,
    );
    expect((response as Response).status).toBe(403);
    expect(trusted).not.toHaveBeenCalled();
  });

  it("accepts a trusted forwarder and stamps eve:forwarded-by", async () => {
    const trusted = vi.fn(() => true);
    const resolved = await resolveMcpRequestPrincipals(
      request(encodeForwardedPrincipalHeader({ current: user })),
      forwarder,
      trusted,
    );
    const stamped = { ...user, attributes: { ...user.attributes, "eve:forwarded-by": "router" } };
    expect(resolved).toEqual({ current: stamped, forwarder, initiator: stamped });
    expect(trusted).toHaveBeenCalledWith(forwarder, {
      principal: { current: stamped, initiator: stamped },
    });
  });

  it("decodes unpadded base64url JSON", () => {
    expect(decodeForwardedPrincipalHeader(encodeForwardedPrincipalHeader({ a: "é" }))).toEqual({
      ok: true,
      value: { a: "é" },
    });
  });
});
