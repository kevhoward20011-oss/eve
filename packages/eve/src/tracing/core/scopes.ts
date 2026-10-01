import { createTraceEngine, type TraceOperation } from "#tracing/core/engine.js";
import { identityAttributes, usageAttributes } from "#tracing/core/attributes.js";
import {
  activationAttributes,
  actionAttributes,
  approvalAttributes,
  stepAttributes,
  modelAttributes,
  toolAttributes,
  memoryAttributes,
  invocationName,
  modelName,
  toolName,
  SPAN_NAMES,
  CONTENT_FIELDS,
  applyAttributes,
  type ChannelMetadata,
  type PrincipalMetadata,
} from "#tracing/core/contract.js";
import {
  modelInputAttributes,
  modelResultAttributes,
  type ContentSerializer,
} from "#tracing/core/model.js";
import type {
  Attributes,
  CaptureDecision,
  DurableTraceBackend,
  FrameworkIdentity,
  PreparedSpan,
  RunIdentity,
  TraceBackend,
  TraceLink,
  TraceReference,
  Usage,
} from "#tracing/core/types.js";
import type { ActionKind } from "#tracing/core/types.js";
import { gatewayCostAttributes } from "#tracing/core/gateway.js";
import type { ScopeCost } from "#tracing/core/scope-lifecycle.js";
import {
  completeScope,
  capturedScopeData as capturedData,
} from "#tracing/core/scope-completion.js";
import { topologyScope } from "#tracing/core/topology.js";
export { scopeRuntime } from "#tracing/core/topology.js";

export interface ScopeIdentity extends RunIdentity {
  readonly agentName?: string;
  readonly framework: FrameworkIdentity;
}

export interface TurnMetadata {
  readonly sequence: number;
  readonly subagent?: boolean;
  readonly subagentName?: string;
  readonly parentCallId?: string;
  readonly parentRunId?: string;
  readonly channel?: ChannelMetadata;
  readonly audience?: string;
  readonly title?: string;
  readonly scheduleId?: string;
  readonly currentPrincipal?: PrincipalMetadata;
  readonly initiatorPrincipal?: PrincipalMetadata;
  readonly delivery?: {
    readonly id: string;
    readonly input?: unknown;
    readonly channelName: string;
    readonly requestId?: string;
  };
}

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
export type ModelResult = Parameters<typeof modelResultAttributes>[0];
export interface MemoryResult<T> {
  readonly value: T;
  readonly recordCount?: number;
  readonly records?: readonly { id?: string; content: string }[];
}

export interface TurnScope {
  step<T>(options: StepOptions, execute: (step: StepScope) => Promise<T>): Promise<T>;
  memory<T>(options: MemoryOptions, execute: () => Promise<MemoryResult<T>>): Promise<T>;
}
export interface StepScope {
  model<T>(
    options: ModelOptions,
    execute: () => Promise<T>,
    result?: (value: T) => ModelResult,
  ): Promise<T>;
  action<T>(options: ActionOptions, execute: (action: ActionScope) => Promise<T>): Promise<T>;
  memory<T>(options: MemoryOptions, execute: () => Promise<MemoryResult<T>>): Promise<T>;
}
export interface ActionScope {
  tool<T>(execute: () => Promise<T>): Promise<T>;
  approval<T>(
    options: ApprovalOptions,
    execute: () => Promise<T>,
    outcome?: (value: T) => "approved" | "denied" | "cancelled",
  ): Promise<T>;
  memory<T>(options: MemoryOptions, execute: () => Promise<MemoryResult<T>>): Promise<T>;
}

export type ScopeData =
  | { readonly type: "activation"; readonly options: TurnMetadata }
  | { readonly type: "step"; readonly options: StepOptions }
  | { readonly type: "model"; readonly options: ModelOptions }
  | { readonly type: "action"; readonly options: ActionOptions }
  | {
      readonly type: "tool";
      readonly options: {
        readonly callId: string;
        readonly name: string;
        readonly arguments?: unknown;
      };
    }
  | {
      readonly type: "approval";
      readonly options: ApprovalOptions & { readonly callId: string; readonly actionName: string };
    }
  | { readonly type: "memory"; readonly options: MemoryOptions };

