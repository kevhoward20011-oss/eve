import { cancelDescendantTurnsStep } from "#execution/cancel-descendant-turns-step.js";
import type { DurableSessionState } from "#execution/durable-session-store.js";
import { getBlockingWorkflowToolRuns } from "#harness/workflow-tool-runs.js";

/**
 * Cancels the workflow tool runs a cancelled turn waits on. A turn that waits
 * on none, the common case, skips the durable step. The step picks the exact
 * runs by turn; this check only needs to know there are none. An unreadable
 * registry runs the step, which logs it.
 */
export async function cancelDescendantTurns(sessionState: DurableSessionState): Promise<void> {
  if (!mayHaveBlockingRuns(sessionState)) return;
  await cancelDescendantTurnsStep({ sessionState });
}

function mayHaveBlockingRuns(sessionState: DurableSessionState): boolean {
  try {
    return getBlockingWorkflowToolRuns(sessionState.snapshot?.session?.state).length > 0;
  } catch {
    return true;
  }
}
