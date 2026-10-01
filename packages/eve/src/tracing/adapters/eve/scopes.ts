import { createAgentTracing } from "#tracing/core/agent-tracing.js";
import { durableOtelBackend } from "#tracing/adapters/otel.js";
import { eveOutputMapping } from "#tracing/adapters/eve/compatibility.js";
import { aiSdkContentSerializer } from "#tracing/adapters/serializer.js";
import type { AgentSpanIdGenerator } from "#tracing/agent-span-id-generator.js";
import type { Tracer } from "#compiled/@opentelemetry/api/index.js";

export function createEveTraceLifecycle(input: {
  readonly tracer: Tracer;
  readonly idGenerator: AgentSpanIdGenerator;
  readonly samplesTrace?: import("#tracing/agent-otel-provider.js").AgentOtelInstrumentationInput["samplesTrace"];
}) {
  return createAgentTracing({
    adapter: {
      serializer: aiSdkContentSerializer,
      backend: durableOtelBackend({
        ...input,
        samplesTrace: (traceId, operation) =>
          input.samplesTrace?.(
            traceId,
            operation as import("#tracing/agent-span-contract.js").AgentSamplingOperation,
          ) ?? true,
        mapping: eveOutputMapping(),
      }),
    },
  }).lifecycle;
}
