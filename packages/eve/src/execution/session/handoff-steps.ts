import { getBlockingWorkflowToolRuns } from "#harness/workflow-tool-runs.js";
import { deserializeContext } from "#context/serialize.js";
import { migrateSessionCheckpoint } from "#execution/session/checkpoint-migrations.js";
import { readDurableSession, type DurableSessionState } from "#execution/durable-session-store.js";
import {
  SESSION_CHECKPOINT_VERSION,
  type SessionCheckpoint,
  type SessionOwnerActivation,
} from "#execution/session/handoff.js";
import { createLogger } from "#internal/logging.js";
import { resumeHook } from "#internal/workflow/runtime.js";
import { getResolvedRuntimeAgentNode } from "#runtime/graph.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";
import { getSandboxEnvironmentRuntime } from "#shared/sandbox-environment.js";
import { isObject } from "#shared/guards.js";

const log = createLogger("execution.handoff");

/** Parses retained work with this deployment's code before deciding whether it can move. */
export function isSessionStateIdleForHandoff(sessionState: DurableSessionState): boolean {
  const { state } = readDurableSession(sessionState);
  // Decoding the run registry rejects corrupt state before any busy-work shortcut.
  const workflowToolRuns = getBlockingWorkflowToolRuns(state);

  // These registries are deleted when work settles. Their ordinary readers
  // tolerate malformed values as absent; that must not authorize a handoff.
  const pendingKeys = [
    "eve.runtime.pendingAuthorization",
    "eve.runtime.pendingInputBatch",
    "eve.runtime.pendingCoordinationBatch",
    "eve.runtime.deferredStepInput",
    "eve.harness.pendingWorkflowInterrupt",
  ];
  if (pendingKeys.some((key) => state?.[key] !== undefined)) return false;
  const batches = state?.["eve.runtime.pendingInputBatches"];
  if (batches !== undefined && (!Array.isArray(batches) || batches.length > 0)) return false;
  const proxyRequests = state?.["eve.runtime.proxyInputRequests"];
  if (
    proxyRequests !== undefined &&
    (!isObject(proxyRequests) || Object.keys(proxyRequests).length > 0)
  )
    return false;
  return workflowToolRuns.length === 0;
}

/** Reads durable work using the source deployment's handoff contract. */
export async function isSessionIdleForHandoffStep(input: {
  readonly sessionState: DurableSessionState;
}): Promise<boolean> {
  "use step";
  return isSessionStateIdleForHandoff(input.sessionState);
}

export type SessionCheckpointValidation =
  | {
      readonly kind: "valid";
      /** The upgraded checkpoint, present only when an older eve build wrote it. */
      readonly checkpoint?: SessionCheckpoint;
    }
  | { readonly kind: "incompatible"; readonly reason: "checkpoint-version" };

/**
 * Upgrades and validates a checkpoint, and resolves the target deployment's
 * compiled bundle.
 *
 * An unreadable version is a settled answer about this deployment, not a
 * fault, so it returns rather than throws: retrying the step can never change it.
 */
export async function validateSessionCheckpointStep(input: {
  readonly checkpoint: SessionCheckpoint;
  readonly sessionId: string;
}): Promise<SessionCheckpointValidation> {
  "use step";
  const migration = migrateSessionCheckpoint(input.checkpoint);
  if (migration.kind === "incompatible") {
    log.warn("session handoff refused: this deployment cannot read the checkpoint", {
      detail: migration.detail,
      readableCheckpointVersion: SESSION_CHECKPOINT_VERSION,
      sessionId: input.sessionId,
    });
    return { kind: "incompatible", reason: "checkpoint-version" };
  }
  const { checkpoint } = migration;
  const timeout = checkpoint.sessionTimeoutMs;
  if (
    timeout !== false &&
    (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout < 0)
  )
    throw new Error("Session checkpoint contains an invalid timeout duration.");
  const context = await deserializeContext(checkpoint.serializedContext);
  const bundle = context.require(BundleKey);
  const session = readDurableSession(checkpoint.sessionState);
  const sandboxState = session.sandboxState?.session;
  if (sandboxState !== null && sandboxState !== undefined) {
    const definition =
      getResolvedRuntimeAgentNode(bundle.graph, bundle.nodeId).sandboxRegistry.sandbox.inheritance
        ?.definition ??
      getResolvedRuntimeAgentNode(bundle.graph, bundle.nodeId).sandboxRegistry.sandbox.definition;
    if (definition.kind !== "independent") {
      throw new Error("Session checkpoint sandbox has no resolved provider.");
    }
    const provider = getSandboxEnvironmentRuntime(definition.environment);
    if (
      sandboxState.providerName !== provider.providerName ||
      sandboxState.stateProtocolVersion !== provider.stateProtocolVersion
    ) {
      throw new Error("Session checkpoint sandbox provider state is incompatible.");
    }
  }
  if (!isSessionStateIdleForHandoff(checkpoint.sessionState)) {
    throw new Error("Session checkpoint contains pending work and cannot be handed off.");
  }
  return checkpoint === input.checkpoint ? { kind: "valid" } : { kind: "valid", checkpoint };
}

/** Records why the owner kept a session it tried to move, so a stuck handoff is visible. */
export async function reportSessionHandoffRetainedStep(input: {
  readonly error?: string;
  readonly reason: "activation-failed" | "checkpoint-incompatible";
  readonly sessionId: string;
  readonly sourceDeploymentId: string;
  readonly targetDeploymentId: string;
}): Promise<void> {
  "use step";
  log.warn("session handoff failed; the current owner keeps the session", {
    ...input,
    checkpointVersion: SESSION_CHECKPOINT_VERSION,
  });
}

export async function signalSessionOwnerActivationStep(input: {
  readonly activation: SessionOwnerActivation;
  readonly token: string;
}): Promise<void> {
  "use step";
  await resumeHook(input.token, input.activation);
}

export async function signalSessionAnchorStep(input: {
  readonly result: { readonly output: unknown };
  readonly token: string;
}): Promise<void> {
  "use step";
  await resumeHook(input.token, input.result);
}
