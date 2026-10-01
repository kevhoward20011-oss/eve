import type { ExecutionContext, TraceReference, TraceLink, Usage } from "#tracing/core/types.js";
import type { ModelResult } from "#tracing/core/scopes.js";

export interface ScopeCost {
  readonly cost?: number;
  readonly gatewayCost?: number;
  readonly inputCost?: number;
  readonly outputCost?: number;
  readonly generationId?: string;
}

export interface RuntimeBinding {
  readonly key: string;
  readonly reference?: TraceReference;
  readonly startTimeMs?: number;
  readonly links?: readonly TraceLink[];
  readonly deferred?: boolean;
  readonly parent?: TraceReference;
  readonly content?: { readonly recordInputs: boolean; readonly recordOutputs: boolean };
  readonly executionContext?: ExecutionContext;
  readonly outputContext?: Readonly<Record<string, string>>;
}

export interface ScopeTerminal {
  readonly outcome?: string;
  readonly failed?: boolean;
  readonly error?: unknown;
  readonly errorCode?: string;
  readonly output?: unknown;
  readonly response?: unknown;
  readonly usage?: Usage;
  readonly model?: ModelResult;
  readonly recordCount?: number;
  readonly records?: readonly { id?: string; content: string }[];
  readonly endTimeMs?: number;
}