/** Runtime-owned state. Authoring scopes never expose a checkpoint or raw span. */
export interface ScopeRecord {
  readonly key: string;
  readonly identity: ScopeIdentity;
  readonly data: ScopeData;
  readonly reference: TraceReference;
  readonly parent?: TraceReference;
  readonly attempt?: { readonly index: number; readonly attempt: number };
  readonly capture: CaptureDecision;
  readonly startTimeMs: number;
  readonly links?: readonly TraceLink[];
  readonly usage?: { readonly inputTokens?: number; readonly outputTokens?: number };
  readonly childIndex?: number;
  readonly stepIndex?: number;
  readonly outputContext?: Readonly<Record<string, string>>;
  readonly content?: { readonly recordInputs: boolean; readonly recordOutputs: boolean };
}

export interface TraceCheckpointer {
  load(key: string): Promise<ScopeRecord | undefined>;
  save(record: ScopeRecord): Promise<void>;
  remove(key: string): Promise<void>;
}

export type { RuntimeBinding, ScopeTerminal } from "#tracing/core/scope-lifecycle.js";
import type { RuntimeBinding, ScopeTerminal } from "#tracing/core/scope-lifecycle.js";

export interface RuntimeScope {
  readonly type: ScopeData["type"];
  readonly reference: TraceReference;
  readonly finished: boolean;
  readonly capture: CaptureDecision;
  readonly authoring: TurnScope | StepScope | ActionScope;
  step(options: StepOptions, binding?: RuntimeBinding): Promise<RuntimeScope>;
  model(options: ModelOptions, binding?: RuntimeBinding): Promise<RuntimeScope>;
  action(options: ActionOptions, binding?: RuntimeBinding): Promise<RuntimeScope>;
  tool(binding?: RuntimeBinding): Promise<RuntimeScope>;
  approval(options: ApprovalOptions, binding?: RuntimeBinding): Promise<RuntimeScope>;
  memory(options: MemoryOptions, binding?: RuntimeBinding): Promise<RuntimeScope>;
  run<T>(execute: () => T): T;
  finish(result?: ScopeTerminal): Promise<void>;
  started(): Promise<void>;
  completed(result?: ScopeTerminal): Promise<void>;
  failed(error: unknown): Promise<void>;
  abandon(): void;
  usage(usage: Usage): Promise<void>;
  nextStep(): number;
  modelSelected(modelId: string, provider: string): void;
  error(error?: unknown, errorType?: string): void;
  cost(cost: ScopeCost): void;
  annotate(attributes: Attributes): void;
}

