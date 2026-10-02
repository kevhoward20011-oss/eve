import type { DurableSessionState } from "#execution/durable-session-store.js";
import { liveTaskRuns, readTaskTable } from "#execution/tasks/table.js";
import { terminateChildSessionsStep } from "#execution/terminate-child-sessions-step.js";

/**
 * Ends every run the session still has working. Most sessions end with none,
 * so the workflow body skips the durable step that would find nothing to stop.
 */
export async function terminateChildSessions(sessionState: DurableSessionState): Promise<void> {
  if (liveTaskRuns(readTaskTable(sessionState.snapshot?.session?.state)).length === 0) return;
  await terminateChildSessionsStep({ sessionState });
}
