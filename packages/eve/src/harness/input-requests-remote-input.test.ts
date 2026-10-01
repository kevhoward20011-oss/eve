import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";

import type { SessionAuthContext } from "#channel/types.js";
import { ContextContainer, contextStorage } from "#context/container.js";
import { AuthKey } from "#context/keys.js";
import { coordinateApprovalDelivery } from "#harness/approval-delivery-coordinator.js";
import { resolvePendingInput, selectApprovalReplayBatch } from "#harness/input-requests.js";
import { appendPendingInputBatch, getPendingInputBatches } from "#harness/pending-input-batches.js";
import {
  getPendingRemoteInputs,
  parkRemoteInputs,
  requestRemoteInput,
} from "#harness/remote-input.js";
import type { HarnessSession, StepInput } from "#harness/types.js";
import type { InputRequest } from "#shared/input.js";

const alice: SessionAuthContext = {
  attributes: {},
  authenticator: "test",
  issuer: "https://idp.example",
  principalId: "alice",
  principalType: "user",
};
const bob: SessionAuthContext = { ...alice, principalId: "bob" };
const remoteRequestId = "remote-input_call-remote";

function baseSession(): HarnessSession {
  return {
    agent: { modelReference: { id: "test" }, system: "", tools: [] },
    compaction: { recentWindowSize: 10, threshold: 0.8 },
    continuationToken: "test",
    history: [],
    sessionId: "session-1",
  };
}

/** A session parked on one remote input that only Alice may answer. */
function remoteParkedSession(): HarnessSession {
  const parked = parkRemoteInputs({
    messages: [
      {
        content: [
          {
            input: { connection: "billing", input: {}, tool: "refund" },
            toolCallId: "call-remote",
            toolName: "connection_execute",
            type: "tool-call",
          },
        ],
        role: "assistant",
      },
    ],
    responder: alice,
    state: undefined,
    toolResults: [
      {
        dynamic: false,
        input: {},
        output: requestRemoteInput({
          approve: { attempt: 1, inputResponses: { ok: true }, requestState: "SECRET" },
          connection: "billing",
          prompt: "Approve the refund?",
        }),
        toolCallId: "call-remote",
        toolName: "connection_execute",
        type: "tool-result",
      } as never,
    ],
  })!;
  return appendPendingInputBatch({
    requests: parked.requests,
    responseMessages: parked.messages,
    session: { ...baseSession(), state: parked.state },
  });
}

function approvalResponses(messages: readonly ModelMessage[]): unknown[] {
  return messages.flatMap((message) =>
    message.role === "tool"
      ? message.content.filter((part) => part.type === "tool-approval-response")
      : [],
  );
}

function pendingRequestIds(session: HarnessSession): string[] {
  return getPendingInputBatches(session.state).flatMap((batch) =>
    batch.requests.map((pending) => pending.requestId),
  );
}

function resolveAs(stepInput: StepInput, turnAuth?: SessionAuthContext) {
  const ctx = new ContextContainer();
  if (turnAuth !== undefined) ctx.set(AuthKey, turnAuth);
  return contextStorage.run(ctx, () =>
    resolvePendingInput({ session: remoteParkedSession(), stepInput }),
  );
}

describe("typed answers to a remote input", () => {
  it.each([
    ["approve", true],
    ["1", true],
    ["cancel", false],
  ])("accepts %j from the user the call ran for", (text, approved) => {
    const result = resolveAs({ message: text, messageAuth: alice });
    expect(result.outcome).toBe("resolved");
    expect(result.consumedMessage).toBe(true);
    expect(approvalResponses(result.messages)).toEqual([
      expect.objectContaining({ approvalId: remoteRequestId, approved }),
    ]);
  });

  it("accepts a typed answer from the turn user when the message is unattributed", () => {
    const result = resolveAs({ message: "approve" }, alice);
    expect(approvalResponses(result.messages)).toEqual([
      expect.objectContaining({ approvalId: remoteRequestId, approved: true }),
    ]);
  });

  it.each(["approve", "1", "cancel"])("refuses %j from someone else", (text) => {
    const result = resolveAs({ message: text, messageAuth: bob });
    expect(approvalResponses(result.messages)).toEqual([]);
    expect(result.consumedMessage).not.toBe(true);
    expect(pendingRequestIds(result.session)).toContain(remoteRequestId);
    expect(getPendingRemoteInputs(result.session.state)).toHaveLength(1);
  });

  it("refuses a typed answer from another turn user", () => {
    const result = resolveAs({ message: "approve" }, bob);
    expect(approvalResponses(result.messages)).toEqual([]);
    expect(pendingRequestIds(result.session)).toContain(remoteRequestId);
  });

  it("does not accept a typed answer whose message names nobody", () => {
    const result = resolveAs({ message: "approve", messageAuth: null }, alice);
    expect(approvalResponses(result.messages)).toEqual([]);
    expect(pendingRequestIds(result.session)).toContain(remoteRequestId);
  });

  it("does not select the remote batch for replay on someone else's typed approve", () => {
    const session = remoteParkedSession();
    expect(
      selectApprovalReplayBatch(session, { message: "approve", messageAuth: bob }),
    ).toBeUndefined();
    expect(
      selectApprovalReplayBatch(session, { message: "approve", messageAuth: alice }),
    ).toBeDefined();
  });

  it("keeps a refused explicit answer refused when the same person also types approve", async () => {
    const delivered = await coordinateApprovalDelivery({
      now: 100,
      session: remoteParkedSession(),
      stepInput: {
        attributedInputResponses: [
          { auth: bob, response: { optionId: "approve", requestId: remoteRequestId } },
        ],
        message: "approve",
        messageAuth: bob,
      },
      tools: new Map(),
    });
    const result = resolvePendingInput({
      session: delivered.session,
      stepInput: delivered.stepInput,
    });
    expect(approvalResponses(result.messages)).toEqual([]);
    expect(pendingRequestIds(result.session)).toContain(remoteRequestId);
  });
});

describe("typed answers to an ordinary approval", () => {
  const request: InputRequest = {
    action: { callId: "call-1", input: {}, kind: "tool-call", toolName: "gate" },
    allowFreeform: false,
    display: "confirmation",
    kind: "tool-approval",
    options: [
      { id: "approve", label: "Approve" },
      { id: "cancel", label: "Cancel" },
    ],
    prompt: "Approve tool call: gate",
    requestId: "approval-1",
  };

  it("still accepts a typed approve from anyone", () => {
    const session = appendPendingInputBatch({
      requests: [request],
      responseMessages: [
        {
          content: [
            { input: {}, toolCallId: "call-1", toolName: "gate", type: "tool-call" },
            { approvalId: "approval-1", toolCallId: "call-1", type: "tool-approval-request" },
          ],
          role: "assistant",
        },
      ],
      session: baseSession(),
    });
    const result = resolvePendingInput({
      session,
      stepInput: { message: "approve", messageAuth: bob },
    });
    expect(result.consumedMessage).toBe(true);
    expect(approvalResponses(result.messages)).toEqual([
      expect.objectContaining({ approvalId: "approval-1", approved: true }),
    ]);
  });
});
