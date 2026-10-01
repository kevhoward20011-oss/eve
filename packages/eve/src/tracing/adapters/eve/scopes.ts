import { createTraceLifecycle } from "#tracing/core/scopes.js";
import { durableOtelBackend } from "#tracing/adapters/otel.js";
import { eveOutputMapping } from "#tracing/adapters/eve/compatibility.js";
import { aiSdkContentSerializer } from "#tracing/adapters/serializer.js";
import type { AgentSpanIdGenerator } from "#tracing/agent-span-id-generator.js";
import type { Tracer } from "#compiled/@opentelemetry/api/index.js";

export function createEveTraceLifecycle(input: {
  readonly tracer: Tracer;
  readonly idGenerator: AgentSpanIdGenerator;
}) {
  return createTraceLifecycle({
    serializer: aiSdkContentSerializer,
    backend: durableOtelBackend({
      ...input,
      samplesTrace: () => true,
      mapping: eveOutputMapping(),
    }),
  });
}
