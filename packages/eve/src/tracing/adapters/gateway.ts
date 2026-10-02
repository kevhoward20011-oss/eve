/** Converts provider metadata to semantic cost data for the lifecycle DSL. */
export function readGatewayCostData(
  providerMetadata: Readonly<Record<string, unknown>> | undefined,
) {
  if (providerMetadata === undefined) return undefined;
  const gateway = providerMetadata.gateway;
  if (typeof gateway !== "object" || gateway === null || Array.isArray(gateway)) return undefined;
  const data = gateway as Record<string, unknown>;
  return {
    cost: readUsd(data.cost),
    gatewayCost: readUsd(data.gatewayCost),
    inputCost: readUsd(data.inputInferenceCost),
    outputCost: readUsd(data.outputInferenceCost),
    generationId:
      typeof data.generationId === "string" && data.generationId.length > 0
        ? data.generationId
        : undefined,
  };
}

function readUsd(value: unknown): number | undefined {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
