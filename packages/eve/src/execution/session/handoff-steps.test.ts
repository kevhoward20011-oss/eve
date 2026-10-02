import { createTestSessionState } from "#internal/testing/session-state.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SESSION_CHECKPOINT_VERSION, type SessionCheckpoint } from "#execution/session/handoff.js";
import { validateSessionCheckpointStep } from "#execution/session/handoff-steps.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";

const deserializeContextMock = vi.fn();
const readDurableSessionMock = vi.fn();

vi.mock("#context/serialize.js", () => ({
  deserializeContext: (...args: unknown[]) => deserializeContextMock(...args),
}));
vi.mock("#execution/durable-session-store.js", async (importOriginal) => ({
  ...(await importOriginal()),
  readDurableSession: (...args: unknown[]) => readDurableSessionMock(...args),
}));

describe("validateSessionCheckpointStep", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("hydrates the target bundle and durable state for a complete hook set", async () => {
    const require = vi.fn();
    deserializeContextMock.mockResolvedValue({ require });
    readDurableSessionMock.mockReturnValue({});
    const checkpoint = createCheckpoint();

    await expect(
      validateSessionCheckpointStep({ checkpoint, sessionId: "session-1" }),
    ).resolves.toEqual({ kind: "valid" });

    expect(require).toHaveBeenCalledWith(BundleKey);
    expect(readDurableSessionMock).toHaveBeenCalledWith(checkpoint.sessionState);
  });

  it("rejects an incompatible workflow tool run with the current checkpoint version", async () => {
    deserializeContextMock.mockResolvedValue({ require: vi.fn() });
    readDurableSessionMock.mockReturnValue({
      state: {
        "eve.workflowTool": {
          version: 4,
          runs: [
            {
              callId: "call",
              toolName: "research",
              origin: { turnId: "turn", stepIndex: 0 },
              address: { runId: "run", hookToken: 42 },
            },
          ],
        },
      },
    });
    await expect(
      validateSessionCheckpointStep({ checkpoint: createCheckpoint(), sessionId: "session-1" }),
    ).rejects.toThrow("Corrupt workflow tool run registry");
  });

  it.each([7, 12])(
    "reports checkpoint version %s as incompatible before reading nested state",
    async (version) => {
      const checkpoint = createCheckpoint();
      // Simulate an incompatible checkpoint received over the wire.
      Object.assign(checkpoint, { version });
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

      await expect(
        validateSessionCheckpointStep({ checkpoint, sessionId: "session-1" }),
      ).resolves.toEqual({
        kind: "incompatible",
        reason: "checkpoint-version",
      });
      expect(deserializeContextMock).not.toHaveBeenCalled();
      expect(readDurableSessionMock).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("cannot read the checkpoint"),
        expect.objectContaining({
          detail: `checkpoint version ${version} is outside the supported range 8-${SESSION_CHECKPOINT_VERSION}`,
          sessionId: "session-1",
        }),
      );
      warn.mockRestore();
    },
  );

  it("validates and returns the upgraded form of an older checkpoint", async () => {
    deserializeContextMock.mockResolvedValue({ require: vi.fn() });
    readDurableSessionMock.mockReturnValue({});
    const checkpoint = createCheckpoint();
    const { session } = checkpoint.sessionState.snapshot;
    const history = [{ content: "Alice asks for the status.", kind: "user", role: "user" }];
    // The eve 0.69 shape: history inside the durable session snapshot.
    Reflect.deleteProperty(checkpoint, "history");
    Object.assign(checkpoint, { version: 10 });
    Object.assign(checkpoint.sessionState, {
      snapshot: { session: { ...session, history } },
      version: 1,
    });

    const validation = await validateSessionCheckpointStep({ checkpoint, sessionId: "session-1" });

    expect(validation).toEqual({
      kind: "valid",
      checkpoint: expect.objectContaining({ history, version: SESSION_CHECKPOINT_VERSION }),
    });
    expect(readDurableSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({ version: 2, snapshot: { session } }),
    );
  });

  it.each([undefined, -1, NaN, Infinity, "30000", true])(
    "rejects an invalid renewal duration (%s)",
    async (sessionTimeoutMs) => {
      const checkpoint = { ...createCheckpoint(), sessionTimeoutMs } as SessionCheckpoint;
      await expect(
        validateSessionCheckpointStep({ checkpoint, sessionId: "session-1" }),
      ).rejects.toThrow("invalid timeout duration");
      expect(deserializeContextMock).not.toHaveBeenCalled();
    },
  );
});

function createCheckpoint(): SessionCheckpoint {
  return {
    version: SESSION_CHECKPOINT_VERSION,
    history: [],
    sessionTimeoutMs: false,
    serializedContext: {},
    sessionState: createTestSessionState({
      continuationToken: "channel:current",
      emissionState: { sequence: 0, sessionStarted: true, stepIndex: 0, turnId: "turn_0" },
      hasProxyInputRequests: false,
      sessionId: "session-1",
    }),
  };
}
