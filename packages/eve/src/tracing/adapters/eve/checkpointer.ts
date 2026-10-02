import type { ScopeData, ScopeRecord } from "#tracing/core/scopes.js";
import type { TraceLink, TraceReference } from "#tracing/core/types.js";
import { resolveConversationId } from "#shared/conversation-identity.js";
export function traceSessionIdOf(scope: {
  readonly traceSessionId?: string;
  readonly rootSessionId?: string;
  readonly sessionId: string;
}): string {
  return scope.traceSessionId ?? scope.rootSessionId ?? scope.sessionId;
}

export function checkpointContent(value: string | undefined): unknown {
  if (value === undefined) return undefined;
  // Historical checkpoints contain truncated JSON; omit payloads, not the operation.
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

/** Converts existing workflow checkpoint records; does not create another state owner. */
export function eveScopeRecord(
  input: {
    readonly sessionId: string;
    readonly rootSessionId?: string;
    readonly traceSessionId?: string;
    readonly turnId: string;
    readonly frameworkVersion: string;
    readonly agentName?: string;
    readonly functionId?: string;
    readonly reference: TraceReference;
    readonly parent?: TraceReference;
    readonly startTimeMs?: number;
    readonly stepIndex?: number;
    readonly attemptIndex?: number;
    readonly links?: readonly TraceLink[];
    readonly content?: { readonly recordInputs: boolean; readonly recordOutputs: boolean };
  },
  key: string,
  data: ScopeData,
): ScopeRecord {
  return {
    key,
    data,
    identity: {
      conversationId: resolveConversationId(input.rootSessionId ?? input.sessionId),
      runId: input.sessionId,
      turnId: input.turnId,
      agentName: input.agentName ?? input.functionId,
      framework: { name: "eve", version: input.frameworkVersion },
    },
    reference: input.reference,
    parent: input.parent,
    startTimeMs: input.startTimeMs ?? Date.now(),
    attempt: { index: input.stepIndex ?? 0, attempt: input.attemptIndex ?? 0 },
    capture: {
      emit: (input.reference.traceFlags & 1) !== 0,
      recordInputs: true,
      recordOutputs: true,
    },
    links: input.links,
    content: input.content,
    outputContext: {
      traceSessionId: traceSessionIdOf(input),
      platform: process.env.VERCEL_ENV === undefined ? "other" : "vercel",
    },
  };
}
