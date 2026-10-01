import { trace, SpanKind, type Context, type Tracer } from "#compiled/@opentelemetry/api/index.js";
import { createTraceEngine, type TraceOperation } from "#tracing/core/engine.js";
import { liveOtelBackend } from "#tracing/adapters/otel.js";
import { eveOutputMapping } from "#tracing/adapters/eve/compatibility.js";
import { channelRequestMetadata, applyAttributes } from "#tracing/core/contract.js";
import type { SpanType, TraceLink } from "#tracing/core/types.js";

type SpanOptions = NonNullable<Parameters<Tracer["startSpan"]>[1]>;
const engines = new WeakMap<Tracer, ReturnType<typeof createTraceEngine>>();

export function annotateChannelRequest(
  operation: TraceOperation,
  input: { channelName?: string; channelKind?: string },
): void {
  applyAttributes(operation, channelRequestMetadata(input));
}

/** Transport operations use the same backend without exposing an OTel span. */
export function startEveSpan(input: {
  readonly tracer: Tracer;
  readonly type: SpanType;
  readonly operationId: string;
  readonly name: string;
  readonly options?: SpanOptions;
  readonly parent?: Context;
  readonly links?: readonly TraceLink[];
}): TraceOperation {
  let engine = engines.get(input.tracer);
  if (engine === undefined) {
    engine = createTraceEngine({ backend: liveOtelBackend(input.tracer, eveOutputMapping()) });
    engines.set(input.tracer, engine);
  }
  return engine.start(
    {
      type: input.type,
      operationId: input.operationId,
      name: input.name,
      kind:
        input.options?.kind === undefined
          ? undefined
          : (SpanKind[input.options.kind] as
              | "INTERNAL"
              | "SERVER"
              | "CLIENT"
              | "PRODUCER"
              | "CONSUMER"),
      attributes: input.options?.attributes ?? {},
      root: input.options?.root,
      parent: input.parent === undefined ? undefined : trace.getSpan(input.parent)?.spanContext(),
      links: input.links,
      startTimeMs:
        typeof input.options?.startTime === "number" ? input.options.startTime : undefined,
    },
    { emit: true, recordInputs: true, recordOutputs: true },
    input.parent,
  );
}
