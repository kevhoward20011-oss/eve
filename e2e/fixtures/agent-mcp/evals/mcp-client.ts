import type { EveEvalTargetHandle } from "eve/evals";

import { MCP_PATH, USER_HEADER } from "../fixture";

const MCP_PROTOCOL_VERSION = "2026-07-28";

/** Params the `Mcp-Name` header must mirror, per method. */
const NAME_FIELDS: Readonly<Record<string, string>> = {
  "resources/read": "uri",
  "tools/call": "name",
};

export type Json = Record<string, any>;

/** As the named user, sends one JSON-RPC request to this deployment's MCP channel. */
export async function mcpRequest(
  target: EveEvalTargetHandle,
  user: string,
  method: string,
  params: Json,
  meta: Json = {},
): Promise<{ readonly error?: Json; readonly result?: Json }> {
  const headers: Record<string, string> = {
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
    "mcp-method": method,
    "mcp-protocol-version": MCP_PROTOCOL_VERSION,
    [USER_HEADER]: user,
  };
  const nameField = NAME_FIELDS[method];
  if (nameField !== undefined) headers["mcp-name"] = String(params[nameField]);
  const response = await target.fetch(MCP_PATH, {
    body: JSON.stringify({
      id: crypto.randomUUID(),
      jsonrpc: "2.0",
      method,
      params: {
        ...params,
        _meta: {
          ...meta,
          "io.modelcontextprotocol/clientCapabilities": {
            elicitation: { form: {} },
            extensions: { "dev.eve/tool-sessions": {} },
          },
          "io.modelcontextprotocol/clientInfo": { name: "agent-mcp-e2e", version: "0.0.0" },
          "io.modelcontextprotocol/protocolVersion": MCP_PROTOCOL_VERSION,
        },
      },
    }),
    headers,
    method: "POST",
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`MCP ${method} HTTP ${String(response.status)}: ${body}`);
  if (!response.headers.get("content-type")?.includes("text/event-stream")) {
    return JSON.parse(body) as Json;
  }
  const data = body.split("\n").find((line) => line.startsWith("data: "));
  if (data === undefined) throw new Error(`MCP ${method} returned no server-sent event.`);
  return JSON.parse(data.slice("data: ".length)) as Json;
}

/** Skips evals whose agent turns depend on the scripted mock model. */
export function requireMockModel(t: { skip(reason: string): never }): void {
  if (process.env.EVE_E2E_MODEL !== "mock") {
    t.skip("Requires the deterministic mock model to make the exact loopback calls.");
  }
}
