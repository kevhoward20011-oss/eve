/**
 * What an MCP connection forwards to an eve `mcpChannel`: the turn's
 * principals (`forwardPrincipal: true`) and a tool-session key.
 */

import { createHash } from "node:crypto";

import type { SessionAuthContext } from "#channel/types.js";
import type { ForwardedPrincipal } from "#channel/forwarded-principal.js";
import { contextStorage } from "#context/container.js";
import { AuthKey, ConversationIdKey, InitiatorAuthKey, SessionIdKey } from "#context/keys.js";

/** Request header carrying the forwarded principal; see `mcpChannel({ trustedForwarders })`. */
export const FORWARDED_PRINCIPAL_HEADER = "eve-forwarded-principal";
/** The channel rejects larger headers, so eve fails before sending one. */
export const MAX_FORWARDED_PRINCIPAL_HEADER_BYTES = 16 * 1024;

/** Vendor extension a client declares to scope tool calls to one session. */
export const TOOL_SESSIONS_EXTENSION = "dev.eve/tool-sessions";
/** `_meta` key that carries the tool-session key on `tools/call` and `resources/read`. */
export const TOOL_SESSION_META_KEY = "dev.eve/tool-session";

/**
 * The principals remote agents put in their `forwardedPrincipal` body field,
 * read from the active turn. `undefined` when the turn has no authenticated
 * caller: the request then proceeds on transport trust alone.
 */
export function readForwardedPrincipal(): ForwardedPrincipal | undefined {
  const ctx = contextStorage.getStore();
  const current = ctx?.get(AuthKey);
  if (current === null || current === undefined) return undefined;
  const initiator: SessionAuthContext | null | undefined = ctx?.get(InitiatorAuthKey);
  return initiator === null || initiator === undefined ? { current } : { current, initiator };
}

/** Unpadded base64url of the principal's UTF-8 JSON, at most 16 KiB. */
export function encodeForwardedPrincipalHeader(
  principal: ForwardedPrincipal,
  connectionName: string,
): string {
  const encoded = Buffer.from(JSON.stringify(principal), "utf8").toString("base64url");
  if (encoded.length > MAX_FORWARDED_PRINCIPAL_HEADER_BYTES) {
    throw new Error(
      `Connection "${connectionName}" cannot forward the caller's principal: the ` +
        `${FORWARDED_PRINCIPAL_HEADER} header would be ${encoded.length} bytes, over the ` +
        `${MAX_FORWARDED_PRINCIPAL_HEADER_BYTES}-byte limit. Trim the principal's attributes.`,
    );
  }
  return encoded;
}

/**
 * A stable key for the active conversation on this connection, so the
 * provider keeps one tool session per conversation. Hashed with the
 * connection name: the provider never sees eve's session or conversation id,
 * and two providers cannot correlate their keys.
 */
export function readToolSessionKey(connectionName: string): string | undefined {
  const ctx = contextStorage.getStore();
  const scope = ctx?.get(ConversationIdKey) ?? ctx?.get(SessionIdKey);
  if (scope === undefined) return undefined;
  return createHash("sha256")
    .update("eve.mcp.tool-session\0")
    .update(connectionName)
    .update("\0")
    .update(scope)
    .digest("base64url");
}
