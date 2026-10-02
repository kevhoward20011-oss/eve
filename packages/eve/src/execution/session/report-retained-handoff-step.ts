import { createLogger } from "#internal/logging.js";

const log = createLogger("execution.session.handoff");

/**
 * Surfaces a handoff the target deployment refused or failed to activate, so
 * operators can see why a session stays on its current deployment. Workflow
 * context cannot log directly, so the report crosses a step boundary.
 */
export async function reportRetainedHandoffStep(input: {
  readonly checkpointVersion: number;
  readonly error?: unknown;
  readonly ownerDeploymentId: string;
  readonly reason: "activation-failed" | "checkpoint-incompatible";
  readonly sessionId: string;
  readonly targetDeploymentId: string;
}): Promise<void> {
  "use step";

  log.warn("session handoff refused; the current deployment keeps the session", input);
}
