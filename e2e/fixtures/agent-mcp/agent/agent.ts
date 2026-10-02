import { e2eAgentConfig } from "@eve-e2e/config";
import { defineAgent } from "eve";
import type { MockModelRequest, MockModelResponse, MockModelToolCall } from "eve/evals";

import { LOOPBACK_CONNECTION } from "../fixture";

const PUBLISH_DIRECTIVE = /MCP_PUBLISH "([^"]+)"/u;
const PENDING_REMOTE_INPUT = "Waiting for the user to answer";

/** One scripted call per directive, with a stable id so later steps find its result. */
function directiveCall(message: string): MockModelToolCall | undefined {
  if (message.includes("MCP_WHOAMI")) {
    return {
      id: "mcp-whoami",
      input: { connection: LOOPBACK_CONNECTION, input: {}, tool: "whoami" },
      name: "connection_execute",
    };
  }
  const notice = PUBLISH_DIRECTIVE.exec(message)?.[1];
  if (notice !== undefined) {
    return {
      id: "mcp-publish",
      input: { connection: LOOPBACK_CONNECTION, input: { notice }, tool: "publish_notice" },
      name: "connection_execute",
    };
  }
  return undefined;
}

/**
 * Scripted mock for the world suites: each eval prompt carries one directive,
 * so the model makes exactly that call and then reports how it ended. A step
 * that runs while the call is parked on someone's answer (after a refused
 * response, say) must not call again, so it only says it is waiting.
 */
function respond(request: MockModelRequest): MockModelResponse | string {
  const message = request.lastUserMessage ?? "";
  const call = directiveCall(message);
  if (call === undefined) return `Mock reply: ${message}`;

  const result = request.toolResults.find((entry) => entry.id === call.id);
  if (result !== undefined && !JSON.stringify(result.output).includes(PENDING_REMOTE_INPUT)) {
    return `${call.id}: ${result.isError ? "failed" : "done"}`;
  }
  const roles = request.messages.map((entry) =>
    entry.role === "user" && entry.text === message ? "directive" : entry.role,
  );
  const alreadyCalled = roles.lastIndexOf("assistant") > roles.lastIndexOf("directive");
  return alreadyCalled ? `${call.id}: waiting` : { toolCalls: [call] };
}

export default defineAgent({
  ...e2eAgentConfig({ mock: respond }),
});
