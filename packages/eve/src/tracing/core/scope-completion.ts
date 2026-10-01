import type { TraceOperation } from "#tracing/core/engine.js";
import type { ScopeData, ScopeTerminal } from "#tracing/core/scopes.js";
import type { Attributes, CaptureDecision } from "#tracing/core/types.js";
import type { ContentSerializer } from "#tracing/core/model.js";
import { modelResultAttributes } from "#tracing/core/model.js";
import { usageAttributes } from "#tracing/core/attributes.js";
import {
  applyAttributes,
  terminalAttributes,
  actionErrorAttributes,
  memoryCountAttributes,
  CONTENT_FIELDS,
} from "#tracing/core/contract.js";

export function completeScope(
  operation: TraceOperation,
  data: ScopeData,
  result: ScopeTerminal,
  capture: CaptureDecision,
  startTimeMs: number,
  serializer: ContentSerializer,
): void {
  const outcome = result.outcome ?? (result.failed ? "failed" : "completed");
  applyAttributes(operation, terminalAttributes(data.type, outcome));
  if (result.usage !== undefined)
    applyAttributes(
      operation,
      usageAttributes(result.usage, data.type === "activation" || data.type === "model"),
    );
  if (data.type === "activation") {
    operation.addEvent("turn.started", undefined, startTimeMs);
    operation.addEvent(`turn.${outcome}`, undefined, result.endTimeMs);
  }
  if (data.type === "step")
    operation.addEvent(
      result.failed ? "step.failed" : "step.completed",
      undefined,
      result.endTimeMs,
    );
  if (data.type === "model" && result.model !== undefined)
    applyAttributes(
      operation,
      modelResultAttributes(result.model, serializer, capture.recordOutputs),
    );
  if (data.type === "action" && result.errorCode !== undefined)
    applyAttributes(operation, actionErrorAttributes(result.errorCode));
  if (data.type === "memory" && result.recordCount !== undefined)
    applyAttributes(operation, memoryCountAttributes(result.recordCount));
  const outputs: Record<string, Attributes[string]> = {};
  if (capture.recordOutputs) {
    if (
      (data.type === "action" &&
        data.options.kind !== "subagent-call" &&
        data.options.kind !== "remote-agent-call") ||
      data.type === "tool"
    )
      outputs[CONTENT_FIELDS.toolResult] = serializer.json(result.output);
    if (data.type === "approval")
      outputs[CONTENT_FIELDS.approvalResponse] = serializer.json(result.response);
  }
  if (capture.recordInputs && data.type === "memory")
    outputs[CONTENT_FIELDS.memoryRecords] = serializer.json(result.records);
  applyAttributes(operation, outputs);
  if (result.failed) operation.fail(result.error, result.errorCode);
}

export function capturedScopeData(data: ScopeData, capture: CaptureDecision): ScopeData {
  if (capture.emit && capture.recordInputs) return data;
  switch (data.type) {
    case "activation":
      return {
        ...data,
        options: {
          ...data.options,
          title: undefined,
          currentPrincipal:
            data.options.currentPrincipal === undefined
              ? undefined
              : { type: data.options.currentPrincipal.type },
          initiatorPrincipal:
            data.options.initiatorPrincipal === undefined
              ? undefined
              : { type: data.options.initiatorPrincipal.type },
          delivery:
            data.options.delivery === undefined
              ? undefined
              : { ...data.options.delivery, input: undefined },
        },
      };
    case "model":
      return {
        ...data,
        options: { ...data.options, messages: undefined, instructions: undefined },
      };
    case "action":
    case "tool":
      return { ...data, options: { ...data.options, arguments: undefined } };
    case "approval":
      return { ...data, options: { ...data.options, request: undefined } };
    default:
      return data;
  }
}
