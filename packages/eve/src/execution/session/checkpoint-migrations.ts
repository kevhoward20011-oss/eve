import { SESSION_CHECKPOINT_VERSION, type SessionCheckpoint } from "#execution/session/handoff.js";
import { isObject } from "#shared/guards.js";

/**
 * Oldest checkpoint a successor upgrades (eve 0.66.0). Earlier checkpoints
 * predate the sandbox provider and dynamic skill manifest contracts and lack
 * data the current reader requires.
 */
export const MIN_SESSION_CHECKPOINT_VERSION = 8;

export type SessionCheckpointMigration =
  | { readonly kind: "current"; readonly checkpoint: SessionCheckpoint }
  | { readonly kind: "incompatible"; readonly detail: string };

type CheckpointRecord = Record<string, unknown>;

/**
 * One pure upgrade per checkpoint version, keyed by the version it reads.
 * Bumping `SESSION_CHECKPOINT_VERSION` requires adding the step from the
 * previous version: a successor must always accept its predecessors'
 * checkpoints. A step refuses only state it cannot carry forward losslessly;
 * the owner then keeps the session.
 */
const CHECKPOINT_UPGRADES: Readonly<
  Record<number, (checkpoint: CheckpointRecord) => CheckpointRecord>
> = {
  // Run mode was removed (eve 0.67).
  8: (checkpoint) => {
    const { mode: _mode, ...rest } = checkpoint;
    return {
      ...rest,
      serializedContext: omitKeys(readRecord(rest, "serializedContext"), ["eve.mode"]),
    };
  },
  // Background tasks, activity artifacts, and cached connection search results
  // were removed during version 9 (eve 0.69), and mount-scoped state was added.
  9: (checkpoint) => {
    const sessionState = readRecord(checkpoint, "sessionState");
    const snapshot = readRecord(sessionState, "snapshot");
    const session = readRecord(snapshot, "session");
    return {
      ...checkpoint,
      serializedContext: omitKeys(readRecord(checkpoint, "serializedContext"), [
        "eve.activityObserver",
        "eve.activityPendingBlockers",
        "eve.activityRootTurnId",
        "eve.activityTaskCalls",
        "eve.connectionSearchResults",
        "eve.internal.backgroundToolExecution",
        "eve.runtime.taskDeliveryPolicy",
        "eve.turnTaskDelivery",
      ]),
      sessionState: {
        ...sessionState,
        snapshot: {
          ...snapshot,
          session: {
            ...session,
            history: readArray(session, "history").map(renameBackgroundTaskMessage),
            state: upgradeWorkflowToolRuns(session.state),
          },
        },
      },
    };
  },
  // History moved out of the durable session snapshot (eve 0.70).
  10: (checkpoint) => {
    const sessionState = readRecord(checkpoint, "sessionState");
    const snapshot = readRecord(sessionState, "snapshot");
    const { history, taskId: _taskId, ...session } = readRecord(snapshot, "session");
    if (sessionState.version !== 1) refuse("durable session version is not 1");
    if (!Array.isArray(history)) refuse("session history is missing");
    return {
      ...checkpoint,
      history,
      sessionState: { ...sessionState, snapshot: { ...snapshot, session }, version: 2 },
    };
  },
};

/**
 * Upgrades a checkpoint written by an older eve build to the current shape.
 * Newer checkpoints and those older than {@link MIN_SESSION_CHECKPOINT_VERSION}
 * are incompatible.
 */
export function migrateSessionCheckpoint(checkpoint: unknown): SessionCheckpointMigration {
  if (!isObject(checkpoint)) return { kind: "incompatible", detail: "checkpoint is not an object" };
  const { version } = checkpoint;
  if (
    typeof version !== "number" ||
    !Number.isSafeInteger(version) ||
    version < MIN_SESSION_CHECKPOINT_VERSION ||
    version > SESSION_CHECKPOINT_VERSION
  ) {
    return {
      kind: "incompatible",
      detail: `checkpoint version ${JSON.stringify(version)} is outside the supported range ${MIN_SESSION_CHECKPOINT_VERSION}-${SESSION_CHECKPOINT_VERSION}`,
    };
  }
  let current: CheckpointRecord = checkpoint;
  try {
    for (let from = version; from < SESSION_CHECKPOINT_VERSION; from++) {
      const upgrade = CHECKPOINT_UPGRADES[from];
      if (upgrade === undefined) refuse(`no upgrade from checkpoint version ${from}`);
      current = { ...upgrade(current), version: from + 1 };
    }
  } catch (error) {
    if (!(error instanceof CheckpointRefusal)) throw error;
    return {
      kind: "incompatible",
      detail: `checkpoint version ${version}: ${error.message}`,
    };
  }
  if (!isCurrentCheckpoint(current)) {
    return { kind: "incompatible", detail: `checkpoint version ${version} is incomplete` };
  }
  return { kind: "current", checkpoint: current };
}

function isCurrentCheckpoint(value: unknown): value is SessionCheckpoint {
  return (
    isObject(value) &&
    value.version === SESSION_CHECKPOINT_VERSION &&
    Array.isArray(value.history) &&
    isObject(value.serializedContext) &&
    isObject(value.sessionState)
  );
}

class CheckpointRefusal extends Error {}

function refuse(detail: string): never {
  throw new CheckpointRefusal(detail);
}

function readRecord(value: CheckpointRecord, key: string): CheckpointRecord {
  const field = value[key];
  if (!isObject(field)) refuse(`${key} is not an object`);
  return field;
}

function readArray(value: CheckpointRecord, key: string): unknown[] {
  const field = value[key];
  if (!Array.isArray(field)) refuse(`${key} is not an array`);
  return field;
}

function omitKeys(record: CheckpointRecord, keys: readonly string[]): CheckpointRecord {
  return Object.fromEntries(Object.entries(record).filter(([key]) => !keys.includes(key)));
}

// Task notifications are framework-authored task results; history validation rejects the old kind.
function renameBackgroundTaskMessage(message: unknown): unknown {
  return isObject(message) &&
    message.role === "user" &&
    message.kind === "execution.background_task"
    ? { ...message, kind: "task.result" }
    : message;
}

/**
 * Version 3 also recorded session-owned background tasks. Settled ones already
 * reported to the conversation and have no current reader, so they are dropped.
 * Any other run means work is still in flight.
 */
function upgradeWorkflowToolRuns(state: unknown): unknown {
  if (!isObject(state)) return state;
  const registry = state["eve.workflowTool"];
  if (!isObject(registry) || registry.version !== 3) return state;
  const runs = registry.runs;
  if (
    !Array.isArray(runs) ||
    !runs.every(
      (run) =>
        isObject(run) &&
        run.lifetime === "session" &&
        isObject(run.task) &&
        run.task.outcome !== undefined,
    )
  ) {
    refuse("workflow tool run registry version 3 holds unsettled runs");
  }
  return omitKeys(state, ["eve.workflowTool"]);
}
