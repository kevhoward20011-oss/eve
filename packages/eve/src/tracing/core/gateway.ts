import type { Attributes } from "#tracing/core/types.js";

export function gatewayCostAttributes(input: {
  cost?: number;
  gatewayCost?: number;
  inputCost?: number;
  outputCost?: number;
  generationId?: string;
}): Attributes {
  return {
    "gen_ai.usage.cost": input.cost,
    "gen_ai.usage.gateway_cost": input.gatewayCost,
    "gen_ai.usage.input_cost": input.inputCost,
    "gen_ai.usage.output_cost": input.outputCost,
    "gen_ai.generation.id": input.generationId,
  };
}
