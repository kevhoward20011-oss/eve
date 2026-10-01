import type { Telemetry, TelemetryOptions } from "ai";
import { scopeRuntime, type RuntimeScope, type TurnScope } from "#tracing/core/scopes.js";
import type { ContentPart } from "#tracing/core/types.js";

type Event<K extends keyof Telemetry> = Parameters<NonNullable<Telemetry[K]>>[0];

/** SDK hooks construct the same scopes as the callback DSL. */
export function aiSdkTracing(
  turn: TurnScope,
  options: { readonly integrations?: readonly Telemetry[] } = {},
): TelemetryOptions {
  const activation = scopeRuntime(turn);
  let step: RuntimeScope | undefined;
  const models = new Map<string, RuntimeScope>();
  const starts = new Map<string, Event<"onLanguageModelCallStart">>();
  const tools = new Map<string, { action: RuntimeScope; tool: RuntimeScope }>();
  async function model(event: Event<"onLanguageModelCallStart">) {
    if (step === undefined || step.finished) return undefined;
    const next = await step.model({
      provider: event.provider,
      modelId: event.modelId,
      messages: event.messages,
      instructions: event.instructions,
    });
    models.set(event.callId, next);
    return next;
  }
  async function drain(error?: unknown, cancelled = false) {
    for (const operation of models.values())
      await operation.finish({ failed: error !== undefined, error });
    for (const { tool, action } of tools.values()) {
      await tool.finish({ failed: error !== undefined, error });
      await action.finish({
        outcome: cancelled ? "cancelled" : error === undefined ? "abandoned" : "failed",
        failed: error !== undefined,
        error,
      });
    }
    models.clear();
    starts.clear();
    tools.clear();
    await step?.finish({ failed: error !== undefined, error });
  }
  const integration: Telemetry = {
    async onStepStart() {
      if (step !== undefined) await drain();
      step = await activation.step({ index: activation.nextStep() });
    },
    async onLanguageModelCallStart(event) {
      const projected = {
        ...event,
        messages: activation.capture.recordInputs ? event.messages : [],
        instructions: activation.capture.recordInputs ? event.instructions : undefined,
      };
      starts.set(event.callId, projected);
      await model(projected);
    },
    async executeLanguageModelCall({ callId, execute }) {
      let active = models.get(callId);
      if (active === undefined && starts.has(callId)) active = await model(starts.get(callId)!);
      try {
        return await (active === undefined ? execute() : active.run(execute));
      } catch (error) {
        models.delete(callId);
        await active?.finish({ failed: true, error });
        throw error;
      }
    },
    async onLanguageModelCallEnd(event) {
      const active = models.get(event.callId);
      models.delete(event.callId);
      starts.delete(event.callId);
      await active?.finish({
        model: {
          usage: {
            inputTokens: event.usage.inputTokens,
            outputTokens: event.usage.outputTokens,
            inputTokenDetails: {
              cacheReadTokens: event.usage.inputTokenDetails?.cacheReadTokens,
              cacheWriteTokens: event.usage.inputTokenDetails?.cacheWriteTokens,
            },
          },
          responseId: event.responseId,
          responseModelId: event.modelId,
          finishReason: event.finishReason,
          content: activation.capture.recordOutputs ? contentParts(event.content) : undefined,
        },
      });
    },
    async onToolExecutionStart(event) {
      if (step === undefined || step.finished) return;
      const call = event.toolCall;
      const action = await step.action({
        callId: call.toolCallId,
        name: call.toolName,
        arguments: call.input,
      });
      tools.set(call.toolCallId, { action, tool: await action.tool() });
    },
    executeTool({ toolCallId, execute }) {
      const active = tools.get(toolCallId)?.tool;
      return active === undefined ? execute() : active.run(execute);
    },
    async onToolExecutionEnd(event) {
      const active = tools.get(event.toolCall.toolCallId);
      tools.delete(event.toolCall.toolCallId);
      if (active === undefined) return;
      const terminal =
        event.toolOutput.type === "tool-result"
          ? { output: event.toolOutput.output }
          : { failed: true, error: event.toolOutput.error };
      await active.tool.finish(terminal);
      await active.action.finish(terminal);
    },
    async onStepEnd(event) {
      const gateway = event.providerMetadata?.gateway;
      if (gateway !== undefined && typeof gateway === "object" && gateway !== null) {
        const data = gateway as Record<string, unknown>;
        const number = (value: unknown) => {
          if (typeof value !== "string" || value.trim() === "") return undefined;
          const parsed = Number(value);
          return Number.isFinite(parsed) ? parsed : undefined;
        };
        step?.cost({
          cost: number(data.cost),
          gatewayCost: number(data.gatewayCost),
          inputCost: number(data.inputInferenceCost),
          outputCost: number(data.outputInferenceCost),
          generationId: typeof data.generationId === "string" ? data.generationId : undefined,
        });
      }
      await drain();
    },
    async onAbort() {
      await drain(undefined, true);
    },
    async onError(event) {
      await drain((event as { error: unknown }).error);
    },
    async onEnd() {
      await drain();
    },
  };
  return {
    isEnabled: true,
    recordInputs: activation.capture.recordInputs,
    recordOutputs: activation.capture.recordOutputs,
    integrations: [integration, ...(options.integrations ?? [])],
  };
}

function contentParts(content: Event<"onLanguageModelCallEnd">["content"]): readonly ContentPart[] {
  return content.flatMap((part): ContentPart[] => {
    switch (part.type) {
      case "text":
      case "reasoning":
        return [{ type: part.type, text: part.text }];
      case "tool-call":
        return [
          {
            type: "tool-call",
            callId: part.toolCallId,
            toolName: part.toolName,
            input: part.input,
          },
        ];
      case "tool-result":
        return [
          {
            type: "tool-result",
            callId: part.toolCallId,
            toolName: part.toolName,
            input: part.input,
            output: part.output,
          },
        ];
      case "tool-error":
        return [
          {
            type: "tool-error",
            callId: part.toolCallId,
            toolName: part.toolName,
            input: part.input,
            error: part.error,
          },
        ];
      default:
        return [];
    }
  });
}
