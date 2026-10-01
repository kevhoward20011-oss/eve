import type { ModelMessage, ToolSet, TypedToolResult } from "ai";
import { describe, expect, it } from "vitest";

import type { SessionAuthContext } from "#channel/types.js";
import { ContextContainer, contextStorage } from "#context/container.js";
import {
  checkRemoteInputResponder,
  getPendingRemoteInput,
  getPendingRemoteInputs,
  loadRemoteInputContinuations,
  modelFacingRemoteInputOutput,
  parkRemoteInputs,
  requestRemoteInput,
  takeRemoteInputContinuation,
} from "#harness/remote-input.js";
import { stashToolInterrupt } from "#harness/tool-interrupts.js";
import type { HarnessSession, SessionStateMap } from "#harness/types.js";

const SECRET_STATE = "opaque-request-state-SECRET";

const alice: SessionAuthContext = {
  attributes: {},
  authenticator: "test",
  issuer: "https://idp.example",
  principalId: "alice",
  principalType: "user",
};
const bob: SessionAuthContext = { ...alice, principalId: "bob" };

function signal(overrides: Partial<Parameters<typeof requestRemoteInput>[0]> = {}) {
  return requestRemoteInput({
    approve: {
      attempt: 1,
      inputResponses: { confirm: { action: "accept", content: { approved: true } } },
      requestState: SECRET_STATE,
    },
    connection: "billing-agent",
    prompt: "Approve refund of $40 to order 123?",
    ...overrides,
  });
}

function stepMessages(callId = "call_1"): ModelMessage[] {
  return [
    {
      content: [
        { type: "text", text: "Let me ask billing." },
        {
          input: { connection: "billing-agent", input: {}, tool: "refund" },
          toolCallId: callId,
          toolName: "connection_execute",
          type: "tool-call",
        },
      ],
      role: "assistant",
    },
    {
      content: [
        {
          output: { type: "text", value: "Waiting for the user..." },
          toolCallId: callId,
          toolName: "connection_execute",
          type: "tool-result",
        },
      ],
      role: "tool",
    },
  ];
}

function toolResult(callId: string, output: unknown): TypedToolResult<ToolSet> {
  return {
    dynamic: false,
    input: { connection: "billing-agent", input: {}, tool: "refund" },
    output,
    toolCallId: callId,
    toolName: "connection_execute",
    type: "tool-result",
  } as TypedToolResult<ToolSet>;
}

function session(state?: SessionStateMap): HarnessSession {
  const base: HarnessSession = {
    agent: { modelReference: { id: "test" }, system: "", tools: [] },
    compaction: { recentWindowSize: 10, threshold: 0.8 },
    continuationToken: "test",
    history: [],
    sessionId: "session-1",
  };
  if (state === undefined) return base;
  return { ...base, state };
}

function parkedState(callId = "call_1", responder: SessionAuthContext | null = alice) {
  const parked = parkRemoteInputs({
    messages: stepMessages(callId),
    responder,
    state: undefined,
    toolResults: [toolResult(callId, signal())],
  });
  return parked!.state;
}

