import type {
  ActionScope,
  MemoryOptions,
  MemoryResult,
  RuntimeScope,
  ScopeTerminal,
  StepScope,
  TurnScope,
} from "#tracing/core/scopes.js";

const runtimes = new WeakMap<object, RuntimeScope>();

/** Callback topology is a view over lifecycle operations, not another trace engine. */
export function topologyScope(runtime: RuntimeScope): TurnScope | StepScope | ActionScope {
  async function execute<T>(
    operation: RuntimeScope,
    callback: () => Promise<T>,
    terminal?: (value: T) => ScopeTerminal,
  ): Promise<T> {
    await operation.started();
    try {
      const value = await operation.run(callback);
      await operation.completed(terminal?.(value) ?? { output: value });
      return value;
    } catch (error) {
      await operation.failed(error);
      throw error;
    }
  }
  async function memory<T>(
    options: MemoryOptions,
    callback: () => Promise<MemoryResult<T>>,
  ): Promise<T> {
    const operation = await runtime.memory(options);
    const result = await execute(operation, callback, (value) => ({
      recordCount: value.recordCount,
      records: value.records,
    }));
    return result.value;
  }
  let scope: TurnScope | StepScope | ActionScope;
  switch (runtime.type) {
    case "activation":
      scope = {
        async step(options, callback) {
          const next = await runtime.step(options);
          return execute(next, () => callback(next.authoring as StepScope));
        },
        memory,
      };
      break;
    case "step":
      scope = {
        async model(options, callback, result) {
          const next = await runtime.model(options);
          return execute(next, callback, (value) =>
            result === undefined ? {} : { model: result(value) },
          );
        },
        async action(options, callback) {
          const next = await runtime.action(options);
          return execute(next, () => callback(next.authoring as ActionScope));
        },
        memory,
      };
      break;
    case "action":
      scope = {
        async tool(callback) {
          return execute(await runtime.tool(), callback);
        },
        async approval(options, callback, outcome) {
          return execute(await runtime.approval(options), callback, (response) => ({
            outcome: outcome?.(response) ?? "approved",
            response,
          }));
        },
        memory,
      };
      break;
    default:
      scope = { memory } as TurnScope;
  }
  runtimes.set(scope, runtime);
  return scope;
}

export function scopeRuntime(scope: TurnScope | StepScope | ActionScope): RuntimeScope {
  const runtime = runtimes.get(scope);
  if (runtime === undefined) throw new Error("The scope belongs to another tracing lifecycle.");
  return runtime;
}
