import type { AgentSessionTraceState, AgentTurnTraceState } from "#tracing/agent-trace-state.js";
import { normalizeInstrumentationChannelKind } from "#internal/instrumentation.js";
import type { TurnMetadata } from "#tracing/core/scopes.js";
import { checkpointContent } from "#tracing/adapters/eve/checkpointer.js";

/** Converts eve-owned session metadata to the lifecycle DSL's semantic input. */
export function agentActivationMetadata(input: {
  readonly session?: AgentSessionTraceState;
  readonly turn: AgentTurnTraceState;
  readonly sessionId: string;
}): TurnMetadata {
  const { session, turn, sessionId } = input;
  const lineage = turn.parentLineage ?? session?.parentLineage;
  const owns = lineage === undefined || turn.traceSessionId === sessionId;
  const delivery = turn.channelDelivery;
  const kind =
    delivery?.channelKind ??
    (!owns
      ? undefined
      : (session?.channelKind ??
        (session?.channelType === undefined
          ? undefined
          : normalizeInstrumentationChannelKind(session.channelType))));
  return {
    sequence: turn.sequence,
    subagent: lineage !== undefined,
    subagentName: turn.subagentName,
    parentCallId: lineage?.callId,
    parentRunId: lineage?.sessionId,
    channel: {
      kind,
      origin:
        !owns || kind === undefined
          ? undefined
          : session?.scheduleId === undefined
            ? "channel"
            : "schedule",
    },
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
            input: checkpointContent(delivery.inputAttribute),
          },
  };
}
