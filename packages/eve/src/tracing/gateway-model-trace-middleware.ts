import {
  context as otelContext,
  propagation,
  trace,
  type TextMapSetter,
} from "#compiled/@opentelemetry/api/index.js";
import type { LanguageModelMiddleware } from "ai";

import { stripEveTraceBaggage } from "#protocol/baggage.js";
import { isTracingSuppressed } from "#tracing/suppress-tracing.js";

const traceContextSetter: TextMapSetter<Record<string, string>> = {
  set(carrier, key, value) {
    carrier[key] = value;
  },
};

export const gatewayTraceContextMiddleware: LanguageModelMiddleware = {
  specificationVersion: "v4",
  async transformParams({ params }) {
    const activeContext = otelContext.active();
    if (isTracingSuppressed(activeContext) || trace.getSpan(activeContext) === undefined) {
      return params;
    }

    const headers: Record<string, string> = {};
    propagation.inject(activeContext, headers, traceContextSetter);
    stripEveTraceBaggage(headers);
    if (Object.keys(headers).length === 0) return params;

    return { ...params, headers: { ...params.headers, ...headers } };
  },
};
