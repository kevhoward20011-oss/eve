import {
  ROOT_CONTEXT,
  context,
  type Context,
  type SpanContext,
  type Tracer,
  trace,
} from "#compiled/@opentelemetry/api/index.js";

import { contextStorage } from "#context/container.js";
import { SessionTraceSeedKey } from "#context/keys.js";
import { withoutInstrumentationContent } from "#instrumentation/content.js";
import { instrumentationEventForTraceDecision } from "#instrumentation/content-policy.js";
import type { AgentTraceStateStore, AgentTurnTraceState } from "#tracing/agent-trace-state.js";
import type { AgentSpanIdGenerator } from "#tracing/agent-span-id-generator.js";
import { createAgentActionInstrumentation } from "#tracing/agent-action-instrumentation.js";
import { createAgentApprovalInstrumentation } from "#tracing/agent-approval-instrumentation.js";
import { createAgentChannelDeliveryInstrumentation } from "#tracing/agent-channel-delivery-instrumentation.js";
import { createAgentToolInstrumentation } from "#tracing/agent-tool-instrumentation.js";
import { markAgentTraceContext } from "#tracing/agent-trace-context.js";
import * as runtimeAttributes from "#tracing/agent-otel-runtime-context.js";
import { createAgentMemoryInstrumentation } from "#tracing/agent-memory-instrumentation.js";
import { readGatewayCost, readGatewayCostData } from "#tracing/agent-otel-usage.js";
import { createAgentOtelSessionContext } from "#tracing/agent-otel-session-context.js";
import type { TraceCapturePolicy } from "#tracing/otel-declaration.js";
import { isSampledTrace, resolveTracePolicyDecision } from "#tracing/sampled-trace.js";
import {
  applyLiveDeliveryAudienceCeiling,
  resolveForwardedTraceSeed,
} from "#shared/forwarded-trace-policy.js";
import { readInstrumentationDecision } from "#shared/instrumentation-decision.js";
import { withChannelAudience } from "#tracing/channel-audience-context.js";
import { suppressTracing } from "#tracing/suppress-tracing.js";
import { normalizeChannelAudience, type ChannelAudience } from "#shared/channel-audience.js";
import type {
  InstrumentationEvent,
  InstrumentationStepAttemptMetadataEvent,
  InstrumentationAttemptScope,
  InstrumentationStepAttemptStartedEvent,
  InstrumentationStepAttemptTerminalEvent,
  InstrumentationContextRunner,
  InstrumentationModelCallTerminalEvent,
  InstrumentationModelCallStartedEvent,
  InstrumentationProviderDefinition,
  InstrumentationSessionStartedEvent,
  InstrumentationTraceSeed,
  InstrumentationSessionTransitionEvent,
  InstrumentationTurnStartedEvent,
  InstrumentationTurnTerminalEvent,
} from "#instrumentation/lifecycle.js";
import { attemptIdempotencyKey } from "#instrumentation/lifecycle.js";
import { type AgentSamplingOperation } from "#tracing/agent-span-contract.js";
import { withErrorContent } from "#tracing/error-content-context.js";
import { withAgentToolContentPolicy } from "#tracing/agent-tool-span-context.js";
import { resolveInstrumentationEnvironment } from "#internal/application/dev-environment.js";
import type { ConversationEnvironment } from "#shared/conversation-context.js";
import type { TraceLink } from "#tracing/core/types.js";
import { createEveTraceLifecycle } from "#tracing/adapters/eve/scopes.js";
import { eveScopeRecord } from "#tracing/adapters/eve/checkpointer.js";
import type { RuntimeScope } from "#tracing/core/scopes.js";

type SpanState = { readonly runtime: RuntimeScope; readonly context: Context };

export interface AgentOtelInstrumentationInput {
  readonly environment?: ConversationEnvironment;
  /** Whether any destination records model and tool inputs. */
  readonly recordInputs?: boolean;
  /** Whether any destination records model and tool outputs. */
  readonly recordOutputs?: boolean;
  readonly frameworkVersion: string;
  readonly idGenerator: AgentSpanIdGenerator;
  readonly samplesTrace?: (traceId: string, operation?: AgentSamplingOperation) => boolean;
  readonly stateStore: AgentTraceStateStore;
  readonly tracer: Tracer;
  readonly tracePolicy?: TraceCapturePolicy;
}

/** OTel event definition and its trusted framework context runner. */
interface AgentOtelInstrumentation {
  readonly hook: InstrumentationProviderDefinition;
  readonly prepareSessionTrace: (
    event: InstrumentationSessionStartedEvent,
  ) => Promise<InstrumentationTraceSeed>;
  readonly prepareTurnTrace: (
    event: InstrumentationTurnStartedEvent,
  ) => Promise<InstrumentationTraceSeed>;
  readonly runInContext: InstrumentationContextRunner;
}

