import {
  createTraceLifecycle,
  type TraceCheckpointer,
  type TurnScope,
  type TurnMetadata,
} from "#tracing/core/scopes.js";
import type { ContentSerializer } from "#tracing/core/model.js";
import type {
  FrameworkIdentity,
  RunIdentity,
  TraceBackend,
  TraceLink,
  TraceReference,
} from "#tracing/core/types.js";
import { createTransportLifecycle } from "#tracing/core/transports.js";

type Integrations = Readonly<Record<string, (scope: TurnScope) => unknown>>;
export interface TracingAdapter<TIntegrations extends Integrations = Integrations> {
  readonly backend: TraceBackend;
  readonly serializer: ContentSerializer;
  readonly integrations?: TIntegrations;
}

export interface TurnInput extends RunIdentity {
  readonly sequence: number;
  readonly caller?: TraceReference;
  readonly request?: TraceReference;
  readonly signal?: AbortSignal;
  readonly activation?: TurnMetadata;
}
export type ActivationMetadata = TurnMetadata;
export type { TurnScope } from "#tracing/core/scopes.js";

export function createAgentTracing<
  TIntegrations extends Integrations = Record<never, never>,
>(input: {
  readonly agentName?: string;
  readonly framework?: FrameworkIdentity;
  readonly adapter: TracingAdapter<TIntegrations>;
  readonly checkpointer?: TraceCheckpointer;
  readonly content?: { readonly recordInputs: boolean; readonly recordOutputs: boolean };
  readonly diagnostic?: (code: string) => void;
}) {
  const runtime = createTraceLifecycle({ ...input, ...input.adapter });
  const transports = createTransportLifecycle(input.adapter.backend, input.adapter.serializer);
  return {
    lifecycle: { ...runtime, ...transports },
    integrations: input.adapter.integrations ?? ({} as TIntegrations),
    async request<T extends { status: number }>(
      options: Parameters<typeof transports.request>[0] & {
        channelName?: string;
        channelKind?: string;
      },
      execute: () => Promise<T>,
    ): Promise<T> {
      const operation = transports.request(options);
      operation.channel(options);
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
      options: Parameters<typeof transports.mcp>[0],
      execute: () => Promise<T>,
    ): Promise<T> {
      const operation = transports.mcp(options);
      try {
        const value = await operation.run(execute);
        operation.completed(value);
        return value;
      } catch (error) {
        operation.failed(error);
        throw error;
      }
    },
    async turn<T>(turn: TurnInput, execute: (scope: TurnScope) => Promise<T>): Promise<T> {
      const links: TraceLink[] = [];
      if (turn.sequence === 0 && turn.caller !== undefined)
        links.push({ context: turn.caller, relationship: "agent.dispatch" });
      if (turn.request !== undefined)
        links.push({ context: turn.request, relationship: "channel.request" });
      const scope = await runtime.turn(
        {
          ...turn,
          agentName: input.agentName,
          framework: input.framework ?? { name: "custom", version: "" },
        },
        {
          ...turn.activation,
          sequence: turn.sequence,
          subagent: turn.caller !== undefined,
        },
        {
          emit: turn.caller === undefined || (turn.caller.traceFlags & 1) !== 0,
          recordInputs: input.content?.recordInputs ?? false,
          recordOutputs: input.content?.recordOutputs ?? false,
        },
        { key: `${turn.runId}:${turn.turnId}`, links },
      );
      try {
        await scope.started();
        const result = await scope.run(() => execute(scope.authoring as TurnScope));
        await scope.completed({ outcome: turn.signal?.aborted ? "cancelled" : "completed" });
        return result;
      } catch (error) {
        await scope.finish({
          outcome: turn.signal?.aborted ? "cancelled" : "failed",
          failed: !turn.signal?.aborted,
          error,
        });
        throw error;
      }
    },
  };
}

export type AgentTracing = ReturnType<typeof createAgentTracing>;
