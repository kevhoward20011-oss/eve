import type { ExecutionContext, TraceReference, TraceLink, Usage } from "#tracing/core/types.js";
import type { ModelResult, ScopeRecord } from "#tracing/core/scopes.js";
import type { ActionKind } from "#tracing/core/types.js";
import type { ChannelMetadata } from "#tracing/core/contract.js";

export interface StepOptions {
  readonly index: number;
  readonly attempt?: number;
  readonly channel?: ChannelMetadata;
  readonly runtimeContext?: Readonly<Record<string, unknown>>;
}

export interface ModelOptions {
  readonly provider: string;
  readonly modelId: string;
  readonly messages?: readonly unknown[];
  readonly instructions?: unknown;
  readonly runtimeContext?: Readonly<Record<string, unknown>>;
}

export interface ActionOptions {
  readonly callId: string;
  readonly name: string;
  readonly kind?: ActionKind;
  readonly arguments?: unknown;
}

export interface ApprovalOptions {
  readonly requestId: string;
  readonly request?: unknown;
}

export interface MemoryOptions {
  readonly operation: "search_memory" | "upsert_memory";
  readonly phase: string;
  readonly slot: string;
  readonly storeId: string;
}

export interface TraceCheckpointer {
  load(key: string): Promise<ScopeRecord | undefined>;
  save(record: ScopeRecord): Promise<void>;
  remove(key: string): Promise<void>;
}

export interface MemoryResult<T> {
  readonly value: T;
  readonly recordCount?: number;
  readonly records?: readonly { id?: string; content: string }[];
}

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
