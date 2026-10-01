import {
  ROOT_CONTEXT,
  type Context,
  type Attributes,
  type SpanContext,
  trace,
} from "#compiled/@opentelemetry/api/index.js";

import type {
  InstrumentationActionStartedEvent,
  InstrumentationToolCallStartedEvent,
  InstrumentationToolCallTerminalEvent,
} from "#instrumentation/lifecycle.js";
import { actionIdempotencyKey } from "#instrumentation/lifecycle.js";
import { withChannelAudience } from "#tracing/channel-audience-context.js";
import type { AgentSpanIdGenerator } from "#tracing/agent-span-id-generator.js";
import type { AgentActionContext } from "#tracing/agent-action-instrumentation.js";
import { withAgentToolSpanContext } from "#tracing/agent-tool-span-context.js";
import { eveScopeRecord } from "#tracing/adapters/eve/checkpointer.js";
import type { RuntimeScope, createTraceLifecycle } from "#tracing/core/scopes.js";

interface ToolSpanState {
  readonly actionKey: string;
  readonly attemptId: string;
  context: Context;
  readonly additionalAttributes: Attributes;
  readonly event: InstrumentationToolCallStartedEvent;
  readonly fallbackParent: Context;
  readonly idempotencyKey: string;
  readonly spanId: string;
  readonly startTimeMs: number;
  finished?: true;
  scope?: RuntimeScope;
  terminal?: InstrumentationToolCallTerminalEvent;
  pendingError?: { readonly error: unknown; readonly errorType?: string };
}

interface AgentToolInstrumentation {
  actionStarted(event: InstrumentationActionStartedEvent): Promise<void>;
  contextFor(attemptId: string, idempotencyKey: string): Context | undefined;
  drain(attemptId: string, failure?: { readonly error: unknown }): Promise<void>;
  readonly events: {
    readonly "tool.call.completed": (event: InstrumentationToolCallTerminalEvent) => Promise<void>;
    readonly "tool.call.failed": (event: InstrumentationToolCallTerminalEvent) => Promise<void>;
    readonly "tool.call.started": (event: InstrumentationToolCallStartedEvent) => Promise<void>;
  };
}

