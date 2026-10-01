import type { AgentSessionTraceState, AgentTurnTraceState } from "#tracing/agent-trace-state.js";
import type { InstrumentationStepAttemptStartedEvent } from "#instrumentation/lifecycle.js";
import { agentTraceIdentityAttributes, traceSessionIdOf } from "#tracing/agent-otel-attributes.js";
import { normalizeInstrumentationChannelKind } from "#internal/instrumentation.js";
import { runtimeContextAttributes as traceRuntimeContextAttributes } from "#tracing/core/attributes.js";
import {
  activationAttributes,
  stepAttributes,
  channelAttributes,
  principalAttributes,
} from "#tracing/core/contract.js";

type SpanAttributePrimitive = string | number | boolean;
type SpanAttributeValue = SpanAttributePrimitive | SpanAttributePrimitive[];

export function agentActivationAttributes(input: {
  readonly agentName?: string;
  readonly frameworkVersion: string;
  readonly session?: AgentSessionTraceState;
  readonly sessionId: string;
  readonly turnId: string;
  readonly turn: AgentTurnTraceState;
}): Record<string, string | number | boolean | undefined> {
  const recordsTrace = input.session?.decision?.action === "record";
  const recordsInputs = recordsTrace && input.session?.decision?.recordInputs === true;
  const recordsOutputs = recordsTrace && input.session?.decision?.recordOutputs === true;
  const parentLineage = input.turn.parentLineage ?? input.session?.parentLineage;
  const isSubagent = parentLineage !== undefined;
  const ownsSessionMetadata = !isSubagent || input.turn.traceSessionId === input.sessionId;
  const channelClassification = agentChannelMetadata(input.session, input.turn, input.sessionId);
  const scheduleId = isSubagent ? undefined : input.session?.scheduleId;
  return activationAttributes({
    framework: { name: "eve", version: input.frameworkVersion },
    agentName: input.agentName,
    channel: channelClassification,
    audience: input.session?.channelAudience,
    currentPrincipal: input.turn.currentPrincipal,
    initiatorPrincipal: input.turn.initiatorPrincipal,
    delivery:
      input.turn.channelDelivery === undefined
        ? undefined
        : {
            id: input.turn.channelDelivery.deliveryId,
            input: input.turn.channelDelivery.inputAttribute,
            channelName: input.turn.channelDelivery.channelName,
            requestId: input.turn.channelDelivery.requestId,
          },
    parentCallId: parentLineage?.callId,
    parentRunId: parentLineage?.sessionId,
    subagent: isSubagent,
    scheduleId,
    title: ownsSessionMetadata && recordsInputs ? input.session?.title : undefined,
    subagentName: input.turn.subagentName,
    recordInputs: recordsInputs,
    recordOutputs: recordsOutputs,
    turnId: input.turnId,
    sequence: input.turn.sequence,
    identity: agentTraceIdentityAttributes({
      rootSessionId: input.turn.rootSessionId,
      traceSessionId: input.turn.traceSessionId,
      sessionId: input.sessionId,
    }),
  }) as Record<string, string | number | boolean | undefined>;
}

export function agentActivationMetadata(input: {
  readonly session?: AgentSessionTraceState;
  readonly turn: AgentTurnTraceState;
  readonly sessionId: string;
}): import("#tracing/core/scopes.js").TurnMetadata {
  const { session, turn, sessionId } = input;
  const lineage = turn.parentLineage ?? session?.parentLineage;
  const owns = lineage === undefined || turn.traceSessionId === sessionId;
  const delivery = turn.channelDelivery;
  return {
    sequence: turn.sequence,
    subagent: lineage !== undefined,
    subagentName: turn.subagentName,
    parentCallId: lineage?.callId,
    parentRunId: lineage?.sessionId,
    channel: agentChannelMetadata(session, turn, sessionId),
    audience: session?.channelAudience,
    title:
      owns && session?.decision?.action === "record" && session.decision.recordInputs
        ? session.title
        : undefined,
    scheduleId: lineage === undefined ? session?.scheduleId : undefined,
    currentPrincipal: turn.currentPrincipal,
    initiatorPrincipal: turn.initiatorPrincipal,
    delivery:
      delivery === undefined
        ? undefined
        : {
            id: delivery.deliveryId,
            channelName: delivery.channelName,
            requestId: delivery.requestId,
            input:
              delivery.inputAttribute === undefined
                ? undefined
                : JSON.parse(delivery.inputAttribute),
          },
  };
}

function agentChannelMetadata(
  session: AgentSessionTraceState | undefined,
  turn: AgentTurnTraceState,
  sessionId: string,
) {
  const isSubagent = (turn.parentLineage ?? session?.parentLineage) !== undefined;
  const ownsSessionMetadata = !isSubagent || turn.traceSessionId === sessionId;
  const channelKind =
    turn.channelDelivery?.channelKind ??
    (!ownsSessionMetadata
      ? undefined
      : (session?.channelKind ??
        (session?.channelType === undefined
          ? undefined
          : normalizeInstrumentationChannelKind(session.channelType))));
  const origin =
    !ownsSessionMetadata || channelKind === undefined
      ? undefined
      : session?.scheduleId !== undefined
        ? "schedule"
        : "channel";
  return { kind: channelKind, origin };
}

export function agentChannelClassificationAttributes(
  session: AgentSessionTraceState | undefined,
  turn: AgentTurnTraceState,
  sessionId: string,
) {
  return channelAttributes(agentChannelMetadata(session, turn, sessionId));
}

export function agentStepAttributes(input: {
  readonly event: InstrumentationStepAttemptStartedEvent;
  readonly frameworkVersion: string;
  readonly session?: AgentSessionTraceState;
  readonly turn: AgentTurnTraceState;
}) {
  const { event, session, turn } = input;
  const channelClassification = agentChannelMetadata(session, turn, event.scope.sessionId);
  return stepAttributes({
    framework: { name: "eve", version: input.frameworkVersion },
    attempt: {
      turnId: event.scope.turnId,
      index: event.scope.stepIndex,
      attempt: event.scope.attemptIndex,
    },
    agentName: event.scope.functionId,
    channel: channelClassification,
    runtimeContext: event.runtimeContext,
    identity: agentTraceIdentityAttributes({
      rootSessionId: event.scope.rootSessionId ?? event.scope.sessionId,
      traceSessionId: traceSessionIdOf(event.scope),
      sessionId: event.scope.sessionId,
    }),
  });
}

export function agentPrincipalAttributes(turn: AgentTurnTraceState): Record<string, string> {
  return principalAttributes({
    current: turn.currentPrincipal,
    initiator: turn.initiatorPrincipal,
  });
}

/** Flattens merged runtime context into AI SDK-compatible span attributes. */
export function runtimeContextAttributes(
  runtimeContext: Readonly<Record<string, unknown>> | undefined,
): Record<string, SpanAttributeValue> {
  const attributes: Record<string, SpanAttributeValue> = {};
  for (const [key, value] of Object.entries(traceRuntimeContextAttributes(runtimeContext))) {
    if (value !== undefined) attributes[key] = value as SpanAttributeValue;
  }
  return attributes;
}
