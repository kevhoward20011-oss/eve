import type { SpanContext } from "#compiled/@opentelemetry/api/index.js";

import {
  type InstrumentationSessionStartedEvent,
  type InstrumentationTraceContext,
  type InstrumentationTraceSeed,
  type InstrumentationTurnStartedEvent,
  type InstrumentationTurnTerminalEvent,
  type InstrumentationSessionTransitionEvent,
  type InstrumentationUsage,
} from "#instrumentation/lifecycle.js";
import type { AgentSpanIdGenerator } from "#tracing/agent-span-id-generator.js";
import { normalizeChannelAudience } from "#shared/channel-audience.js";
import type { ChannelAudience } from "#shared/channel-audience.js";
import type { TraceCapturePolicy } from "#tracing/otel-declaration.js";
import {
  isSampledTrace,
  resolveTracePolicy,
  resolveTracePolicyDecision,
} from "#tracing/sampled-trace.js";
import type { AgentSessionTraceState, AgentTraceStateStore } from "#tracing/agent-trace-state.js";
import { readInstrumentationDecision } from "#shared/instrumentation-decision.js";
import { eveActivationMetadata } from "#tracing/adapters/eve/metadata.js";
import { eveScopeRecord } from "#tracing/adapters/eve/checkpointer.js";
import type { AgentTurnTraceState } from "#tracing/agent-trace-state.js";
import { applyPrincipalTraceDecision } from "#instrumentation/principal-summary.js";
import { normalizeInstrumentationChannelKind } from "#internal/instrumentation.js";
import type { ConversationEnvironment } from "#shared/conversation-context.js";
import { traceSessionIdOf } from "#tracing/adapters/eve/checkpointer.js";
import { ROOT_CONTEXT } from "#compiled/@opentelemetry/api/index.js";
import { withChannelAudience } from "#tracing/channel-audience-context.js";
import type { TraceLink } from "#tracing/core/types.js";
import type { AgentTracing } from "#tracing/core/agent-tracing.js";

interface EveSessionTracingInput {
  readonly lifecycle: AgentTracing["lifecycle"];
  readonly environment: ConversationEnvironment;
  readonly frameworkVersion: string;
  readonly idGenerator: AgentSpanIdGenerator;
  readonly stateStore: AgentTraceStateStore;
  readonly tracePolicy?: TraceCapturePolicy;
}

type SessionMetadata = Omit<InstrumentationSessionStartedEvent, "idempotencyKey" | "type">;

interface EveSessionTracing {
  readonly ensureSessionContext: (event: SessionMetadata) => Promise<AgentSessionTraceState>;
  readonly prepareSessionTrace: (
    event: InstrumentationSessionStartedEvent,
  ) => Promise<InstrumentationTraceSeed>;
  readonly prepareTurnTrace: (
    event: InstrumentationTurnStartedEvent,
  ) => Promise<InstrumentationTraceSeed>;
  turnTerminal(event: InstrumentationTurnTerminalEvent): Promise<void>;
  sessionTransition(event: InstrumentationSessionTransitionEvent): Promise<void>;
  recordModelUsage(sessionId: string, turnId: string, usage: InstrumentationUsage): Promise<void>;
}