describe("parkRemoteInputs", () => {
  it("returns undefined when no tool interrupted for remote input", () => {
    expect(
      parkRemoteInputs({
        messages: stepMessages(),
        responder: alice,
        state: undefined,
        toolResults: [toolResult("call_1", { ok: true })],
      }),
    ).toBeUndefined();
  });

  it.each([
    ["stashed signal behind the model-facing output", true],
    ["signal returned directly as output", false],
  ])("parks a %s as a tool-approval request", (_label, stashed) => {
    const full = signal();
    const ctx = new ContextContainer();
    if (stashed) stashToolInterrupt(ctx, "call_1", full);
    const output = stashed ? modelFacingRemoteInputOutput(full) : full;

    const parked = contextStorage.run(ctx, () =>
      parkRemoteInputs({
        messages: stepMessages(),
        responder: alice,
        state: { unrelated: "kept" },
        toolResults: [toolResult("call_1", output)],
      }),
    );
    expect(parked).toBeDefined();

    // The approval-request part follows the call; the pending tool result is gone.
    expect(parked!.messages).toHaveLength(1);
    const assistant = parked!.messages[0]!;
    expect(assistant.role).toBe("assistant");
    expect(assistant.content).toEqual([
      { type: "text", text: "Let me ask billing." },
      expect.objectContaining({ toolCallId: "call_1", type: "tool-call" }),
      {
        approvalId: "remote-input_call_1",
        toolCallId: "call_1",
        type: "tool-approval-request",
      },
    ]);
    expect(parked!.messages.some((message) => message.role === "tool")).toBe(false);

    expect(parked!.requests).toEqual([
      expect.objectContaining({
        action: expect.objectContaining({
          callId: "call_1",
          kind: "tool-call",
          toolName: "connection_execute",
        }),
        allowFreeform: false,
        display: "confirmation",
        kind: "tool-approval",
        prompt: "Approve refund of $40 to order 123?",
        requestId: "remote-input_call_1",
      }),
    ]);

    expect(parked!.state["unrelated"]).toBe("kept");
    expect(getPendingRemoteInputs(parked!.state)).toEqual([
      {
        callId: "call_1",
        connection: "billing-agent",
        requestId: "remote-input_call_1",
        responder: alice,
        retry: full.approve,
      },
    ]);

    // The retry payload lives only on state, never in history or requests.
    expect(JSON.stringify(parked!.messages)).not.toContain(SECRET_STATE);
    expect(JSON.stringify(parked!.requests)).not.toContain(SECRET_STATE);
    expect(JSON.stringify(parked!.messages)).not.toContain("requestState");
    expect(JSON.stringify(parked!.requests)).not.toContain("requestState");
  });

  it("ignores a model-facing output with no stashed signal", () => {
    expect(
      contextStorage.run(new ContextContainer(), () =>
        parkRemoteInputs({
          messages: stepMessages(),
          responder: alice,
          state: undefined,
          toolResults: [toolResult("call_1", modelFacingRemoteInputOutput(signal()))],
        }),
      ),
    ).toBeUndefined();
  });

  it("turns a signal for a call not in this step's messages into an error result", () => {
    const messages: ModelMessage[] = [
      { content: [{ type: "text", text: "resumed" }], role: "assistant" },
      {
        content: [
          {
            output: { type: "text", value: "pending" },
            toolCallId: "call_old",
            toolName: "connection_execute",
            type: "tool-result",
          },
        ],
        role: "tool",
      },
    ];
    const parked = parkRemoteInputs({
      messages,
      responder: alice,
      state: undefined,
      toolResults: [toolResult("call_old", signal())],
    });

    expect(parked!.requests).toEqual([]);
    expect(getPendingRemoteInputs(parked!.state)).toEqual([]);
    const tool = parked!.messages.find((message) => message.role === "tool");
    expect(tool?.content).toEqual([
      expect.objectContaining({
        output: {
          type: "error-text",
          value: expect.stringContaining('Connection "billing-agent" asked for input'),
        },
        toolCallId: "call_old",
        type: "tool-result",
      }),
    ]);
    expect(JSON.stringify(parked!.messages)).not.toContain(SECRET_STATE);
  });

  describe("a resumed call that asks again", () => {
    const resumedCall = {
      input: { connection: "billing-agent", input: {}, tool: "refund" },
      toolCallId: "call_old",
      toolName: "connection_execute",
      type: "tool-call" as const,
    };
    const siblingCall = { ...resumedCall, toolCallId: "call_sibling" };
    function earlierHistory(approvalId: string): ModelMessage[] {
      return [
        { content: "Refund order 123.", kind: "user", role: "user" } as ModelMessage,
        {
          content: [
            { text: "Asking billing.", type: "text" },
            resumedCall,
            { approvalId, toolCallId: "call_old", type: "tool-approval-request" },
            siblingCall,
          ],
          role: "assistant",
        },
        {
          content: [
            { approvalId, approved: true, type: "tool-approval-response" },
            {
              output: { type: "text", value: "done" },
              toolCallId: "call_sibling",
              toolName: "connection_execute",
              type: "tool-result",
            },
          ],
          role: "tool",
        },
      ];
    }
    function resumedStep(
      placeholder = 'Waiting for the user to answer a request from connection "billing-agent".',
    ): ModelMessage[] {
      return [
        {
          content: [
            {
              output: { type: "text", value: placeholder },
              toolCallId: "call_old",
              toolName: "connection_execute",
              type: "tool-result",
            },
          ],
          role: "tool",
        },
        { content: [{ text: "Please sign in.", type: "text" }], role: "assistant" },
      ];
    }
    function parkResumed(approvalId: string, placeholder?: string) {
      const ctx = new ContextContainer();
      stashToolInterrupt(ctx, "call_old", signal({ prompt: "Sign in to billing." }));
      return contextStorage.run(ctx, () =>
        parkRemoteInputs({
          history: earlierHistory(approvalId),
          messages: resumedStep(placeholder),
          responder: alice,
          state: undefined,
          toolResults: [],
        }),
      );
    }

    it("moves the call after the response with a fresh request id", () => {
      const parked = parkResumed("remote-input_call_old");

      expect(parked!.requests).toMatchObject([
        {
          action: { callId: "call_old" },
          prompt: "Sign in to billing.",
          requestId: "remote-input_call_old_2",
        },
      ]);
      expect(getPendingRemoteInputs(parked!.state)).toMatchObject([
        { callId: "call_old", requestId: "remote-input_call_old_2", responder: alice },
      ]);
      expect(parked!.messages).toEqual([
        {
          content: [
            { text: "Please sign in.", type: "text" },
            resumedCall,
            {
              approvalId: "remote-input_call_old_2",
              toolCallId: "call_old",
              type: "tool-approval-request",
            },
          ],
          role: "assistant",
        },
      ]);
      // The sibling call and its result stay; the resumed call's parts leave history.
      expect(parked!.history).toEqual([
        earlierHistory("x")[0],
        {
          content: [{ text: "Asking billing.", type: "text" }, siblingCall],
          role: "assistant",
        },
        { content: [earlierHistory("x")[2]!.content[1]], role: "tool" },
      ]);
      expect(JSON.stringify(parked!.messages)).not.toContain(SECRET_STATE);
      expect(JSON.stringify(parked!.history)).not.toContain(SECRET_STATE);
    });

    it("numbers later asks after the highest earlier one", () => {
      expect(parkResumed("remote-input_call_old_2")!.requests[0]?.requestId).toBe(
        "remote-input_call_old_3",
      );
    });

    it("ignores a stale stash when the result is not the pending placeholder", () => {
      expect(parkResumed("remote-input_call_old", "a real answer")).toBeUndefined();
    });
  });

  it("replaces an earlier journal entry for the same call", () => {
    const first = parkedState();
    const again = parkRemoteInputs({
      messages: stepMessages(),
      responder: bob,
      state: first,
      toolResults: [toolResult("call_1", signal({ prompt: "Second ask" }))],
    });
    expect(getPendingRemoteInputs(again!.state)).toHaveLength(1);
    expect(getPendingRemoteInput(again!.state, "remote-input_call_1")?.responder).toEqual(bob);
  });
});

