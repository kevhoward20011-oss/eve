import {
  context,
  propagation,
  trace,
  type TextMapGetter,
} from "#compiled/@opentelemetry/api/index.js";
import { getInstrumentationRuntime } from "#instrumentation/runtime.js";
import { markAgentTraceContext } from "#tracing/agent-trace-context.js";
import { withErrorContent } from "#tracing/error-content-context.js";
import { eveTransportLifecycle } from "#tracing/adapters/eve/transports.js";

export type ChannelRequestTrace = ReturnType<ReturnType<typeof eveTransportLifecycle>["request"]>;
const headersGetter: TextMapGetter<Headers> = {
  get: (headers, key) => headers.get(key) ?? undefined,
  keys: (headers) => [...headers.keys()],
};

/** The request lifetime ends at handler return, not response-body consumption. */
export async function traceChannelRequest<T extends Response>(
  input: { readonly request: Request; readonly routeKey: string },
  handler: (operation: ChannelRequestTrace | undefined) => Promise<T>,
): Promise<T> {
  if (getInstrumentationRuntime()?.otelSettings?.traceChannelRequests !== true)
    return handler(undefined);
  const { request, routeKey } = input;
  const parent = propagation.extract(context.active(), request.headers, headersGetter);
  const separator = routeKey.indexOf(" ");
  let url: URL | undefined;
  try {
    url = new URL(request.url);
  } catch {}
  const operation = eveTransportLifecycle("eve.channel").request({
    method: request.method,
    route: separator === -1 ? routeKey : routeKey.slice(separator + 1),
    scheme: url?.protocol.replace(/:$/, ""),
    serverAddress: url?.hostname,
    parent: trace.getSpan(parent)?.spanContext(),
    executionContext: parent,
  });
  const active = markAgentTraceContext(
    withErrorContent(trace.setSpan(parent, trace.wrapSpanContext(operation.reference)), false),
  );
  try {
    const response = await context.with(active, () => handler(operation));
    operation.completed(response.status);
    return response;
  } catch (error) {
    operation.failed();
    throw error;
  }
}