export function createEveSessionTracing(input: EveSessionTracingInput): EveSessionTracing {
  const ensureSessionContext = async (event: SessionMetadata): Promise<AgentSessionTraceState> => {
    let state = await input.stateStore.getSession(event.sessionId);
    if (state === undefined) {
      const channelAudience = normalizeChannelAudience(event.channelAudience);
      const decision = resolveSessionTraceDecision(
        event,
        channelAudience,
        input.environment,
        input.tracePolicy,
      );
      state = {
        agentName: event.agentName,
        channelAudience,
        channelKind: event.channelKind,
        channelType: event.channelType,
        decision,
        context: initialSessionContext(input, event, decision),
        parentLineage: event.parentLineage,
        rootSessionId: event.rootSessionId,
        traceSessionId: traceSessionIdOf(event),
        scheduleId: event.scheduleId,
        title: event.title,
      };
      await input.stateStore.setSession(event.sessionId, state);
    }
    return state;
  };

  const prepareSessionTrace = async (
    event: InstrumentationSessionStartedEvent,
  ): Promise<InstrumentationTraceSeed> => {
    const session = await ensureSessionContext(event);
    return portableSpanContext(session.context, session.decision);
  };

  const prepareTurnTrace = async (
    event: InstrumentationTurnStartedEvent,
  ): Promise<InstrumentationTraceSeed> => {
    const prepared = await input.stateStore.getTurn(event.sessionId, event.turnId);
    if (prepared !== undefined) {
      const session = await input.stateStore.getSession(event.sessionId);
      return portableSpanContext(prepared.context, session?.decision);
    }

    const session = await ensureSessionContext(event);
    const useInitialContext = event.sequence === 0;
    const caller = useInitialContext ? event.parentTraceContext : undefined;
    let turnContext = useInitialContext
      ? { ...session.context, isRemote: false }
      : freshTurnContext(input, event.idempotencyKey, session.decision);
    const turn: AgentTurnTraceState = {
      caller: caller === undefined ? undefined : adoptedSpanContext(caller),
      context: turnContext,
      currentPrincipal: applyPrincipalTraceDecision(event.currentPrincipal, session.decision),
      initiatorPrincipal: applyPrincipalTraceDecision(event.initiatorPrincipal, session.decision),
      parentLineage: event.parentLineage ?? session.parentLineage,
      rootSessionId: event.rootSessionId,
      traceSessionId: traceSessionIdOf(event),
      sequence: event.sequence,
      startTimeMs: Date.now(),
      subagentName: (event.parentLineage ?? session.parentLineage)?.subagentName,
    };
    if (isSampledTrace(turn.context)) {
      const agentName = session.agentName ?? turn.subagentName;
      const sampled = input.lifecycle.sample(
        eveScopeRecord(
          {
            ...turn,
            sessionId: event.sessionId,
            turnId: event.turnId,
            agentName,
            frameworkVersion: input.frameworkVersion,
            reference: turn.context,
          },
          event.idempotencyKey,
          {
            type: "activation",
            options: eveActivationMetadata({ session, turn, sessionId: event.sessionId }),
          },
        ),
      );
      turnContext = { ...turnContext, traceFlags: sampled ? 1 : 0 };
    }
    await input.stateStore.setTurn(event.sessionId, event.turnId, {
      ...turn,
      context: turnContext,
    });
    return portableSpanContext(turnContext, session.decision);
  };

  return {
    ensureSessionContext,
    prepareSessionTrace,
    prepareTurnTrace,
    async turnTerminal(event) {
      await input.stateStore.updateTurn(event.sessionId, event.turnId, (turn) => ({
        ...turn,
        terminal:
          event.type === "turn.failed"
            ? { error: event.error, type: event.type }
            : { type: event.type },
      }));
    },
    async sessionTransition(event) {
      if (event.type === "session.failed" && event.turnId !== undefined)
        await input.stateStore.updateTurn(event.sessionId, event.turnId, (turn) => ({
          ...turn,
          terminal: turn.terminal ?? { error: event.error, type: "turn.failed" },
        }));
      if (event.turnId === undefined) return;
      const turn = await input.stateStore.getTurn(event.sessionId, event.turnId);
      if (turn === undefined) return;
      const session = await input.stateStore.getSession(event.sessionId);
      if (isSampledTrace(turn.context)) {
        const runtime = await input.lifecycle.resolve(
          eveScopeRecord(
            {
              ...turn,
              sessionId: event.sessionId,
              turnId: event.turnId,
              agentName: session?.agentName ?? turn.subagentName,
              frameworkVersion: input.frameworkVersion,
              reference: turn.context,
              links: activationLinks(turn),
              content: {
                recordInputs:
                  session?.decision?.action === "record" && session.decision.recordInputs,
                recordOutputs:
                  session?.decision?.action === "record" && session.decision.recordOutputs,
              },
            },
            `${event.sessionId}:${event.turnId}`,
            {
              type: "activation",
              options: eveActivationMetadata({ session, turn, sessionId: event.sessionId }),
            },
          ),
          {
            deferred: true,
            executionContext: withChannelAudience(ROOT_CONTEXT, session?.channelAudience),
          },
        );
        await runtime.finish({
          usage: turn.modelUsage,
          outcome:
            turn.terminal === undefined
              ? undefined
              : turn.terminal.type === "turn.completed"
                ? "completed"
                : turn.terminal.type === "turn.cancelled"
                  ? "cancelled"
                  : "failed",
          failed: turn.terminal?.type === "turn.failed",
          error: turn.terminal?.type === "turn.failed" ? turn.terminal.error : undefined,
        });
      }
      await input.stateStore.deleteTurn(event.sessionId, event.turnId);
    },
    async recordModelUsage(sessionId, turnId, usage) {
      if (usage.inputTokens === undefined && usage.outputTokens === undefined) return;
      // Workflow replay restarts from pre-step state; distinct completed retries count.
      await input.stateStore.updateTurn(sessionId, turnId, (turn) => ({
        ...turn,
        modelUsage: {
          inputTokens:
            usage.inputTokens === undefined
              ? turn.modelUsage?.inputTokens
              : (turn.modelUsage?.inputTokens ?? 0) + usage.inputTokens,
          outputTokens:
            usage.outputTokens === undefined
              ? turn.modelUsage?.outputTokens
              : (turn.modelUsage?.outputTokens ?? 0) + usage.outputTokens,
        },
      }));
    },
  };
}

