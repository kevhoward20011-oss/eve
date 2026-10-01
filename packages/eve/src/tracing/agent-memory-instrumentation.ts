import { ROOT_CONTEXT, context, trace, type Context } from "#compiled/@opentelemetry/api/index.js";

import { contextStorage } from "#context/container.js";
import { SessionTraceSeedKey } from "#context/keys.js";
import type { InstrumentationProviderDefinition } from "#instrumentation/lifecycle.js";
import type {
  InstrumentationMemoryExecutionOperation,
  InstrumentationMemoryOperationEvent,
  InstrumentationMemoryOperationStartedEvent,
  InstrumentationMemoryOperationTerminalEvent,
} from "#instrumentation/memory.js";
import { normalizeChannelAudience } from "#shared/channel-audience.js";
import {
  applyLiveDeliveryAudienceCeiling,
  resolveForwardedTraceSeed,
} from "#shared/forwarded-trace-policy.js";
import { isAgentTraceContext, markAgentTraceContext } from "#tracing/agent-trace-context.js";
import type { AgentTraceStateStore } from "#tracing/agent-trace-state.js";
import { withChannelAudience } from "#tracing/channel-audience-context.js";
import { withErrorContent } from "#tracing/error-content-context.js";
import { isSampledTrace } from "#tracing/sampled-trace.js";
import { suppressTracing } from "#tracing/suppress-tracing.js";
import type { ConversationEnvironment } from "#shared/conversation-context.js";
import { eveScopeRecord } from "#tracing/adapters/eve/checkpointer.js";
import type { RuntimeScope } from "#tracing/core/scopes.js";
import type { AgentTracing } from "#tracing/core/agent-tracing.js";

type SpanState = { readonly runtime: RuntimeScope; readonly context: Context };

interface AgentMemoryInstrumentation {
  readonly events: Pick<
    NonNullable<InstrumentationProviderDefinition["events"]>,
    "memory.operation.completed" | "memory.operation.failed" | "memory.operation.started"
  >;
  runInContext<T>(
    operation: InstrumentationMemoryExecutionOperation,
    execute: () => PromiseLike<T>,
  ): Promise<T>;
}

export function createAgentMemoryInstrumentation(input: {
  readonly lifecycle: AgentTracing["lifecycle"];
  readonly idGenerator: import("#tracing/agent-span-id-generator.js").AgentSpanIdGenerator;
  readonly environment: ConversationEnvironment;
  readonly recordOutputs?: boolean;
  readonly stateStore: AgentTraceStateStore;
}): AgentMemoryInstrumentation {
  const recordOutputs = input.recordOutputs ?? false;
  const spans = new Map<string, SpanState>();

  const parentContext = async (
    event: InstrumentationMemoryOperationEvent,
  ): Promise<Context | undefined> => {
    const active = context.active();
    if (isAgentTraceContext(active)) return active;

    const session = await input.stateStore.getSession(event.sessionId);
    if (event.turnId !== undefined) {
      const turn = await input.stateStore.getTurn(event.sessionId, event.turnId);
      if (turn !== undefined) {
        return withChannelAudience(contextFromSpanContext(turn.context), session?.channelAudience);
      }
    }
    return session === undefined
      ? undefined
      : withChannelAudience(contextFromSpanContext(session.context), session.channelAudience);
  };

  const onStarted = async (event: InstrumentationMemoryOperationStartedEvent): Promise<void> => {
    if (spans.has(event.idempotencyKey)) return;
    const parent = await parentContext(event);
    const parentSpan = parent === undefined ? undefined : trace.getSpan(parent)?.spanContext();
    if (parent === undefined || parentSpan === undefined || !isSampledTrace(parentSpan)) return;
    const reference = { ...parentSpan, spanId: input.idGenerator.allocateSpanId() };
    const runtime = await input.lifecycle.resolve(
      eveScopeRecord(
        {
          ...event,
          turnId: event.turnId ?? "",
          frameworkVersion: "",
          parent: parentSpan,
          reference,
        },
        event.idempotencyKey,
        {
          type: "memory",
          options: {
            operation: event.operationName,
            phase: event.phase,
            slot: event.slot,
            storeId: event.storeId,
          },
        },
      ),
      { executionContext: parent },
    );
    spans.set(event.idempotencyKey, {
      context: trace.setSpan(parent, trace.wrapSpanContext(runtime.reference)),
      runtime,
    });
  };

  const onTerminal = async (event: InstrumentationMemoryOperationTerminalEvent): Promise<void> => {
    const state = spans.get(event.idempotencyKey);
    if (state === undefined) return;
    spans.delete(event.idempotencyKey);
    await state.runtime.finish(
      event.type === "memory.operation.failed"
        ? { failed: true, error: event.error }
        : { recordCount: event.recordCount, records: event.outputRecords },
    );
  };

  return {
    events: {
      "memory.operation.completed": onTerminal,
      "memory.operation.failed": onTerminal,
      "memory.operation.started": onStarted,
    },
    async runInContext(operation, execute) {
      const session = await input.stateStore.getSession(operation.sessionId);
      let parent = spans.get(operation.idempotencyKey)?.context;
      if (parent === undefined && operation.turnId !== undefined) {
        const turn = await input.stateStore.getTurn(operation.sessionId, operation.turnId);
        if (turn !== undefined) {
          parent = withChannelAudience(
            contextFromSpanContext(turn.context),
            session?.channelAudience,
          );
          if (!isSampledTrace(turn.context)) parent = suppressTracing(parent);
        }
      }
      if (parent === undefined && session !== undefined) {
        parent = withChannelAudience(
          contextFromSpanContext(session.context),
          session.channelAudience,
        );
        if (!isSampledTrace(session.context)) parent = suppressTracing(parent);
      }
      const seed = resolveForwardedTraceSeed(contextStorage.getStore()?.get(SessionTraceSeedKey));
      const decision = seed?.decision ?? session?.decision;
      const effective =
        decision === undefined
          ? undefined
          : applyLiveDeliveryAudienceCeiling(
              decision,
              normalizeChannelAudience(session?.channelAudience),
              seed?.forwardedTracePolicy,
              input.environment,
            );
      return parent === undefined
        ? await execute()
        : await context.with(
            markAgentTraceContext(
              withErrorContent(
                parent,
                recordOutputs && effective?.action === "record" && effective.recordOutputs,
              ),
            ),
            execute,
          );
    },
  };
}

function contextFromSpanContext(spanContext: Parameters<typeof trace.wrapSpanContext>[0]): Context {
  return trace.setSpan(ROOT_CONTEXT, trace.wrapSpanContext(spanContext));
}
