import {
  frameworkAttributes,
  namingAttributes,
  runtimeContextAttributes,
} from "#tracing/core/attributes.js";
import type { Attributes, FrameworkIdentity, SpanType } from "#tracing/core/types.js";

export const SPAN_NAMES = {
  action: "agent.action",
  approval: "agent.approval",
  channelRequest: "agent.channel.request",
  step: "agent.step",
} as const;

export const USAGE_FIELDS = {
  costUsd: "agent.usage.cost_usd",
  inputTokens: "agent.usage.input_tokens",
  outputTokens: "agent.usage.output_tokens",
  cacheReadTokens: "agent.usage.cache_read_tokens",
  cacheWriteTokens: "agent.usage.cache_write_tokens",
} as const;

export function invocationName(agentName?: string): string {
  return agentName === undefined ? "invoke_agent" : `invoke_agent ${agentName}`;
}

export function modelName(modelId: string): string {
  return `chat ${modelId}`;
}
export function toolName(name: string): string {
  return `execute_tool ${name}`;
}
export function mcpName(method: string, name?: string): string {
  return method === "tools/call" ? `tools/call ${name ?? "unknown"}` : method;
}

export interface ChannelMetadata {
  readonly kind?: string;
  readonly origin?: string;
}

export interface PrincipalMetadata {
  readonly id?: string;
  readonly type: string;
}

export function channelAttributes(channel: ChannelMetadata): Attributes {
  return { "agent.channel.kind": channel.kind, "agent.session.origin": channel.origin };
}

export function principalAttributes(input: {
  current?: PrincipalMetadata;
  initiator?: PrincipalMetadata;
}): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries({
    "agent.principal.current.id": input.current?.id,
    "agent.principal.current.type": input.current?.type,
    "agent.principal.initiator.id": input.initiator?.id,
    "agent.principal.initiator.type": input.initiator?.type,
  }))
    if (value !== undefined) result[key] = value;
  return result;
}

export function activationAttributes(input: {
  readonly identity: Attributes;
  readonly framework: FrameworkIdentity;
  readonly agentName?: string;
  readonly turnId: string;
  readonly sequence: number;
  readonly subagent: boolean;
  readonly subagentName?: string;
  readonly parentCallId?: string;
  readonly parentRunId?: string;
  readonly channel: ChannelMetadata;
  readonly audience?: string;
  readonly title?: string;
  readonly scheduleId?: string;
  readonly currentPrincipal?: PrincipalMetadata;
  readonly initiatorPrincipal?: PrincipalMetadata;
  readonly recordInputs: boolean;
  readonly recordOutputs: boolean;
  readonly delivery?: { id: string; input?: string; channelName: string; requestId?: string };
}): Attributes {
  return {
    ...input.identity,
    ...frameworkAttributes(input.framework),
    ...channelAttributes(input.channel),
    ...principalAttributes({
      current: input.currentPrincipal,
      initiator: input.initiatorPrincipal,
    }),
    ...namingAttributes(invocationName(input.agentName), "invoke_agent"),
    "agent.name": input.agentName,
    "gen_ai.agent.name": input.agentName,
    "gen_ai.operation.name": "invoke_agent",
    "agent.turn.id": input.turnId,
    "agent.turn.sequence": input.sequence,
    "agent.run.type": input.subagent ? "subagent" : "session",
    "agent.channel.audience": input.audience,
    "agent.channel.name": input.delivery?.channelName,
    "agent.channel.delivery.id": input.delivery?.id,
    "agent.channel.delivery.input": input.delivery?.input,
    "agent.channel.request.id": input.delivery?.requestId,
    "agent.parent_call.id": input.parentCallId,
    "agent.parent_run.id": input.parentRunId,
    "agent.subagent.name": input.subagentName,
    "agent.schedule.id": input.scheduleId,
    "agent.session.title": input.title,
    "agent.trace.content.input": input.recordInputs,
    "agent.trace.content.output": input.recordOutputs,
  };
}

export interface AttemptMetadata {
  readonly turnId: string;
  readonly index: number;
  readonly attempt: number;
}

export function attemptAttributes(input: AttemptMetadata): Attributes {
  return {
    "agent.turn.id": input.turnId,
    "agent.step.index": input.index,
    "agent.step.attempt": input.attempt,
  };
}

export function stepAttributes(input: {
  identity: Attributes;
  framework: FrameworkIdentity;
  attempt: AttemptMetadata;
  agentName?: string;
  channel?: ChannelMetadata;
  runtimeContext?: Readonly<Record<string, unknown>>;
}): Attributes {
  return {
    ...input.identity,
    ...frameworkAttributes(input.framework),
    ...attemptAttributes(input.attempt),
    ...namingAttributes(SPAN_NAMES.step),
    "agent.name": input.agentName,
    ...(input.channel?.kind === "unknown" ? undefined : channelAttributes(input.channel ?? {})),
    ...runtimeContextAttributes(input.runtimeContext),
  };
}

export function modelAttributes(input: {
  identity: Attributes;
  agentName?: string;
  provider: string;
  modelId: string;
  runtimeContext?: Readonly<Record<string, unknown>>;
}): Attributes {
  return {
    ...input.identity,
    ...namingAttributes(modelName(input.modelId), "chat"),
    "gen_ai.agent.name": input.agentName,
    "gen_ai.operation.name": "chat",
    "gen_ai.provider.name": input.provider,
    "gen_ai.request.model": input.modelId,
    ...runtimeContextAttributes(input.runtimeContext),
  };
}

