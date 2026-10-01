import { createTraceEngine } from "#tracing/core/engine.js";
import {
  requestAttributes,
  requestStatusAttributes,
  mcpAttributes,
  mcpName,
  applyAttributes,
  SPAN_NAMES,
} from "#tracing/core/contract.js";
import type {
  Attributes,
  CaptureDecision,
  TraceBackend,
  TraceReference,
} from "#tracing/core/types.js";

export function createTransportTracing(backend: TraceBackend) {
  const engine = createTraceEngine({ backend });
  return {
    async request<T extends { status: number }>(
      input: {
        method: string;
        route: string;
        parent?: TraceReference;
        scheme?: string;
        serverAddress?: string;
        channelName?: string;
        channelKind?: string;
      },
      execute: () => Promise<T>,
    ): Promise<T> {
      const capture = { emit: true, recordInputs: false, recordOutputs: false };
      const operation = engine.start(
        {
          type: "channelRequest",
          operationId: `${input.method} ${input.route}`,
          name: SPAN_NAMES.channelRequest,
          kind: "SERVER",
          parent: input.parent,
          attributes: requestAttributes(input),
        },
        capture,
      );
      try {
        const response = await operation.run(execute);
        applyAttributes(operation, requestStatusAttributes(response.status));
        if (response.status >= 500) operation.setStatus("ERROR");
        return response;
      } catch (error) {
        operation.setStatus("ERROR");
        throw error;
      } finally {
        operation.end();
      }
    },
    async mcp<T>(
      input: {
        method: "tools/list" | "tools/call";
        connectionName: string;
        toolName?: string;
        protocolVersion?: string;
        parent?: TraceReference;
        capture: CaptureDecision;
        attributes?: Attributes;
      },
      execute: () => Promise<T>,
    ): Promise<T> {
      const operation = engine.start(
        {
          type: "mcp",
          operationId: `${input.connectionName}:${input.method}`,
          name: mcpName(input.method, input.toolName),
          kind: "CLIENT",
          parent: input.parent,
          attributes: { ...input.attributes, ...mcpAttributes(input) },
        },
        input.capture,
      );
      try {
        return await operation.run(execute);
      } catch (error) {
        operation.fail(error);
        throw error;
      } finally {
        operation.end();
      }
    },
  };
}