/** Creates OTel instrumentation for eve's structural and GenAI spans. */
export function createAgentOtelInstrumentation(
  input: AgentOtelInstrumentationInput,
): AgentOtelInstrumentation {
  const environment = input.environment ?? resolveInstrumentationEnvironment();
  const recordInputs = input.recordInputs ?? false;
  const recordOutputs = input.recordOutputs ?? false;
  const lifecycle = createEveTraceLifecycle(input);
  const executionContexts = new WeakMap<InstrumentationAttemptScope, Map<string, Context>>();
  const attemptScopes = new Map<string, InstrumentationAttemptScope>();
  // A lost serverless worker retries the whole turn step from entry.
  const steps = new WeakMap<InstrumentationAttemptScope, SpanState>();
  const modelSpans = new WeakMap<InstrumentationAttemptScope, Map<string, SpanState>>();
  const actions = createAgentActionInstrumentation({
    lifecycle,
    frameworkVersion: input.frameworkVersion,
    idGenerator: input.idGenerator,
    recordInputs,
    recordOutputs,
    resolveTraceContext: async (event) => {
      const turn = await input.stateStore.getTurn(event.scope.sessionId, event.scope.turnId);
      return turn?.context;
    },
    stateStore: input.stateStore,
  });
  const approvals = createAgentApprovalInstrumentation({
    lifecycle,
    actionContextFor: actions.contextFor,
    frameworkVersion: input.frameworkVersion,
    idGenerator: input.idGenerator,
  });
  const tools = createAgentToolInstrumentation({
    lifecycle,
    actionContextFor: actions.contextFor,
    idGenerator: input.idGenerator,
    recordInputs,
    recordOutputs,
    resolveFallback: (event) => {
      const scope = attemptScopes.get(event.scope.attemptId) ?? event.scope;
      const step = steps.get(scope);
      return step === undefined
        ? undefined
        : { context: step.context, spanContext: step.runtime.reference };
    },
  });
  const memory = createAgentMemoryInstrumentation({ ...input, environment, lifecycle });
  const { prepareSessionTrace, prepareTurnTrace } = createAgentOtelSessionContext({
    ...input,
    environment,
  });

  const projectEvent = async (event: InstrumentationEvent): Promise<InstrumentationEvent> => {
    const session = await input.stateStore.getSession(sessionIdForEvent(event));
    const audience = audienceForEvent(event, session?.channelAudience);
    const eventSeed = "traceSeed" in event ? event.traceSeed : undefined;
    const contextSeed = contextStorage.getStore()?.get(SessionTraceSeedKey);
    const contextTraceState = resolveForwardedTraceSeed(contextSeed);
    const eventTraceState = resolveForwardedTraceSeed(
      eventSeed,
      contextTraceState?.forwardedTracePolicy,
    );
    const decisionForTrace = (trace: { readonly traceFlags: number } | undefined) =>
      trace === undefined
        ? undefined
        : resolveTracePolicyDecision(isSampledTrace(trace), { audience, environment });
    const decision =
      eventTraceState?.decision ??
      contextTraceState?.decision ??
      readInstrumentationDecision(session?.decision) ??
      decisionForTrace(eventSeed) ??
      decisionForTrace(contextSeed) ??
      decisionForTrace(session?.context);
    if (decision === undefined) return withoutInstrumentationContent(event);
    const normalizedEvent =
      eventTraceState === undefined || !("traceSeed" in event) || event.traceSeed === undefined
        ? event
        : {
            ...event,
            traceSeed: {
              ...event.traceSeed,
              decision: eventTraceState.decision,
              traceFlags: eventTraceState.traceFlags,
            },
          };
    return instrumentationEventForTraceDecision(
      normalizedEvent,
      applyLiveDeliveryAudienceCeiling(
        decision.action === "drop"
          ? decision
          : {
              action: "record",
              recordInputs: recordInputs && decision.recordInputs,
              recordOutputs: recordOutputs && decision.recordOutputs,
            },
        audience,
        eventTraceState?.forwardedTracePolicy ?? contextTraceState?.forwardedTracePolicy,
        environment,
      ),
      { audience, environment },
      { applyAudienceCeiling: false },
    );
  };

  const onSessionStarted = async (event: InstrumentationSessionStartedEvent): Promise<void> => {
    await prepareSessionTrace(event);
  };

  const onTurnStarted = async (event: InstrumentationTurnStartedEvent): Promise<void> => {
    await prepareTurnTrace(event);
  };

  const onStepStarted = async (event: InstrumentationStepAttemptStartedEvent): Promise<void> => {
    const turn = await input.stateStore.getTurn(event.scope.sessionId, event.scope.turnId);
    if (turn === undefined || !isSampledTrace(turn.context)) return;
    const session = await input.stateStore.getSession(event.scope.sessionId);
    const turnContext = withChannelAudience(
      contextFromSpanContext(turn.context),
      event.scope.channelAudience,
    );
    const activeSpanContext = trace.getSpan(context.active())?.spanContext();
    const runtime = await lifecycle.resolve(
      eveScopeRecord(
        {
          ...event.scope,
          frameworkVersion: input.frameworkVersion,
          parent: turn.context,
          reference: {
            ...turn.context,
            spanId: input.idGenerator.deriveSpanId(attemptIdempotencyKey(event.scope)),
          },
          links:
            activeSpanContext === undefined || activeSpanContext.traceId === turn.context.traceId
              ? undefined
              : [{ relationship: "execution.delivery", context: activeSpanContext }],
        },
        event.idempotencyKey,
        {
          type: "step",
          options: {
            index: event.scope.stepIndex,
            attempt: event.scope.attemptIndex,
            runtimeContext: event.runtimeContext,
            channel: runtimeAttributes.agentActivationMetadata({
              session,
              turn,
              sessionId: event.scope.sessionId,
            }).channel,
          },
        },
      ),
      { executionContext: turnContext },
    );
    const stepContext = trace.setSpan(turnContext, trace.wrapSpanContext(runtime.reference));
    steps.set(event.scope, { runtime, context: stepContext });
    attemptScopes.set(event.scope.attemptId, event.scope);
  };

  const onStepTerminal = async (event: InstrumentationStepAttemptTerminalEvent): Promise<void> => {
    const scope = attemptScopes.get(event.scope.attemptId) ?? event.scope;
    executionContexts.delete(scope);
    drainOpenSpans({ ...event, scope });
    await tools.drain(
      event.scope.attemptId,
      event.type === "step.attempt.failed" ? { error: event.error } : undefined,
    );
    if (event.type === "step.attempt.failed") {
      await actions.failForAttempt(scope, event.error);
    }
    attemptScopes.delete(event.scope.attemptId);
    const attempt = steps.get(scope);
    if (attempt === undefined) return;
    await attempt.runtime.finish({
      failed: event.type === "step.attempt.failed",
      error: event.type === "step.attempt.failed" ? event.error : undefined,
    });
    steps.delete(scope);
  };

  const onTurnTerminal = async (event: InstrumentationTurnTerminalEvent): Promise<void> => {
    await input.stateStore.updateTurn(event.sessionId, event.turnId, (turn) => ({
      ...turn,
      terminal:
        event.type === "turn.failed"
          ? { error: event.error, type: event.type }
          : { type: event.type },
    }));
  };

  const onSessionTransition = async (
    event: InstrumentationSessionTransitionEvent,
  ): Promise<void> => {
    if (event.type === "session.failed" && event.turnId !== undefined) {
      await input.stateStore.updateTurn(event.sessionId, event.turnId, (turn) => ({
        ...turn,
        terminal: turn.terminal ?? { error: event.error, type: "turn.failed" },
      }));
    }
    if (event.turnId !== undefined) {
      const turn = await input.stateStore.getTurn(event.sessionId, event.turnId);
      if (turn !== undefined) {
        const session = await input.stateStore.getSession(event.sessionId);
        if (isSampledTrace(turn.context)) {
          const agentName = session?.agentName ?? turn.subagentName;
          const parentContext = withChannelAudience(ROOT_CONTEXT, session?.channelAudience);
          const runtime = await lifecycle.resolve(
            eveScopeRecord(
              {
                ...turn,
                sessionId: event.sessionId,
                turnId: event.turnId,
                agentName,
                frameworkVersion: input.frameworkVersion,
                reference: turn.context,
                startTimeMs: turn.startTimeMs,
                links: agentActivationLinks(turn),
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
                options: runtimeAttributes.agentActivationMetadata({
                  session,
                  turn,
                  sessionId: event.sessionId,
                }),
              },
            ),
            { deferred: true, executionContext: parentContext },
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
      }
    }
    // `session.waiting` is not terminal — the session may resume with a new
    // turn that still needs its metadata — so only release session-scoped
    // state on terminal transitions.
    if (event.type === "session.completed" || event.type === "session.failed") {
      await actions.deleteForSession(event.sessionId);
      await input.stateStore.deleteSession(event.sessionId);
    }
  };

  const onModelCallStarted = async (event: InstrumentationModelCallStartedEvent): Promise<void> => {
    const attempt = steps.get(event.scope);
    if (attempt === undefined) return;
    attempt.runtime.modelSelected(event.model.modelId, event.model.provider);
    const runtime = await attempt.runtime.model(
      {
        provider: event.model.provider,
        modelId: event.model.modelId,
        messages: recordInputs ? event.input?.messages : undefined,
        instructions: recordInputs ? event.input?.instructions : undefined,
        runtimeContext: event.runtimeContext,
      },
      { key: event.idempotencyKey, executionContext: attempt.context },
    );
    const state = {
      runtime,
      context: trace.setSpan(attempt.context, trace.wrapSpanContext(runtime.reference)),
    };
    getExecutionContexts(event.scope).set(event.idempotencyKey, state.context);
    getSpanStates(modelSpans, event.scope).set(event.idempotencyKey, state);
  };

  const onModelCallTerminal = async (
    event: InstrumentationModelCallTerminalEvent,
  ): Promise<void> => {
    executionContexts.get(event.scope)?.delete(event.idempotencyKey);
    const state = takeSpanState(modelSpans, event.scope, event.idempotencyKey);
    if (state === undefined) return;
    if (event.type === "model.call.failed") {
      await state.runtime.finish({ failed: true, error: event.error });
    } else {
      await recordTurnUsage(event);
      await state.runtime.finish({
        model: { ...event, content: recordOutputs ? event.content : undefined },
      });
      const attempt = steps.get(event.scope);
      if (attempt !== undefined) await attempt.runtime.usage(event.usage);
    }
  };

  const recordTurnUsage = async (
    event: Extract<
      InstrumentationModelCallTerminalEvent,
      { readonly type: "model.call.completed" }
    >,
  ): Promise<void> => {
    if (event.usage.inputTokens === undefined && event.usage.outputTokens === undefined) return;
    // The bridge publishes at most one completion per physical execution.
    // Workflow retries restart from pre-step state, so abandoned additions are
    // not merged; distinct completed retries consumed tokens and count here.
    await input.stateStore.updateTurn(event.scope.sessionId, event.scope.turnId, (turn) => ({
      ...turn,
      modelUsage: {
        inputTokens:
          event.usage.inputTokens === undefined
            ? turn.modelUsage?.inputTokens
            : (turn.modelUsage?.inputTokens ?? 0) + event.usage.inputTokens,
        outputTokens:
          event.usage.outputTokens === undefined
            ? turn.modelUsage?.outputTokens
            : (turn.modelUsage?.outputTokens ?? 0) + event.usage.outputTokens,
      },
    }));
  };

  const channelDeliveries = createAgentChannelDeliveryInstrumentation({
    recordInputs,
    stateStore: input.stateStore,
  });

  const onStepMetadata = (event: InstrumentationStepAttemptMetadataEvent): void => {
    const attempt = steps.get(event.scope);
    if (attempt === undefined) return;
    // Vercel AI Gateway reports per-call cost in providerMetadata.gateway;
    // attributes exist only when it was actually the gateway serving the call.
    const costAttributes = readGatewayCost(event.providerMetadata);
    if (costAttributes === undefined) return;
    // The vendored OTel Span surface only has singular setAttribute.
    attempt.runtime.cost(readGatewayCostData(event.providerMetadata) ?? {});
  };

  return {
    hook: {
      events: {
        ...channelDeliveries,
        "action.completed": actions.events["action.completed"],
        "action.failed": actions.events["action.failed"],
        async "action.started"(event, ctx) {
          await actions.events["action.started"]!(event, ctx);
          await tools.actionStarted(event);
        },
        ...approvals,
        ...memory.events,
        "step.attempt.completed": onStepTerminal,
        "step.attempt.failed": onStepTerminal,
        "step.attempt.metadata": onStepMetadata,
        "step.attempt.started": onStepStarted,
        "model.call.completed": onModelCallTerminal,
        "model.call.failed": onModelCallTerminal,
        "model.call.started": onModelCallStarted,
        "session.completed": onSessionTransition,
        "session.failed": onSessionTransition,
        "session.started": onSessionStarted,
        "session.waiting": onSessionTransition,
        ...tools.events,
        "turn.cancelled": onTurnTerminal,
        "turn.completed": onTurnTerminal,
        "turn.failed": onTurnTerminal,
        "turn.started": onTurnStarted,
      },
      name: "eve.otel",
      projectEvent,
      tracePolicy: () => ({ emit: true, recordInputs, recordOutputs }),
    },
    prepareSessionTrace,
    prepareTurnTrace,
    async runInContext(operation, execute) {
      if (operation.type === "memory.operation") return memory.runInContext(operation, execute);
      const scope = attemptScopes.get(operation.scope.attemptId) ?? operation.scope;
      const contexts = executionContexts.get(scope);
      let parent =
        operation.type === "model.call"
          ? contexts?.get(operation.idempotencyKey)
          : tools.contextFor(operation.scope.attemptId, operation.idempotencyKey);
      if (parent === undefined) {
        const turn = await input.stateStore.getTurn(
          operation.scope.sessionId,
          operation.scope.turnId,
        );
        if (turn !== undefined) {
          parent = withChannelAudience(
            contextFromSpanContext(turn.context),
            operation.scope.channelAudience,
          );
          if (!isSampledTrace(turn.context)) parent = suppressTracing(parent);
        }
      }
      const session = await input.stateStore.getSession(operation.scope.sessionId);
      const seed = resolveForwardedTraceSeed(contextStorage.getStore()?.get(SessionTraceSeedKey));
      const decision = seed?.decision ?? session?.decision;
      const effective =
        decision === undefined
          ? undefined
          : applyLiveDeliveryAudienceCeiling(
              decision,
              normalizeChannelAudience(operation.scope.channelAudience),
              seed?.forwardedTracePolicy,
              environment,
            );
      const toolContentPolicy = {
        recordInputs: recordInputs && effective?.action === "record" && effective.recordInputs,
        recordOutputs: recordOutputs && effective?.action === "record" && effective.recordOutputs,
      };
      if (parent === undefined) return execute();
      const withErrorPolicy = withErrorContent(parent, toolContentPolicy.recordOutputs);
      const operationContext =
        operation.type === "tool.call"
          ? withAgentToolContentPolicy(withErrorPolicy, toolContentPolicy)
          : withErrorPolicy;
      return context.with(markAgentTraceContext(operationContext), execute);
    },
  };

  function getExecutionContexts(scope: InstrumentationAttemptScope): Map<string, Context> {
    let state = executionContexts.get(scope);
    if (state === undefined) {
      state = new Map();
      executionContexts.set(scope, state);
    }
    return state;
  }

  function drainOpenSpans(event: InstrumentationStepAttemptTerminalEvent): void {
    for (const state of modelSpans.get(event.scope)?.values() ?? []) {
      void state.runtime.finish({
        failed: event.type === "step.attempt.failed",
        error: event.type === "step.attempt.failed" ? event.error : undefined,
      });
    }
    modelSpans.delete(event.scope);
  }
}

function agentActivationLinks(turn: AgentTurnTraceState): TraceLink[] | undefined {
  const links: TraceLink[] = [];
  if (turn.caller !== undefined) {
    links.push({
      context: turn.caller,
      relationship: "agent.dispatch",
    });
  }
  if (turn.channelDelivery?.requestTraceContext !== undefined) {
    links.push({
      context: turn.channelDelivery.requestTraceContext,
      relationship: "channel.request",
    });
  }
  return links.length === 0 ? undefined : links;
}

function sessionIdForEvent(event: InstrumentationEvent): string {
  return "scope" in event ? event.scope.sessionId : event.sessionId;
}

function audienceForEvent(
  event: InstrumentationEvent,
  sessionAudience: ChannelAudience | undefined,
): ChannelAudience {
  if ("delivery" in event) return normalizeChannelAudience(event.delivery.channelAudience);
  if ("scope" in event && event.scope.channelAudience !== undefined) {
    return normalizeChannelAudience(event.scope.channelAudience);
  }
  if (event.type === "session.started") {
    return normalizeChannelAudience(event.channelAudience);
  }
  return normalizeChannelAudience(sessionAudience);
}

function getSpanStates<T>(
  spans: WeakMap<InstrumentationAttemptScope, Map<string, T>>,
  scope: InstrumentationAttemptScope,
): Map<string, T> {
  let scoped = spans.get(scope);
  if (scoped === undefined) {
    scoped = new Map();
    spans.set(scope, scoped);
  }
  return scoped;
}

function takeSpanState<T>(
  spans: WeakMap<InstrumentationAttemptScope, Map<string, T>>,
  scope: InstrumentationAttemptScope,
  id: string,
): T | undefined {
  const scoped = spans.get(scope);
  const state = scoped?.get(id);
  if (scoped === undefined) return undefined;
  scoped.delete(id);
  if (scoped.size === 0) spans.delete(scope);
  return state;
}

function contextFromSpanContext(spanContext: SpanContext): Context {
  return trace.setSpan(ROOT_CONTEXT, trace.wrapSpanContext(spanContext));
}
