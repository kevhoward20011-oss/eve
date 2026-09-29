export function gatewayCallMetadata(
  providerMetadata: Readonly<Record<string, unknown>> | undefined,
): { readonly generationId?: string; readonly transcriptsEnabled?: boolean } | undefined {
  const gateway = providerMetadata?.gateway;
  if (!isRecord(gateway)) return undefined;
  const prototype = Object.getPrototypeOf(gateway);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  const metadata: { generationId?: string; transcriptsEnabled?: boolean } = {};
  if (typeof gateway.generationId === "string" && gateway.generationId.length > 0) {
    metadata.generationId = gateway.generationId;
  }
  if (isRecord(gateway.transcripts) && gateway.transcripts.enabled === true) {
    metadata.transcriptsEnabled = true;
  }
  return Object.keys(metadata).length === 0 ? undefined : Object.freeze(metadata);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