export function createTraceLifecycle(input: {
  readonly backend: TraceBackend;
  readonly serializer: ContentSerializer;
  readonly checkpointer?: TraceCheckpointer;
  readonly diagnostic?: (code: string) => void;
  readonly mapIdentity?: (identity: ScopeIdentity) => Attributes;
}) {
  const engine = createTraceEngine(input);
  let counter = 0;
  const scopeLimit = 10_000;

  async function construct(
    identity: ScopeIdentity,
    capture: CaptureDecision,
    data: ScopeData,
    parent: RuntimeScope | undefined,
    attempt: ScopeRecord["attempt"],
    binding?: RuntimeBinding,
  ): Promise<RuntimeScope> {
    const key = binding?.key ?? `${identity.runId}:${identity.turnId}:${counter++}`;
    const saved = input.checkpointer === undefined ? undefined : await input.checkpointer.load(key);
    if (
      saved !== undefined &&
      (saved.identity.runId !== identity.runId ||
        saved.identity.turnId !== identity.turnId ||
        saved.data.type !== data.type)
    ) {
      throw new Error("The persisted trace scope does not match the operation identity.");
    }
    let record = saved;
    const startTimeMs = saved?.startTimeMs ?? binding?.startTimeMs ?? Date.now();
    const parentReference = saved?.parent ?? parent?.reference ?? binding?.parent;
    const actualIdentity = saved?.identity ?? identity;
    const actualCapture =
      saved === undefined
        ? capture
        : {
            emit: capture.emit && saved.capture.emit,
            recordInputs: capture.recordInputs && saved.capture.recordInputs,
            recordOutputs: capture.recordOutputs && saved.capture.recordOutputs,
          };
    const actualData = capturedData(saved?.data ?? data, actualCapture);
    const actualAttempt = saved?.attempt ?? attempt;
    const links = saved?.links ?? binding?.links;
    let prepared = prepare(
      actualIdentity,
      actualData,
      actualAttempt,
      actualCapture,
      key,
      parentReference,
      startTimeMs,
      links,
    );
    prepared = { ...prepared, outputContext: saved?.outputContext ?? binding?.outputContext };
    const content = saved?.content ?? binding?.content;
    if (actualData.type === "activation" && content !== undefined) {
      prepared = {
        ...prepared,
        attributes: {
          ...prepared.attributes,
          "agent.trace.content.input": content.recordInputs,
          "agent.trace.content.output": content.recordOutputs,
        },
      };
    }
    const durable = input.backend as Partial<DurableTraceBackend>;
    const deferred = binding?.deferred === true || input.checkpointer !== undefined;
    let reference = saved?.reference ?? binding?.reference;
    if (deferred && reference === undefined) {
      if (durable.reserveActivation === undefined || durable.reserveChild === undefined)
        throw new Error("Checkpointed trace scopes require reserved-ID backend support.");
      reference =
        data.type === "activation"
          ? durable.reserveActivation({ key, span: prepared, capture: actualCapture })
          : parentReference === undefined
            ? undefined
            : durable.reserveChild(parentReference, key);
    }
    let operation: TraceOperation | undefined = deferred
      ? undefined
      : reference === undefined
        ? engine.start(prepared, actualCapture, binding?.executionContext)
        : engine.startReserved(prepared, reference, actualCapture, binding?.executionContext);
    reference ??= operation?.reference;
    if (reference === undefined)
      throw new Error("A child trace scope requires its constructed parent.");
    const retainedReference = reference;
    record ??= {
      key,
      identity: actualIdentity,
      data: capturedData(actualData, actualCapture),
      capture: actualCapture,
      reference: retainedReference,
      parent: parentReference,
      attempt: actualAttempt,
      startTimeMs,
      links,
      outputContext: binding?.outputContext,
      content,
    };
    if (input.checkpointer !== undefined && saved === undefined)
      await input.checkpointer.save(record);
    let finished = false;
    let started = false;
    const children = new Set<RuntimeScope>();
    let totalInput = saved?.usage?.inputTokens;
    let totalOutput = saved?.usage?.outputTokens;
    let stepIndex = saved?.stepIndex ?? 0;
    let childIndex = saved?.childIndex ?? 0;
    let pendingError: { error?: unknown; errorType?: string } | undefined;
    let authoring: TurnScope | StepScope | ActionScope;
    function requireParent(types: readonly ScopeData["type"][]): void {
      if (finished || !types.includes(actualData.type))
        throw new Error("The operation is not permitted in this trace scope.");
    }
    async function child(
      childData: ScopeData,
      childBinding?: RuntimeBinding,
    ): Promise<RuntimeScope> {
      if (children.size >= scopeLimit) {
        for (const previous of children) if (previous.finished) children.delete(previous);
        if (children.size >= scopeLimit)
          throw new Error("The trace scope has too many unfinished child operations.");
      }
      const nextAttempt =
        childData.type === "step"
          ? { index: childData.options.index, attempt: childData.options.attempt ?? 0 }
          : actualAttempt;
      const next = await construct(actualIdentity, actualCapture, childData, runtime, nextAttempt, {
        ...(childBinding ?? { key: `${key}:${childData.type}:${childIndex++}` }),
        outputContext:
          childBinding?.outputContext ?? record?.outputContext ?? binding?.outputContext,
      });
      if (input.checkpointer !== undefined) {
        record = { ...record!, childIndex, stepIndex };
        await input.checkpointer.save(record);
      }
      if (childData.type === "model")
        runtime.modelSelected(childData.options.modelId, childData.options.provider);
      children.add(next);
      return next;
    }
    const runtime: RuntimeScope = {
      type: actualData.type,
      reference: retainedReference,
      get authoring() {
        return authoring;
      },
      capture: actualCapture,
      get finished() {
        return finished;
      },
      step(options, childBinding) {
        requireParent(["activation"]);
        return child({ type: "step", options }, childBinding);
      },
      model(options, childBinding) {
        requireParent(["step"]);
        return child({ type: "model", options }, childBinding);
      },
      action(options, childBinding) {
        requireParent(["step"]);
        return child({ type: "action", options }, childBinding);
      },
      tool(childBinding) {
        requireParent(["action"]);
        if (actualData.type !== "action") throw new Error("A tool requires an action scope.");
        return child(
          {
            type: "tool",
            options: {
              callId: actualData.options.callId,
              name: actualData.options.name,
              arguments: actualData.options.arguments,
            },
          },
          childBinding,
        );
      },
      approval(options, childBinding) {
        requireParent(["action"]);
        if (actualData.type !== "action") throw new Error("An approval requires an action scope.");
        return child(
          {
            type: "approval",
            options: {
              ...options,
              callId: actualData.options.callId,
              actionName: actualData.options.name,
            },
          },
          childBinding,
        );
      },
      memory(options, childBinding) {
        requireParent(["activation", "step", "action", "tool"]);
        return child({ type: "memory", options }, childBinding);
      },
      run(execute) {
        if (finished) throw new Error("The trace scope has already finished.");
        if (operation !== undefined) return operation.run(execute);
        let entered = false;
        try {
          return input.backend.run(
            retainedReference,
            actualCapture,
            () => {
              entered = true;
              return execute();
            },
            binding?.executionContext,
          );
        } catch (error) {
          if (entered) throw error;
          return execute();
        }
      },
      async finish(result = {}) {
        if (finished) return;
        finished = true;
        // Deferred children belong to the runtime scheduler, not this callback lifetime.
        for (const next of children)
          if (!next.finished && !deferred)
            await next.finish({ failed: result.failed, error: result.error, outcome: "abandoned" });
        operation ??= engine.startReserved(
          prepared,
          retainedReference,
          actualCapture,
          binding?.executionContext,
        );
        const terminal =
          actualData.type === "activation" && result.usage === undefined
            ? { ...result, usage: { inputTokens: totalInput, outputTokens: totalOutput } }
            : result;
        completeScope(
          operation,
          actualData,
          terminal,
          actualCapture,
          startTimeMs,
          input.serializer,
        );
        if (pendingError !== undefined) operation.fail(pendingError.error, pendingError.errorType);
        if (actualData.type === "model" && result.model !== undefined)
          await parent?.usage(result.model.usage);
        operation.end(result.endTimeMs);
        if (input.checkpointer !== undefined) await input.checkpointer.remove(key);
      },
      async started() {
        if (finished || started) return;
        started = true;
        if (operation !== undefined && actualData.type === "step")
          operation.addEvent("step.started", undefined, startTimeMs);
      },
      completed(result = {}) {
        return runtime.finish({ ...result, failed: false });
      },
      failed(error) {
        return runtime.finish({ failed: true, error, outcome: "failed" });
      },
      abandon() {
        if (finished) return;
        finished = true;
        operation?.end();
      },
      async usage(usage) {
        if (operation !== undefined) applyAttributes(operation, usageAttributes(usage));
        if (usage.inputTokens !== undefined) totalInput = (totalInput ?? 0) + usage.inputTokens;
        if (usage.outputTokens !== undefined) totalOutput = (totalOutput ?? 0) + usage.outputTokens;
        if (input.checkpointer !== undefined) {
          record = { ...record!, usage: { inputTokens: totalInput, outputTokens: totalOutput } };
          await input.checkpointer.save(record);
        }
        await parent?.usage(usage);
      },
      nextStep() {
        return stepIndex++;
      },
      modelSelected(modelId, provider) {
        if (operation !== undefined)
          applyAttributes(operation, {
            "agent.model.id": modelId,
            "agent.model.provider": provider,
          });
      },
      cost(cost) {
        if (operation !== undefined) applyAttributes(operation, gatewayCostAttributes(cost));
      },
      annotate(attributes) {
        if (operation !== undefined) applyAttributes(operation, attributes);
      },
      error(error, errorType) {
        pendingError = { error: actualCapture.recordOutputs ? error : undefined, errorType };
        if (operation !== undefined) operation.fail(pendingError.error, errorType);
      },
    };
    authoring = topologyScope(runtime);
    await runtime.started();
    return runtime;
  }

  function prepare(
    identity: ScopeIdentity,
    data: ScopeData,
    attempt: ScopeRecord["attempt"],
    capture: CaptureDecision,
    key: string,
    parent: TraceReference | undefined,
    startTimeMs: number,
    links?: readonly TraceLink[],
  ): PreparedSpan {
    const shared = input.mapIdentity?.(identity) ?? identityAttributes(identity);
    const attempted = {
      turnId: identity.turnId,
      index: attempt?.index ?? 0,
      attempt: attempt?.attempt ?? 0,
    };
    let name: string;
    let attributes: Attributes;
    let kind: PreparedSpan["kind"] = "INTERNAL";
    switch (data.type) {
      case "activation": {
        name = invocationName(identity.agentName);
        const options = data.options;
        attributes = activationAttributes({
          ...options,
          identity: shared,
          framework: identity.framework,
          agentName: identity.agentName,
          turnId: identity.turnId,
          channel: options.channel ?? {},
          subagent: options.subagent ?? false,
          recordInputs: capture.recordInputs,
          recordOutputs: capture.recordOutputs,
          title: capture.recordInputs ? options.title : undefined,
          delivery:
            options.delivery === undefined
              ? undefined
              : {
                  ...options.delivery,
                  input: capture.recordInputs
                    ? input.serializer.json(options.delivery.input)
                    : undefined,
                },
        });
        break;
      }
      case "step":
        name = SPAN_NAMES.step;
        attributes = stepAttributes({
          ...data.options,
          identity: shared,
          framework: identity.framework,
          agentName: identity.agentName,
          attempt: attempted,
        });
        break;
      case "model":
        name = modelName(data.options.modelId);
        kind = "CLIENT";
        attributes = {
          ...modelAttributes({ ...data.options, identity: shared, agentName: identity.agentName }),
          ...(capture.recordInputs && data.options.messages !== undefined
            ? modelInputAttributes(
                { messages: data.options.messages, instructions: data.options.instructions },
                input.serializer,
              )
            : undefined),
        };
        break;
      case "action":
        name = SPAN_NAMES.action;
        kind = data.options.kind === "remote-agent-call" ? "CLIENT" : "INTERNAL";
        attributes = actionAttributes({
          ...data.options,
          kind: data.options.kind ?? "tool-call",
          identity: shared,
          framework: identity.framework,
          attempt: attempted,
        });
        break;
      case "tool":
        name = toolName(data.options.name);
        attributes = toolAttributes({
          ...data.options,
          identity: shared,
          agentName: identity.agentName,
        });
        break;
      case "approval":
        name = SPAN_NAMES.approval;
        attributes = approvalAttributes({
          ...data.options,
          identity: shared,
          framework: identity.framework,
          attempt: attempted,
        });
        break;
      case "memory":
        name = data.options.operation;
        kind = "CLIENT";
        attributes = memoryAttributes({
          ...data.options,
          identity: shared,
          turnId: identity.turnId,
        });
        break;
    }
    const payload: Record<string, Attributes[string]> = {};
    if (capture.recordInputs) {
      if (
        data.type === "action" &&
        data.options.kind !== "subagent-call" &&
        data.options.kind !== "remote-agent-call"
      )
        payload[CONTENT_FIELDS.toolArguments] = input.serializer.json(data.options.arguments);
      if (data.type === "tool")
        payload[CONTENT_FIELDS.toolArguments] = input.serializer.json(data.options.arguments);
      if (data.type === "approval")
        payload[CONTENT_FIELDS.approvalRequest] = input.serializer.json(data.options.request);
    }
    return {
      type: data.type,
      operationId: key,
      name,
      kind,
      attributes: { ...attributes, ...payload },
      parent,
      root: data.type === "activation",
      startTimeMs,
      links,
    };
  }

  return {
    resolve(
      record: ScopeRecord,
      options: {
        readonly deferred?: boolean;
        readonly executionContext?: import("#tracing/core/types.js").ExecutionContext;
      } = {},
    ) {
      return construct(record.identity, record.capture, record.data, undefined, record.attempt, {
        key: record.key,
        reference: record.reference,
        parent: record.parent,
        startTimeMs: record.startTimeMs,
        links: record.links,
        outputContext: record.outputContext,
        content: record.content,
        deferred: options.deferred,
        executionContext: options.executionContext,
      });
    },
    turn(
      identity: ScopeIdentity,
      options: TurnMetadata,
      capture: CaptureDecision,
      binding?: RuntimeBinding,
    ) {
      return construct(
        identity,
        capture,
        { type: "activation", options },
        undefined,
        undefined,
        binding,
      );
    },
    bind(
      identity: ScopeIdentity,
      data: ScopeData,
      capture: CaptureDecision,
      binding: RuntimeBinding,
      attempt?: ScopeRecord["attempt"],
    ) {
      return construct(identity, capture, data, undefined, attempt, binding);
    },
    async restore(key: string, capture: CaptureDecision): Promise<RuntimeScope | undefined> {
      if (input.checkpointer === undefined)
        throw new Error("Scope restoration requires a runtime checkpointer.");
      const record = await input.checkpointer.load(key);
      if (record === undefined) return undefined;
      return construct(record.identity, capture, record.data, undefined, record.attempt, {
        key,
        deferred: true,
        parent: record.parent,
      });
    },
  };
}