export function modelSelectionAttributes(modelId: string, provider: string): Attributes {
  return { "agent.model.id": modelId, "agent.model.provider": provider };
}

export function actionAttributes(input: {
  identity: Attributes;
  framework: FrameworkIdentity;
  attempt: AttemptMetadata;
  callId: string;
  name: string;
  kind: string;
}): Attributes {
  const invocation = input.kind === "subagent-call" || input.kind === "remote-agent-call";
  return {
    ...input.identity,
    ...frameworkAttributes(input.framework),
    ...attemptAttributes(input.attempt),
    ...namingAttributes(SPAN_NAMES.action),
    "agent.action.call_id": input.callId,
    "agent.action.name": input.name,
    "agent.action.kind": input.kind,
    ...(invocation
      ? { "gen_ai.agent.name": input.name, "agent.invocation.role": "caller" }
      : undefined),
  };
}

export function toolAttributes(input: {
  identity: Attributes;
  agentName?: string;
  callId: string;
  name: string;
}): Attributes {
  return {
    ...input.identity,
    ...namingAttributes(toolName(input.name), "execute_tool"),
    "gen_ai.agent.name": input.agentName,
    "gen_ai.operation.name": "execute_tool",
    "gen_ai.tool.call.id": input.callId,
    "gen_ai.tool.name": input.name,
    "gen_ai.tool.type": "function",
  };
}

export function approvalAttributes(input: {
  identity: Attributes;
  framework: FrameworkIdentity;
  attempt: AttemptMetadata;
  callId: string;
  actionName: string;
  requestId: string;
  outcome?: string;
}): Attributes {
  return {
    ...input.identity,
    ...frameworkAttributes(input.framework),
    ...attemptAttributes(input.attempt),
    ...namingAttributes(SPAN_NAMES.approval),
    "agent.action.call_id": input.callId,
    "agent.action.name": input.actionName,
    "agent.approval.kind": "tool-approval",
    "agent.approval.request_id": input.requestId,
    "agent.approval.outcome": input.outcome,
  };
}

export function memoryAttributes(input: {
  identity: Attributes;
  operation: string;
  phase: string;
  slot: string;
  storeId: string;
  turnId?: string;
}): Attributes {
  return {
    ...input.identity,
    ...namingAttributes(input.operation),
    "gen_ai.operation.name": input.operation,
    "gen_ai.memory.store.id": input.storeId,
    "agent.memory.phase": input.phase,
    "agent.memory.slot": input.slot,
    "agent.turn.id": input.turnId,
  };
}

export function requestAttributes(input: {
  method: string;
  route: string;
  scheme?: string;
  serverAddress?: string;
  channelName?: string;
  channelKind?: string;
}): Attributes {
  return {
    ...namingAttributes(SPAN_NAMES.channelRequest),
    "http.request.method": input.method,
    "http.route": input.route,
    "url.scheme": input.scheme,
    "server.address": input.serverAddress,
    "agent.channel.name": input.channelName,
    "agent.channel.kind": input.channelKind,
  };
}

export function mcpAttributes(input: {
  connectionName: string;
  method: string;
  toolName?: string;
  protocolVersion?: string;
  requestId?: string;
}): Attributes {
  return {
    "agent.connection.name": input.connectionName,
    "mcp.method.name": input.method,
    "network.protocol.name": "http",
    "network.transport": "tcp",
    "mcp.protocol.version": input.protocolVersion,
    "jsonrpc.request.id": input.requestId,
    "gen_ai.operation.name": input.method === "tools/call" ? "execute_tool" : undefined,
    "gen_ai.tool.name": input.method === "tools/call" ? input.toolName : undefined,
  };
}

export const CONTENT_FIELDS = {
  toolArguments: "gen_ai.tool.call.arguments",
  toolResult: "gen_ai.tool.call.result",
  approvalRequest: "agent.approval.request",
  approvalResponse: "agent.approval.response",
  memoryRecords: "gen_ai.memory.records",
} as const;

export function terminalAttributes(type: SpanType, outcome: string): Attributes {
  return type === "activation"
    ? { "agent.turn.outcome": outcome }
    : type === "action"
      ? { "agent.action.outcome": outcome }
      : type === "approval"
        ? { "agent.approval.outcome": outcome }
        : {};
}

export function actionErrorAttributes(code: string): Attributes {
  return { "agent.action.error.code": code };
}
export function memoryCountAttributes(count: number): Attributes {
  return { "gen_ai.memory.record.count": count };
}
export function requestStatusAttributes(status: number): Attributes {
  return { "http.response.status_code": status };
}
export function mcpSessionAttributes(id: string): Attributes {
  return { "mcp.session.id": id };
}
export function rpcStatusAttributes(code: number | string): Attributes {
  return { "rpc.response.status_code": code };
}

export function applyAttributes(
  span: { setAttribute(key: string, value: Exclude<Attributes[string], undefined>): unknown },
  attributes: Attributes,
): void {
  for (const [key, value] of Object.entries(attributes))
    if (value !== undefined) span.setAttribute(key, value);
}

export function channelRequestMetadata(input: {
  channelName?: string;
  channelKind?: string;
}): Attributes {
  return { "agent.channel.name": input.channelName, "agent.channel.kind": input.channelKind };
}
