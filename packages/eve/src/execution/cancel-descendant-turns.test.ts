import { beforeEach, describe, expect, it, vi } from "vitest";
import { cancelDescendantTurns } from "#execution/cancel-descendant-turns.js";
import { cancelDescendantTurnsStep } from "#execution/cancel-descendant-turns-step.js";
import { createTestSessionState } from "#internal/testing/session-state.js";
import { registerWorkflowToolRun } from "#harness/workflow-tool-runs.js";

vi.mock("#execution/cancel-descendant-turns-step.js", () => ({
  cancelDescendantTurnsStep: vi.fn(),
}));

function idleState() {
  return createTestSessionState({
    continuationToken: "",
    emissionState: { sequence: 0, sessionStarted: true, stepIndex: 0, turnId: "turn_0" },
    hasProxyInputRequests: false,
    sessionId: "session-1",
  });
}

beforeEach(() => vi.clearAllMocks());

describe("cancelDescendantTurns", () => {
  it("skips the step when the turn waits on no workflow tool run", async () => {
    await cancelDescendantTurns(idleState());
    expect(cancelDescendantTurnsStep).not.toHaveBeenCalled();
  });

  it("runs the step when a workflow tool run is blocking", async () => {
    const base = idleState();
    const sessionState = {
      ...base,
      snapshot: {
        session: registerWorkflowToolRun(base.snapshot.session, {
          address: { hookToken: "deploy-control", runId: "deploy-run" },
          callId: "deploy-call",
          origin: { stepIndex: 0, turnId: "turn_0" },
          toolName: "deploy",
        }),
      },
    };
    await cancelDescendantTurns(sessionState);
    expect(cancelDescendantTurnsStep).toHaveBeenCalledExactlyOnceWith({ sessionState });
  });
});
