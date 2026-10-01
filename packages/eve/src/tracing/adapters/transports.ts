import { createTransportLifecycle } from "#tracing/core/transports.js";
import type { TraceBackend } from "#tracing/core/types.js";

export function createTransportTracing(backend: TraceBackend) {
  const lifecycle = createTransportLifecycle(backend);
  return {
    async request<T extends { status: number }>(
      input: Parameters<typeof lifecycle.request>[0] & {
        channelName?: string;
        channelKind?: string;
      },
      execute: () => Promise<T>,
    ): Promise<T> {
      const operation = lifecycle.request(input);
      operation.channel(input);
      try {
        const response = await operation.run(execute);
        operation.completed(response.status);
        return response;
      } catch (error) {
        operation.failed();
        throw error;
      }
    },
    async mcp<T>(
      input: Parameters<typeof lifecycle.mcp>[0],
      execute: () => Promise<T>,
    ): Promise<T> {
      const operation = lifecycle.mcp(input);
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
