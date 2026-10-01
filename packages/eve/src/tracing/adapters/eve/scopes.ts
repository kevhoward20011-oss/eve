import { trace, type Context, type Tracer } from "#compiled/@opentelemetry/api/index.js";
import {
  createTraceLifecycle,
  type RuntimeScope,
  type ScopeData,
  type ScopeRecord,
  type ScopeTerminal,
} from "#tracing/core/scopes.js";
import { durableOtelBackend, liveOtelBackend } from "#tracing/adapters/otel.js";
import { eveOutputMapping } from "#tracing/adapters/eve/compatibility.js";
import { aiSdkContentSerializer } from "#tracing/adapters/serializer.js";
import type { AgentSpanIdGenerator } from "#tracing/agent-span-id-generator.js";
import { resolveConversationId } from "#shared/conversation-identity.js";
import type { TraceLink, TraceReference } from "#tracing/core/types.js";

export interface EveScopeIdentity {
  readonly sessionId: string;
  readonly rootSessionId: string;
  readonly turnId: string;
  readonly traceSessionId: string;
  readonly agentName?: string;
  readonly frameworkVersion: string;
}

export interface EveTraceScope {
  readonly runtime: RuntimeScope;
  finish(result?: ScopeTerminal): Promise<void>;
}

const runtimes = new WeakMap<
  Tracer,
  Map<AgentSpanIdGenerator | undefined, ReturnType<typeof createTraceLifecycle>>
>();

export async function bindEveTraceScope(input: {
  readonly tracer: Tracer;
  readonly idGenerator?: AgentSpanIdGenerator;
  readonly identity: EveScopeIdentity;
  readonly data: ScopeData;
  readonly key: string;
  readonly parent?: Context;
  readonly reference?: TraceReference;
  readonly startTimeMs?: number;
  readonly deferred?: boolean;
  readonly links?: readonly TraceLink[];
  readonly attempt?: ScopeRecord["attempt"];
  readonly content?: { readonly recordInputs: boolean; readonly recordOutputs: boolean };
}): Promise<EveTraceScope> {
  let byGenerator = runtimes.get(input.tracer);
  if (byGenerator === undefined) {
    byGenerator = new Map();
    runtimes.set(input.tracer, byGenerator);
  }
  let lifecycle = byGenerator.get(input.idGenerator);
  if (lifecycle === undefined) {
    const mapping = eveOutputMapping();
    const backend =
      input.idGenerator === undefined
        ? liveOtelBackend(input.tracer, mapping)
        : durableOtelBackend({
            tracer: input.tracer,
            idGenerator: input.idGenerator,
            samplesTrace: () => true,
            mapping,
          });
    lifecycle = createTraceLifecycle({ backend, serializer: aiSdkContentSerializer });
    byGenerator.set(input.idGenerator, lifecycle);
  }
  const runtime = await lifecycle.bind(
    {
      conversationId: resolveConversationId(input.identity.rootSessionId),
      runId: input.identity.sessionId,
      turnId: input.identity.turnId,
      agentName: input.identity.agentName,
      framework: { name: "eve", version: input.identity.frameworkVersion },
    },
    input.data,
    { emit: true, recordInputs: true, recordOutputs: true },
    {
      key: input.key,
      reference: input.reference,
      parent: input.parent === undefined ? undefined : trace.getSpan(input.parent)?.spanContext(),
      executionContext: input.parent,
      startTimeMs: input.startTimeMs,
      deferred: input.deferred,
      links: input.links,
      content: input.content,
      outputContext: {
        traceSessionId: input.identity.traceSessionId,
        platform: process.env.VERCEL_ENV === undefined ? "other" : "vercel",
      },
    },
    input.attempt,
  );
  return { runtime, finish: (result) => runtime.finish(result) };
}