/** Keeps SDK tool spans parented to actions even when SDK telemetry wins the event race. */
export function createAgentToolInstrumentation(input: {
  readonly lifecycle: ReturnType<typeof createTraceLifecycle>;
  readonly actionContextFor: (
    sessionId: string,
    turnId: string,
    callId: string,
  ) => Promise<AgentActionContext | undefined>;
  readonly idGenerator: AgentSpanIdGenerator;
  readonly recordInputs: boolean;
  readonly recordOutputs: boolean;
  readonly resolveFallback: (
    event: InstrumentationToolCallStartedEvent,
  ) => { readonly context: Context; readonly spanContext: SpanContext } | undefined;
}): AgentToolInstrumentation {
  const byAction = new Map<string, ToolSpanState>();
  const byAttempt = new Map<string, Map<string, ToolSpanState>>();

  const onStarted = async (event: InstrumentationToolCallStartedEvent): Promise<void> => {
    const actionKey = actionIdempotencyKey(event.scope.sessionId, event.scope.turnId, event.callId);
    const fallback = input.resolveFallback(event);
    let state = fallback === undefined ? undefined : reserve(event, actionKey, fallback);
    const actionParent = await input.actionContextFor(
      event.scope.sessionId,
      event.scope.turnId,
      event.callId,
    );
    if (state === undefined) {
      if (actionParent === undefined) return;
      state = reserve(event, actionKey, actionParent);
    }
    if (actionParent !== undefined) await startSpan(state, actionParent.context);
  };

  const onTerminal = async (event: InstrumentationToolCallTerminalEvent): Promise<void> => {
    const state = byAttempt.get(event.scope.attemptId)?.get(event.idempotencyKey);
    if (state === undefined) return;
    state.terminal = event;

    if (state.scope === undefined) {
      const actionParent = await input.actionContextFor(
        state.event.scope.sessionId,
        state.event.scope.turnId,
        state.event.callId,
      );
      if (actionParent !== undefined) await startSpan(state, actionParent.context);
    }
    await finishIfReady(state);
  };

  return {
    async actionStarted(event) {
      const state = byAction.get(event.idempotencyKey);
      if (state === undefined || state.scope !== undefined || state.finished === true) return;
      const actionParent = await input.actionContextFor(
        event.scope.sessionId,
        event.scope.turnId,
        event.callId,
      );
      if (actionParent === undefined) return;
      await startSpan(state, actionParent.context);
      await finishIfReady(state);
    },
    contextFor: (attemptId, idempotencyKey) =>
      byAttempt.get(attemptId)?.get(idempotencyKey)?.context,
    async drain(attemptId, failure) {
      const states = byAttempt.get(attemptId);
      if (states === undefined) return;
      for (const state of states.values()) {
        if (state.finished === true) continue;
        if (state.scope === undefined) await startSpan(state, state.fallbackParent);
        await finish(state, failure);
      }
      byAttempt.delete(attemptId);
    },
    events: {
      "tool.call.completed": onTerminal,
      "tool.call.failed": onTerminal,
      "tool.call.started": onStarted,
    },
  };

  function getAttemptStates(attemptId: string): Map<string, ToolSpanState> {
    let states = byAttempt.get(attemptId);
    if (states === undefined) {
      states = new Map();
      byAttempt.set(attemptId, states);
    }
    return states;
  }

  function reserve(
    event: InstrumentationToolCallStartedEvent,
    actionKey: string,
    parent: { readonly context: Context; readonly spanContext: SpanContext },
  ): ToolSpanState {
    const spanId = input.idGenerator.deriveSpanId(`tool:${event.idempotencyKey}`);
    const state: ToolSpanState = {
      actionKey,
      attemptId: event.scope.attemptId,
      additionalAttributes: {},
      context: withChannelAudience(
        contextFromSpanContext({
          isRemote: false,
          spanId,
          traceFlags: parent.spanContext.traceFlags,
          traceId: parent.spanContext.traceId,
        }),
        event.scope.channelAudience,
      ),
      event,
      fallbackParent: parent.context,
      idempotencyKey: event.idempotencyKey,
      spanId,
      startTimeMs: Date.now(),
    };
    state.context = withAgentToolSpanContext(state.context, {
      recordInputs: input.recordInputs,
      recordOutputs: input.recordOutputs,
      setAttributes(attributes) {
        Object.assign(state.additionalAttributes, attributes);
        state.scope?.annotate(attributes);
      },
      recordError(error, errorType) {
        state.pendingError = { error, errorType };
        state.scope?.error(error, errorType);
      },
    });
    getAttemptStates(event.scope.attemptId).set(event.idempotencyKey, state);
    byAction.set(actionKey, state);
    return state;
  }

  async function startSpan(state: ToolSpanState, parent: Context): Promise<void> {
    if (state.scope !== undefined || state.finished === true) return;
    state.scope = await input.lifecycle.resolve(
      eveScopeRecord(
        {
          ...state.event.scope,
          frameworkVersion: "",
          parent: trace.getSpan(parent)!.spanContext(),
          startTimeMs: state.startTimeMs,
          reference: { ...trace.getSpan(parent)!.spanContext(), spanId: state.spanId },
        },
        state.idempotencyKey,
        {
          type: "tool",
          options: {
            callId: state.event.callId,
            name: state.event.toolName,
            arguments: input.recordInputs ? state.event.input : undefined,
          },
        },
      ),
      { executionContext: parent },
    );
    state.scope.annotate(state.additionalAttributes);
    if (state.pendingError !== undefined) {
      state.scope.error(state.pendingError.error, state.pendingError.errorType);
    }
  }

  async function finishIfReady(state: ToolSpanState): Promise<void> {
    if (state.scope === undefined || state.terminal === undefined) return;
    await finish(state);
  }

  async function finish(
    state: ToolSpanState,
    failure?: { readonly error: unknown },
  ): Promise<void> {
    if (state.scope === undefined || state.finished === true) return;
    state.finished = true;
    const terminal = state.terminal;
    const failed =
      failure !== undefined ||
      terminal?.type === "tool.call.failed" ||
      terminal?.output.type === "error";
    const error =
      failure?.error ??
      (terminal?.type === "tool.call.failed"
        ? terminal.error
        : terminal?.output.type === "error"
          ? terminal.output.error
          : undefined);
    await state.scope?.finish({
      failed,
      error,
      output:
        input.recordOutputs &&
        terminal?.type === "tool.call.completed" &&
        terminal.output.type === "result"
          ? terminal.output.output
          : undefined,
    });
    byAction.delete(state.actionKey);
    const states = byAttempt.get(state.attemptId);
    states?.delete(state.idempotencyKey);
    if (states?.size === 0) byAttempt.delete(state.attemptId);
  }
}

function contextFromSpanContext(spanContext: SpanContext): Context {
  return trace.setSpan(ROOT_CONTEXT, trace.wrapSpanContext(spanContext));
}
