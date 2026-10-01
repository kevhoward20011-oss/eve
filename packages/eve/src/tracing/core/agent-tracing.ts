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

export interface TurnInput extends RunIdentity {
  readonly sequence: number;
  readonly caller?: TraceReference;
  readonly request?: TraceReference;
  readonly signal?: AbortSignal;
  readonly activation?: TurnMetadata;
}
export type ActivationMetadata = TurnMetadata;
export type { TurnScope } from "#tracing/core/scopes.js";

export function createAgentTracing(input: {
  readonly agentName: string;
  readonly framework: FrameworkIdentity;
  readonly backend: TraceBackend;
  readonly serializer: ContentSerializer;
  readonly checkpointer?: TraceCheckpointer;
  readonly content?: { readonly recordInputs: boolean; readonly recordOutputs: boolean };
  readonly diagnostic?: (code: string) => void;
}) {
  const runtime = createTraceLifecycle(input);
  return {
    lifecycle: runtime,
    async turn<T>(turn: TurnInput, execute: (scope: TurnScope) => Promise<T>): Promise<T> {
      const links: TraceLink[] = [];
      if (turn.sequence === 0 && turn.caller !== undefined)
        links.push({ context: turn.caller, relationship: "agent.dispatch" });
      if (turn.request !== undefined)
        links.push({ context: turn.request, relationship: "channel.request" });
      const scope = await runtime.turn(
        { ...turn, agentName: input.agentName, framework: input.framework },
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
