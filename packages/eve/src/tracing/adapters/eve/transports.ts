import { trace, type Tracer } from "#compiled/@opentelemetry/api/index.js";
import { liveOtelBackend } from "#tracing/adapters/otel.js";
import { eveOutputMapping } from "#tracing/adapters/eve/compatibility.js";
import { createTransportLifecycle } from "#tracing/core/transports.js";

const lifecycles = new WeakMap<Tracer, ReturnType<typeof createTransportLifecycle>>();

export function eveTransportLifecycle(scope: string) {
  const tracer = trace.getTracer(scope);
  let lifecycle = lifecycles.get(tracer);
  if (lifecycle === undefined) {
    lifecycle = createTransportLifecycle(liveOtelBackend(tracer, eveOutputMapping()));
    lifecycles.set(tracer, lifecycle);
  }
  return lifecycle;
}
