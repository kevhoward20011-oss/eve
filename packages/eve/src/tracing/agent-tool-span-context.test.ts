import { ROOT_CONTEXT } from "#compiled/@opentelemetry/api/index.js";
import { describe, expect, it, vi } from "vitest";
import {
  agentToolContentPolicy,
  agentToolSpanContext,
  withAgentToolContentPolicy,
  withAgentToolSpanContext,
} from "#tracing/agent-tool-span-context.js";

describe("agent tool scope context", () => {
  it("narrows capture without dropping the semantic lifecycle", () => {
    const mcp = { update: vi.fn(), error: vi.fn(), arguments: vi.fn(), result: vi.fn() };
    const context = withAgentToolSpanContext(ROOT_CONTEXT, {
      mcp,
      recordInputs: true,
      recordOutputs: true,
    });
    const narrowed = withAgentToolContentPolicy(context, {
      recordInputs: false,
      recordOutputs: false,
    });
    expect(agentToolContentPolicy(narrowed)).toEqual({ recordInputs: false, recordOutputs: false });
    agentToolSpanContext(narrowed)?.mcp?.update({
      method: "tools/call",
      connectionName: "catalog",
    });
    agentToolSpanContext(narrowed)?.mcp?.arguments("secret");
    agentToolSpanContext(narrowed)?.mcp?.result("secret");
    agentToolSpanContext(narrowed)?.mcp?.error(new Error("secret"), "tool_error");
    expect(mcp.update).toHaveBeenCalledWith({ method: "tools/call", connectionName: "catalog" });
    expect(mcp.arguments).not.toHaveBeenCalled();
    expect(mcp.result).not.toHaveBeenCalled();
    expect(mcp.error).toHaveBeenCalledWith(undefined, "tool_error");
  });
});
