import type { Span } from "#compiled/@opentelemetry/api/index.js";

import type { InstrumentationUsage } from "#instrumentation/lifecycle.js";
import type { AgentTurnTraceState } from "#tracing/agent-trace-state.js";
import { usageAttributes } from "#tracing/core/attributes.js";
import { gatewayCostAttributes } from "#tracing/core/gateway.js";

/** Applies eve's structural token usage attributes to an agent span. */
export function setAgentUsage(span: Span, usage: InstrumentationUsage): void {
  for (const [key, value] of Object.entries(usageAttributes(usage))) {
    if (value !== undefined) span.setAttribute(key, value);
  }
}

/** Applies standard GenAI token usage while retaining eve's compatibility attributes. */
export function setGenAiUsage(span: Span, usage: InstrumentationUsage): void {
  for (const [key, value] of Object.entries(usageAttributes(usage, true))) {
    if (value !== undefined) span.setAttribute(key, value);
  }
}

export function setAgentInvocationUsage(
  span: Span,
  modelUsage: AgentTurnTraceState["modelUsage"],
): void {
  if (modelUsage === undefined) return;
  setGenAiUsage(span, modelUsage);
}

/** Projects Vercel AI Gateway cost metadata onto GenAI span attributes. */
export function readGatewayCost(
  providerMetadata: Readonly<Record<string, unknown>>,
): Record<string, string | number> | undefined {
  const data = readGatewayCostData(providerMetadata);
  if (data === undefined) return undefined;
  const attributes = Object.fromEntries(
    Object.entries(gatewayCostAttributes(data)).filter(([, value]) => value !== undefined),
  ) as Record<string, string | number>;
  return Object.keys(attributes).length === 0 ? undefined : attributes;
}

export function readGatewayCostData(providerMetadata: Readonly<Record<string, unknown>>) {
  const gateway = providerMetadata.gateway;
  if (!isRecord(gateway)) return undefined;
  return {
    cost: readUsd(gateway.cost),
    gatewayCost: readUsd(gateway.gatewayCost),
    inputCost: readUsd(gateway.inputInferenceCost),
    outputCost: readUsd(gateway.outputInferenceCost),
    generationId:
      typeof gateway.generationId === "string" && gateway.generationId.length > 0
        ? gateway.generationId
        : undefined,
  };
}

function readUsd(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
