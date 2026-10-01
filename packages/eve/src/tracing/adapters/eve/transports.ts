import { trace, type Tracer } from "#compiled/@opentelemetry/api/index.js";
import { liveOtelBackend } from "#tracing/adapters/otel.js";
import { eveOutputMapping } from "#tracing/adapters/eve/compatibility.js";
import { createAgentTracing } from "#tracing/core/agent-tracing.js";
import { aiSdkContentSerializer } from "#tracing/adapters/serializer.js";

const lifecycles = new WeakMap<Tracer, ReturnType<typeof createAgentTracing>["lifecycle"]>();

export function eveTransportLifecycle(scope: string) {
  const tracer = trace.getTracer(scope);
  let lifecycle = lifecycles.get(tracer);
  if (lifecycle === undefined) {
    lifecycle = createAgentTracing({
      adapter: {
        backend: liveOtelBackend(tracer, eveOutputMapping()),
        serializer: aiSdkContentSerializer,
      },
    }).lifecycle;
    lifecycles.set(tracer, lifecycle);
  }
  return lifecycle;
}
