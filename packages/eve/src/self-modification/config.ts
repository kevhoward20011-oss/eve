import type { AgentReasoningDefinition, AgentStaticModelDefinition } from "#public/index.js";

import type {
  DeployedSelfModificationConfig,
  ResolvedDeployedSelfModificationConfig,
} from "./deployed/config-schema.js";

export type {
  DeployedSelfModificationAuthorization,
  DeployedSelfModificationAuthorizationContext,
  DeployedSelfModificationConfig,
  ResolvedDeployedSelfModificationConfig,
} from "./deployed/config-schema.js";

/** Local self-modification settings shared by its bundled child and sandbox. */
export interface SelfModificationConfig {
  readonly local?: { readonly enabled?: boolean };
}

/** Values accepted by the self-modification extension mount. */
export interface SelfModificationExtensionConfig extends SelfModificationConfig {
  readonly model?: AgentStaticModelDefinition;
  readonly reasoning?: AgentReasoningDefinition;
  /** Lets the deployed agent propose source changes as draft pull requests. */
  readonly deployed?: DeployedSelfModificationConfig;
}

/** Extension configuration with defaults applied, as read through the extension handle. */
export interface ResolvedSelfModificationExtensionConfig extends SelfModificationExtensionConfig {
  readonly deployed?: ResolvedDeployedSelfModificationConfig;
}

export interface ResolvedSelfModificationConfig {
  readonly localEnabled: boolean;
}

/** Defines the local self-modification policy. */
export function defineSelfModificationConfig(
  config: SelfModificationConfig = {},
): SelfModificationConfig {
  resolveSelfModificationConfig(config);
  return config;
}

export function resolveSelfModificationConfig(
  config: SelfModificationConfig = {},
): ResolvedSelfModificationConfig {
  if (!isRecord(config)) throw new Error("Self-modification configuration must be an object.");

  const local = config.local;
  if (local !== undefined && !isRecord(local)) {
    throw new Error("Self-modification local must be an object.");
  }
  const localEnabled = local?.enabled ?? true;
  if (typeof localEnabled !== "boolean") {
    throw new Error("Self-modification local.enabled must be a boolean.");
  }
  return { localEnabled };
}

/** Local self-modification runs only inside the development runtime. */
export function isLocalSelfModificationEnabled(config: ResolvedSelfModificationConfig): boolean {
  return process.env.EVE_DEV === "1" && config.localEnabled;
}

/**
 * Returns the deployed configuration outside the development runtime. In `eve dev`,
 * local self-modification owns delegation so the root agent never sees two children.
 */
export function resolveActiveDeployedConfig(
  config: ResolvedSelfModificationExtensionConfig,
): ResolvedDeployedSelfModificationConfig | undefined {
  return process.env.EVE_DEV === "1" ? undefined : config.deployed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
