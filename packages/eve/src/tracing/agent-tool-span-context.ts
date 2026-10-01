import {
  context as otelContext,
  createContextKey,
  type Context,
} from "#compiled/@opentelemetry/api/index.js";
import type { McpLifecycle } from "#tracing/core/mcp.js";

interface AgentToolContentPolicy {
  readonly recordInputs: boolean;
  readonly recordOutputs: boolean;
}

interface AgentToolSpanContext extends AgentToolContentPolicy {
  readonly mcp?: McpLifecycle;
}

const AGENT_TOOL_SPAN_CONTEXT_KEY = createContextKey("eve.agent.tool-span-context");
const NO_CONTENT_POLICY: AgentToolContentPolicy = { recordInputs: false, recordOutputs: false };

export function withAgentToolSpanContext(context: Context, value: AgentToolSpanContext): Context {
  return context.setValue(AGENT_TOOL_SPAN_CONTEXT_KEY, value);
}

export function withAgentToolContentPolicy(
  context: Context,
  policy: AgentToolContentPolicy,
): Context {
  const current = agentToolSpanContext(context);
  const mcp = current?.mcp;
  return context.setValue(AGENT_TOOL_SPAN_CONTEXT_KEY, {
    ...current,
    ...policy,
    mcp:
      mcp === undefined
        ? undefined
        : {
            update: mcp.update,
            error(error, type) {
              mcp.error(
                policy.recordOutputs ? error : undefined,
                type ?? (error instanceof Error ? error.name : undefined),
              );
            },
            arguments(value) {
              if (policy.recordInputs) mcp.arguments(value);
            },
            result(value) {
              if (policy.recordOutputs) mcp.result(value);
            },
          },
  } satisfies AgentToolSpanContext);
}

export function agentToolSpanContext(
  context: Context = otelContext.active(),
): AgentToolSpanContext | undefined {
  return context.getValue(AGENT_TOOL_SPAN_CONTEXT_KEY) as AgentToolSpanContext | undefined;
}

export function agentToolContentPolicy(
  context: Context = otelContext.active(),
): AgentToolContentPolicy {
  const spanContext = agentToolSpanContext(context);
  return spanContext === undefined
    ? NO_CONTENT_POLICY
    : {
        recordInputs: spanContext.recordInputs,
        recordOutputs: spanContext.recordOutputs,
      };
}