describe("checkRemoteInputResponder", () => {
  it.each<[string, SessionStateMap | undefined, string, SessionAuthContext | null, unknown]>([
    ["accepts the same person", parkedState(), "remote-input_call_1", { ...alice }, "accept"],
    ["refuses a different principalId", parkedState(), "remote-input_call_1", bob, "refuse"],
    [
      "refuses the same principalId from a different issuer",
      parkedState(),
      "remote-input_call_1",
      { ...alice, issuer: "https://other.example" },
      "refuse",
    ],
    [
      "fails closed when the answer names no responder",
      parkedState(),
      "remote-input_call_1",
      null,
      "fail-closed",
    ],
    [
      "fails closed when the call ran for no authenticated user",
      parkedState("call_1", null),
      "remote-input_call_1",
      alice,
      "fail-closed",
    ],
    ["ignores an unknown requestId", parkedState(), "approval-1", alice, undefined],
    ["ignores a session with no journal", undefined, "remote-input_call_1", alice, undefined],
  ])("%s", (_label, state, requestId, responder, expected) => {
    expect(checkRemoteInputResponder(state, requestId, responder)).toBe(expected);
  });
});

describe("loadRemoteInputContinuations / takeRemoteInputContinuation", () => {
  const resolved = (outcome: string) => [
    { inputs: [{ outcome, request: { requestId: "remote-input_call_1" } }] },
  ];

  it("makes an approved retry readable exactly once inside the context", () => {
    const ctx = new ContextContainer();
    const next = loadRemoteInputContinuations({
      context: ctx,
      pendingRequestIds: new Set(),
      resolved: resolved("approved"),
      session: session(parkedState()),
    });
    expect(getPendingRemoteInputs(next.state)).toEqual([]);

    expect(takeRemoteInputContinuation("call_1")).toBeUndefined();
    contextStorage.run(ctx, () => {
      expect(takeRemoteInputContinuation("call_other")).toBeUndefined();
      expect(takeRemoteInputContinuation("call_1")).toEqual(signal().approve);
      expect(takeRemoteInputContinuation("call_1")).toBeUndefined();
    });
  });

  it("drops and prunes a cancelled request", () => {
    const ctx = new ContextContainer();
    const next = loadRemoteInputContinuations({
      context: ctx,
      pendingRequestIds: new Set(),
      resolved: resolved("cancelled"),
      session: session(parkedState()),
    });
    expect(getPendingRemoteInputs(next.state)).toEqual([]);
    expect(contextStorage.run(ctx, () => takeRemoteInputContinuation("call_1"))).toBeUndefined();
  });

  it("prunes an entry whose request is no longer pending and was not resolved", () => {
    const next = loadRemoteInputContinuations({
      context: new ContextContainer(),
      pendingRequestIds: new Set(),
      resolved: undefined,
      session: session(parkedState()),
    });
    expect(getPendingRemoteInputs(next.state)).toEqual([]);
  });
});
