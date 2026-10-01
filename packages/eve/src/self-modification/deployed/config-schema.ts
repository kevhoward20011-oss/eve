import type { StandardSchemaV1 } from "#compiled/@standard-schema/spec/index.js";
import { z } from "#compiled/zod/index.js";
import type { SessionAuthContext } from "#channel/types.js";
import { isAgentReasoningDefinition, isRuntimeLanguageModel } from "#internal/runtime-model.js";
import type { AgentReasoningDefinition, AgentStaticModelDefinition } from "#public/index.js";
import { isValidGitRef } from "#shared/git.js";

export interface DeployedSelfModificationAuthorizationContext {
  readonly channel: {
    readonly kind?: string;
    readonly metadata?: Readonly<Record<string, unknown>>;
  };
  readonly principal: SessionAuthContext | null;
}

export type DeployedSelfModificationAuthorization = (
  context: DeployedSelfModificationAuthorizationContext,
) => boolean | Promise<boolean>;

export interface DeployedSelfModificationConfig {
  /** Fail-closed policy controlling who can delegate to the coding child. */
  readonly authorize: DeployedSelfModificationAuthorization;
  /** GitHub repository in owner/repository form. */
  readonly repository: string;
  /** Application directory relative to the repository root. */
  readonly directory: string;
  /** Branch against which changes are proposed. */
  readonly baseBranch: string;
  /** Connect-backed GitHub connector. */
  readonly github: { readonly connector: string };
  readonly model?: AgentStaticModelDefinition;
  readonly reasoning?: AgentReasoningDefinition;
}

export function isGitHubRepositoryPart(value: string): boolean {
  return (
    /^[A-Za-z0-9_.-]+$/u.test(value) && value !== "." && value !== ".." && !value.startsWith("-")
  );
}

export function isRepositoryRelativeDirectory(value: string): boolean {
  return (
    value === "." ||
    (value.length > 0 &&
      !value.startsWith("/") &&
      !value.includes("\\") &&
      value.split("/").every((part) => part !== "" && part !== "." && part !== ".."))
  );
}

export function isBranchName(value: string): boolean {
  return isValidGitRef(value) && !value.startsWith("refs/");
}

function isGitHubRepository(value: string): boolean {
  const parts = value.split("/");
  return parts.length === 2 && parts.every(isGitHubRepositoryPart);
}

// Typed as a Standard Schema so the public declaration names eve's own
// config type instead of Zod's.
export const deployedSelfModificationConfigSchema: StandardSchemaV1<DeployedSelfModificationConfig> =
  z
    .object({
      authorize: z.custom<DeployedSelfModificationAuthorization>(
        (value) => typeof value === "function",
        "Deployed self-modification authorize must be a function.",
      ),
      repository: z
        .string()
        .refine(
          isGitHubRepository,
          "Deployed self-modification repository must use owner/repo form.",
        ),
      directory: z
        .string()
        .refine(
          isRepositoryRelativeDirectory,
          "Deployed self-modification directory must be a safe repository-relative path.",
        ),
      baseBranch: z
        .string()
        .refine(
          isBranchName,
          "Deployed self-modification baseBranch must be a valid branch name, not a full Git ref.",
        ),
      github: z.object({ connector: z.string().min(1) }),
      model: z
        .custom<AgentStaticModelDefinition>(
          (value) => typeof value === "string" || isRuntimeLanguageModel(value),
        )
        .optional(),
      reasoning: z.custom<AgentReasoningDefinition>(isAgentReasoningDefinition).optional(),
    })
    .strict();
