import { createTraceEngine } from "#tracing/core/engine.js";
import {
  requestAttributes,
  requestStatusAttributes,
  channelRequestMetadata,
  mcpAttributes,
  mcpName,
  applyAttributes,
  SPAN_NAMES,
} from "#tracing/core/contract.js";
import type {
  CaptureDecision,
  ExecutionContext,
  TraceBackend,
  TraceReference,
} from "#tracing/core/types.js";
import { mcpLifecycle } from "#tracing/core/mcp.js";
import type { ContentSerializer } from "#tracing/core/model.js";

export function createTransportLifecycle(backend: TraceBackend, serializer: ContentSerializer) {
  const engine = createTraceEngine({ backend });
  return {
    request(input: {
      method: string;
      route: string;
      scheme?: string;
      serverAddress?: string;
      parent?: TraceReference;
      executionContext?: ExecutionContext;
    }) {
      const operation = engine.start(
        {
          type: "channelRequest",
          operationId: `${input.method} ${input.route}`,
          name: SPAN_NAMES.channelRequest,
          kind: "SERVER",
          parent: input.parent,
          attributes: requestAttributes(input),
        },
        { emit: true, recordInputs: false, recordOutputs: false },
        input.executionContext,
      );
      return {
        reference: operation.reference,
        run: operation.run,
        channel(input: { channelName?: string; channelKind?: string }) {
          applyAttributes(operation, channelRequestMetadata(input));
        },
        completed(status: number) {
          applyAttributes(operation, requestStatusAttributes(status));
          if (status >= 500) operation.setStatus("ERROR");
          operation.end();
        },
        failed() {
          operation.setStatus("ERROR");
          operation.end();
        },
      };
    },
    mcp(input: {
      method: "tools/list" | "tools/call";
      connectionName: string;
      toolName?: string;
      protocolVersion?: string;
      parent?: TraceReference;
      executionContext?: ExecutionContext;
      capture: CaptureDecision;
    }) {
      const operation = engine.start(
        {
          type: "mcp",
          operationId: `${input.connectionName}:${input.method}`,
          name: mcpName(input.method, input.toolName),
          kind: "CLIENT",
          parent: input.parent,
          attributes: mcpAttributes(input),
        },
        input.capture,
        input.executionContext,
      );
      const semantic = mcpLifecycle({
        serializer,
        ...input.capture,
        write: (attributes) => applyAttributes(operation, attributes),
        error: operation.fail,
      });
      return {
        reference: operation.reference,
        run: operation.run,
        ...semantic,
        completed(result?: unknown) {
          if (result !== undefined) semantic.result(result);
          operation.end();
        },
        failed(error?: unknown, type?: string) {
          semantic.error(error, type);
          operation.end();
        },
        end: operation.end,
      };
    },
  };
}
