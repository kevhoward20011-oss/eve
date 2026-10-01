import {
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  context,
  trace,
  createTraceState,
  type SpanContext,
  type Context,
  type Tracer,
} from "#compiled/@opentelemetry/api/index.js";
import { recordAgentSpanError } from "#tracing/agent-span-error.js";
import { withErrorContent } from "#tracing/error-content-context.js";
import { suppressTracing } from "#tracing/suppress-tracing.js";
import type { AgentSpanIdGenerator } from "#tracing/agent-span-id-generator.js";
import type {
  Attributes,
  DurableTraceBackend,
  OutputMapping,
  PreparedSpan,
  SpanWriter,
  TraceBackend,
  TraceReference,
  ExecutionContext,
} from "#tracing/core/types.js";
import { linkAttributes } from "#tracing/core/links.js";

function parentContext(reference: TraceReference | undefined, host?: ExecutionContext): Context {
  const base = (host as Context | undefined) ?? ROOT_CONTEXT;
  return reference === undefined
    ? base
    : trace.setSpan(base, trace.wrapSpanContext(otelReference(reference)));
}

function otelReference(reference: TraceReference): SpanContext {
  return {
    ...reference,
    traceState:
      reference.tracestate === undefined ? undefined : createTraceState(reference.tracestate),
  };
}

function portableReference(reference: SpanContext): TraceReference {
  return {
    traceId: reference.traceId,
    spanId: reference.spanId,
    traceFlags: reference.traceFlags,
    isRemote: reference.isRemote,
    tracestate: reference.traceState?.serialize(),
  };
}

function mappedAttributes(
  mapping: OutputMapping | undefined,
  span: PreparedSpan,
  attributes: Attributes,
): Attributes {
  return mapping?.attributes(span, attributes) ?? attributes;
}

export function liveOtelBackend(tracer: Tracer, mapping?: OutputMapping): TraceBackend {
  function start(span: PreparedSpan, executionContext?: ExecutionContext): SpanWriter {
    const recorded = tracer.startSpan(
      span.name,
      {
        attributes: mappedAttributes(mapping, span, span.attributes),
        kind: span.kind === undefined ? undefined : SpanKind[span.kind],
        root: span.root,
        startTime: span.startTimeMs,
        links: span.links?.map((link) => ({
          context: otelReference(link.context),
          attributes: mapping?.link(span, link) ?? linkAttributes(link).attributes,
        })),
      },
      parentContext(span.root ? undefined : span.parent, executionContext),
    );
    return {
      reference: portableReference(recorded.spanContext()),
      setAttribute(key, value) {
        for (const [name, mapped] of Object.entries(
          mappedAttributes(mapping, span, { [key]: value }),
        )) {
          if (mapped !== undefined) recorded.setAttribute(name, mapped);
        }
      },
      addEvent: (name, attributes, timeMs) => {
        recorded.addEvent(name, attributes, timeMs);
      },
      fail: (error, errorType) => recordAgentSpanError(recorded, error, errorType),
      setStatus: (code) => {
        recorded.setStatus({ code: SpanStatusCode[code] });
      },
      end: (timeMs) => {
        recorded.end(timeMs);
      },
    };
  }
  return {
    start,
    current: () => {
      const active = trace.getSpan(context.active())?.spanContext();
      return active === undefined ? undefined : portableReference(active);
    },
    run(reference, capture, execute, executionContext) {
      // Retain baggage and host context while replacing the semantic parent span.
      let active = trace.setSpan(
        (executionContext as Context | undefined) ?? context.active(),
        trace.wrapSpanContext(otelReference(reference)),
      );
      active = withErrorContent(active, capture.recordOutputs);
      if (!capture.emit || (reference.traceFlags & 1) === 0) active = suppressTracing(active);
      return context.with(active, execute);
    },
  };
}

export function durableOtelBackend(input: {
  readonly tracer: Tracer;
  readonly idGenerator: AgentSpanIdGenerator;
  readonly samplesTrace: (
    traceId: string,
    operation: { name: string; attributes: Attributes },
  ) => boolean;
  readonly mapping?: OutputMapping;
}): DurableTraceBackend {
  const live = liveOtelBackend(input.tracer, input.mapping);
  return {
    ...live,
    admits(span, reference) {
      return input.samplesTrace(reference.traceId, {
        name: span.name,
        attributes: mappedAttributes(input.mapping, span, span.attributes),
      });
    },
    reserveActivation({ key, span, capture }) {
      const traceId = input.idGenerator.deriveTraceId(key);
      return {
        traceId,
        spanId: input.idGenerator.deriveSpanId(key),
        traceFlags:
          capture.emit &&
          input.samplesTrace(traceId, {
            name: span.name,
            attributes: mappedAttributes(input.mapping, span, span.attributes),
          })
            ? 1
            : 0,
      };
    },
    reserveChild: (parent, key) => ({
      ...parent,
      spanId: input.idGenerator.deriveSpanId(key),
      isRemote: false,
    }),
    startReserved(span, reference, executionContext) {
      const writer = input.idGenerator.withTraceId(reference.traceId, () =>
        input.idGenerator.withSpanId(reference.spanId, () => live.start(span, executionContext)),
      );
      if (
        writer.reference.spanId !== reference.spanId ||
        writer.reference.traceId !== reference.traceId
      ) {
        throw new Error("The tracer provider must use the durable backend's ID generator.");
      }
      return writer;
    },
  };
}
