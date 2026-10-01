import { trace, type Context, type Span, type Tracer } from "#compiled/@opentelemetry/api/index.js";
import {
  createScopeRuntime,
  type RuntimeScope,
  type ScopeData,
  type ScopeIdentity,
  type ScopeRecord,
  type ScopeTerminal,
} from "#tracing/core/scopes.js";
import { durableOtelBackend, liveOtelBackend } from "#tracing/adapters/otel.js";
import { eveOutputMapping } from "#tracing/adapters/eve/compatibility.js";
import { aiSdkContentSerializer } from "#tracing/adapters/serializer.js";
import type { AgentSpanIdGenerator } from "#tracing/agent-span-id-generator.js";
import { resolveConversationId } from "#shared/conversation-identity.js";
import type { TraceLink } from "#tracing/core/types.js";

export interface EveScopeIdentity {
  readonly sessionId: string;
  readonly rootSessionId: string;
  readonly turnId: string;
  readonly traceSessionId: string;
  readonly agentName?: string;
  readonly frameworkVersion: string;
}

export interface EveTraceScope {
  readonly span: Span;
  readonly runtime: RuntimeScope;
  finish(result?: ScopeTerminal): Promise<void>;
}

/** The scheduler owns continuation; this binding reconstructs only trace scopes. */
export async function bindEveTraceScope(input: {
  readonly tracer: Tracer;
  readonly idGenerator?: AgentSpanIdGenerator;
  readonly identity: EveScopeIdentity;
  readonly data: ScopeData;
  readonly key: string;
  readonly parent?: Context;
  readonly reference?: import("#tracing/core/types.js").TraceReference;
  readonly startTimeMs?: number;
  readonly deferred?: boolean;
  readonly links?: readonly TraceLink[];
  readonly attempt?: ScopeRecord["attempt"];
  readonly content?: { readonly recordInputs: boolean; readonly recordOutputs: boolean };
}): Promise<EveTraceScope> {
  let recorded: Span | undefined;
  const tracer = {
    startSpan(name: string, options: Parameters<Tracer["startSpan"]>[1]) {
      recorded = input.tracer.startSpan(name, options, input.parent);
      return recorded;
    },
  } as Tracer;
  const identity: ScopeIdentity = {
    conversationId: resolveConversationId(input.identity.rootSessionId),
    runId: input.identity.sessionId,
    turnId: input.identity.turnId,
    agentName: input.identity.agentName,
    framework: { name: "eve", version: input.identity.frameworkVersion },
  };
  const mapping = eveOutputMapping({
    resolve: () => ({
      platform: process.env.VERCEL_ENV === undefined ? "other" : "vercel",
      traceSessionId: input.identity.traceSessionId,
    }),
  });
  const backend =
    input.idGenerator === undefined
      ? liveOtelBackend(tracer, mapping)
      : durableOtelBackend({
          tracer,
          idGenerator: input.idGenerator,
          samplesTrace: () => true,
          mapping,
        });
  const scopes = createScopeRuntime({ backend, serializer: aiSdkContentSerializer });
  const runtime = await scopes.bind(
    identity,
    input.data,
    // eve's lifecycle bus already projects content under its audience ceiling.
    { emit: true, recordInputs: true, recordOutputs: true },
    {
      key: input.key,
      reference: input.reference,
      parent: input.parent === undefined ? undefined : trace.getSpan(input.parent)?.spanContext(),
      startTimeMs: input.startTimeMs,
      deferred: input.deferred,
      links: input.links,
      content: input.content,
    },
    input.attempt,
  );
  const span = new Proxy(trace.wrapSpanContext(runtime.reference), {
    get(target, key) {
      if (key === "end")
        return () => {
          void runtime.finish();
        };
      const actual = recorded ?? target;
      const value = Reflect.get(actual, key, actual);
      return typeof value === "function" ? value.bind(actual) : value;
    },
  });
  return { span, runtime, finish: (result) => runtime.finish(result) };
}