function activationLinks(turn: AgentTurnTraceState): TraceLink[] | undefined {
  const links: TraceLink[] = [];
  if (turn.caller !== undefined)
    links.push({ context: turn.caller, relationship: "agent.dispatch" });
  if (turn.channelDelivery?.requestTraceContext !== undefined)
    links.push({
      context: turn.channelDelivery.requestTraceContext,
      relationship: "channel.request",
    });
  return links.length === 0 ? undefined : links;
}

function portableSpanContext(
  spanContext: SpanContext,
  decision?: InstrumentationTraceSeed["decision"],
): InstrumentationTraceSeed {
  return {
    decision,
    spanId: spanContext.spanId,
    traceFlags: spanContext.traceFlags,
    traceId: spanContext.traceId,
  };
}

function adoptedSpanContext(handed: InstrumentationTraceContext): SpanContext {
  return {
    isRemote: "isRemote" in handed && handed.isRemote === true,
    spanId: handed.spanId,
    traceFlags: handed.traceFlags,
    traceId: handed.traceId,
  };
}

function initialSessionContext(
  input: EveSessionTracingInput,
  event: SessionMetadata,
  decision: ReturnType<typeof resolveTracePolicy>,
): SpanContext {
  const handed = event.traceSeed;
  if (handed !== undefined) {
    return {
      ...adoptedSpanContext(handed),
      traceFlags: decision.action === "drop" ? 0 : handed.traceFlags,
    };
  }
  const traceId = input.idGenerator.deriveTraceId(`session:${event.sessionId}`);
  const sampled = decision.action === "record";
  return {
    isRemote: false,
    spanId: input.idGenerator.deriveSpanId(`session:${event.sessionId}`),
    traceFlags: sampled ? 1 : 0,
    traceId,
  };
}

function freshTurnContext(
  input: EveSessionTracingInput,
  idempotencyKey: string,
  decision: AgentSessionTraceState["decision"],
): SpanContext {
  const traceId = input.idGenerator.deriveTraceId(`turn:${idempotencyKey}`);
  const sampled = decision?.action === "record";
  return {
    isRemote: false,
    spanId: input.idGenerator.deriveSpanId(`turn:${idempotencyKey}`),
    traceFlags: sampled ? 1 : 0,
    traceId,
  };
}

function resolveSessionTraceDecision(
  event: SessionMetadata,
  audience: ChannelAudience,
  environment: ConversationEnvironment,
  policy: TraceCapturePolicy | undefined,
): ReturnType<typeof resolveTracePolicy> {
  const content = { audience, environment };
  if (event.parentTraceContext !== undefined && !isSampledTrace(event.parentTraceContext)) {
    return { action: "drop" };
  }
  if (event.traceSeed?.decision !== undefined) {
    return readInstrumentationDecision(event.traceSeed.decision) ?? { action: "drop" };
  }
  if (event.traceSeed !== undefined) {
    return resolveTracePolicyDecision(isSampledTrace(event.traceSeed), content);
  }
  if (event.parentTraceContext !== undefined) {
    return resolveTracePolicyDecision(isSampledTrace(event.parentTraceContext), content);
  }
  if (event.agentName === undefined) {
    return policy === undefined ? resolveTracePolicyDecision(true, content) : { action: "drop" };
  }
  // The tool loop can evaluate the same policy before this first-session
  // preparation path; the persisted decision removes that window on replay.
  return resolveTracePolicy(policy, {
    agentName: event.agentName,
    audience,
    channel: {
      kind: normalizeInstrumentationChannelKind(event.channelKind ?? event.channelType),
    },
    environment,
    principalType: "unknown",
  });
}
