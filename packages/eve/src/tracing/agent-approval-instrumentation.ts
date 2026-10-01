import { ROOT_CONTEXT, type SpanContext, trace } from "#compiled/@opentelemetry/api/index.js";

import type {
  InstrumentationHandlerContext,
  InstrumentationInputRequestedEvent,
  InstrumentationInputResolvedEvent,
  InstrumentationProviderDefinition,
} from "#instrumentation/lifecycle.js";
import type { JsonValue } from "#shared/json.js";
import { contentAttribute } from "#tracing/agent-otel-content.js";
import { traceSessionIdOf } from "#tracing/agent-otel-attributes.js";
import { decodeTraceSessionId } from "#tracing/agent-trace-context-codec.js";
import { withChannelAudience } from "#tracing/channel-audience-context.js";
import type { AgentActionContext } from "#tracing/agent-action-instrumentation.js";
import type { AgentSpanIdGenerator } from "#tracing/agent-span-id-generator.js";
import { normalizeChannelAudience, type ChannelAudience } from "#shared/channel-audience.js";
import { eveScopeRecord, checkpointContent } from "#tracing/adapters/eve/checkpointer.js";
import type { AgentTracing } from "#tracing/core/agent-tracing.js";

interface AgentApprovalSpanState {
  readonly traceSessionId: string;
  readonly actionCallId: string;
  readonly actionName: string;
  readonly attemptIndex: number;
  readonly channelAudience: ChannelAudience;
  readonly parent: SpanContext;
  readonly requestAttribute?: string;
  readonly requestId: string;
  readonly rootSessionId: string;
  readonly sessionId: string;
  readonly startTimeMs: number;
  readonly stepIndex: number;
  readonly turnId: string;
}

/** Builds durable approval wait spans under their originating runtime action. */
export function createAgentApprovalInstrumentation(input: {
  readonly lifecycle: AgentTracing["lifecycle"];
  readonly actionContextFor: (
    sessionId: string,
    turnId: string,
    callId: string,
  ) => Promise<AgentActionContext | undefined>;
  readonly frameworkVersion: string;
  readonly idGenerator: AgentSpanIdGenerator;
}): Pick<
  NonNullable<InstrumentationProviderDefinition["events"]>,
  "input.requested" | "input.resolved"
> {
  const onRequested = async (
    event: InstrumentationInputRequestedEvent,
    ctx: InstrumentationHandlerContext,
  ): Promise<void> => {
    if (event.kind !== "tool-approval" || readState(ctx.state.get()) !== undefined) return;
    const parent = await input.actionContextFor(
      event.scope.sessionId,
      event.scope.turnId,
      event.action.callId,
    );
    if (parent === undefined) return;
    const state: Record<string, JsonValue> = {
      actionCallId: event.action.callId,
      actionName: event.action.name,
      attemptIndex: event.scope.attemptIndex,
      channelAudience: normalizeChannelAudience(event.scope.channelAudience),
      parent: {
        spanId: parent.spanContext.spanId,
        traceFlags: parent.spanContext.traceFlags,
        traceId: parent.spanContext.traceId,
      },
      requestId: event.requestId,
      rootSessionId: event.scope.rootSessionId ?? event.scope.sessionId,
      traceSessionId: traceSessionIdOf(event.scope),
      sessionId: event.scope.sessionId,
      startTimeMs: Date.now(),
      stepIndex: event.scope.stepIndex,
      turnId: event.scope.turnId,
    };
    const requestAttribute = contentAttribute(event.request);
    if (requestAttribute !== undefined) state["requestAttribute"] = requestAttribute;
    ctx.state.set(state);
  };

  const onResolved = async (
    event: InstrumentationInputResolvedEvent,
    ctx: InstrumentationHandlerContext,
  ): Promise<void> => {
    const state = readState(ctx.state.get());
    if (state === undefined) return;
    const parent = withChannelAudience(
      trace.setSpan(ROOT_CONTEXT, trace.wrapSpanContext({ ...state.parent, isRemote: false })),
      state.channelAudience,
    );
    const runtime = await input.lifecycle.resolve(
      eveScopeRecord(
        {
          ...state,
          frameworkVersion: input.frameworkVersion,
          reference: {
            ...state.parent,
            spanId: input.idGenerator.deriveSpanId(`approval:${event.idempotencyKey}`),
          },
        },
        event.idempotencyKey,
        {
          type: "approval",
          options: {
            callId: state.actionCallId,
            actionName: state.actionName,
            requestId: state.requestId,
            request: checkpointContent(state.requestAttribute),
          },
        },
      ),
      { deferred: true, executionContext: parent },
    );
    await runtime.finish({
      outcome: event.outcome,
      response: event.response,
      failed: event.outcome === "failed",
      error: event.error,
    });
  };

  return {
    "input.requested": onRequested,
    "input.resolved": onResolved,
  };
}

function readState(value: unknown): AgentApprovalSpanState | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const state = value as Record<string, unknown>;
  const parent = state["parent"];
  if (typeof parent !== "object" || parent === null || Array.isArray(parent)) return undefined;
  const parentRecord = parent as Record<string, unknown>;
  if (
    typeof state["actionCallId"] !== "string" ||
    typeof state["actionName"] !== "string" ||
    typeof state["attemptIndex"] !== "number" ||
    typeof parentRecord["spanId"] !== "string" ||
    typeof parentRecord["traceFlags"] !== "number" ||
    typeof parentRecord["traceId"] !== "string" ||
    typeof state["requestId"] !== "string" ||
    typeof state["rootSessionId"] !== "string" ||
    typeof state["sessionId"] !== "string" ||
    typeof state["startTimeMs"] !== "number" ||
    typeof state["stepIndex"] !== "number" ||
    typeof state["turnId"] !== "string"
  ) {
    return undefined;
  }
  const requestAttribute = state["requestAttribute"];
  if (requestAttribute !== undefined && typeof requestAttribute !== "string") return undefined;
  return {
    actionCallId: state["actionCallId"],
    actionName: state["actionName"],
    attemptIndex: state["attemptIndex"],
    channelAudience: normalizeChannelAudience(state["channelAudience"]),
    parent: {
      isRemote: false,
      spanId: parentRecord["spanId"],
      traceFlags: parentRecord["traceFlags"],
      traceId: parentRecord["traceId"],
    },
    requestAttribute,
    requestId: state["requestId"],
    rootSessionId: state["rootSessionId"],
    traceSessionId: decodeTraceSessionId(state),
    sessionId: state["sessionId"],
    startTimeMs: state["startTimeMs"],
    stepIndex: state["stepIndex"],
    turnId: state["turnId"],
  };
}
