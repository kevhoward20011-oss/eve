import type {
  Attributes,
  CaptureDecision,
  DurableTraceBackend,
  PreparedSpan,
  SpanWriter,
  TraceBackend,
  TraceReference,
  ExecutionContext,
} from "#tracing/core/types.js";
import { withoutDeclinedContent } from "#tracing/content-attributes.js";

export interface TraceOperation extends SpanWriter {
  readonly capture: CaptureDecision;
  readonly finished: boolean;
  run<T>(execute: () => T): T;
}

export function createTraceEngine(input: {
  readonly backend: TraceBackend | DurableTraceBackend;
  readonly diagnostic?: (code: string) => void;
}) {
  function report(): void {
    try {
      input.diagnostic?.("agent.tracing.failed");
    } catch {}
  }
  function safely<T>(execute: () => T): T | undefined {
    try {
      return execute();
    } catch {
      report();
      return undefined;
    }
  }
  function wrap(
    writer: SpanWriter | undefined,
    capture: CaptureDecision,
    executionContext?: ExecutionContext,
  ): TraceOperation {
    let finished = false;
    const reference = writer?.reference ?? {
      traceId: "0".repeat(32),
      spanId: "0".repeat(16),
      traceFlags: 0,
    };
    return {
      reference,
      capture,
      get finished() {
        return finished;
      },
      setAttribute(key, value) {
        const permitted = withoutDeclinedContent({ [key]: value }, capture);
        if (!finished && (permitted === undefined || key in permitted))
          safely(() =>
            writer?.setAttribute(
              key,
              permitted === undefined ? value : (permitted[key] as typeof value),
            ),
          );
      },
      addEvent(name, attributes, timeMs) {
        if (!finished)
          safely(() =>
            writer?.addEvent(
              name,
              attributes === undefined
                ? undefined
                : (withoutDeclinedContent(attributes, capture) as Attributes),
              timeMs,
            ),
          );
      },
      fail(error, errorType) {
        if (!finished)
          safely(() =>
            writer?.fail(
              capture.recordOutputs ? error : undefined,
              errorType ?? (error instanceof Error ? error.name : undefined),
            ),
          );
      },
      setStatus(code) {
        if (!finished) safely(() => writer?.setStatus(code));
      },
      end(timeMs) {
        if (finished) return;
        finished = true;
        safely(() => writer?.end(timeMs));
      },
      run(execute) {
        if (finished) return execute();
        let entered = false;
        try {
          return input.backend.run(
            reference,
            capture,
            () => {
              entered = true;
              return execute();
            },
            executionContext,
          );
        } catch (error) {
          if (entered) throw error;
          report();
          return execute();
        }
      },
    };
  }
  return {
    start(
      span: PreparedSpan,
      capture: CaptureDecision,
      executionContext?: ExecutionContext,
    ): TraceOperation {
      const attributes = (withoutDeclinedContent(span.attributes, capture) ??
        span.attributes) as Attributes;
      return wrap(
        capture.emit
          ? safely(() => input.backend.start({ ...span, attributes }, executionContext))
          : undefined,
        capture,
        executionContext,
      );
    },
    startReserved(
      span: PreparedSpan,
      reference: TraceReference,
      capture: CaptureDecision,
      executionContext?: ExecutionContext,
    ): TraceOperation {
      const backend = input.backend;
      if (!("startReserved" in backend))
        throw new Error("Durable tracing requires a backend with reserved-ID support.");
      const startReserved = backend.startReserved.bind(backend);
      const attributes = (withoutDeclinedContent(span.attributes, capture) ??
        span.attributes) as Attributes;
      return wrap(
        capture.emit
          ? safely(() => startReserved({ ...span, attributes }, reference, executionContext))
          : undefined,
        capture,
        executionContext,
      );
    },
    annotate(operation: TraceOperation, attributes: Attributes): void {
      for (const [key, value] of Object.entries(attributes))
        if (value !== undefined) operation.setAttribute(key, value);
    },
  };
}
