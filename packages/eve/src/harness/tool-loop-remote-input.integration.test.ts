import {
  textStreamResult,
  toolCallStreamResult,
  usage,
} from "#internal/testing/approval-resume.js";
import { jsonSchema, type LanguageModel } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import type { SessionAuthContext } from "#channel/types.js";
import { ContextContainer, contextStorage } from "#context/container.js";
import { AuthKey, SessionIdKey, SessionKey } from "#context/keys.js";
import { getPendingInputBatches } from "#harness/pending-input-batches.js";
import {
  getPendingRemoteInputs,
  REMOTE_INPUT_FAILED_CLOSED_FEEDBACK,
  requestRemoteInput,
  takeRemoteInputContinuation,
} from "#harness/remote-input.js";
import { createToolLoopHarness } from "#harness/tool-loop.js";
import type {
  HarnessSession,
  StepResult,
  StepInput,
  ToolLoopHarnessConfig,
} from "#harness/types.js";
import type { InputRequest } from "#shared/input.js";

/**
 * The real tool loop around a tool that asks for remote input. The a2a
 * scenario owns the approve, refuse, leak, and single re-ask paths against a
 * real eve server; these cover what it cannot express: an answer that ends
 * the call denied, and several re-asks of one resumed call in both model
 * modes.
 */

// The harness runs outside a workflow body here, where run attributes cannot
// be written; the attribute contract is covered by emit.test.ts.
vi.mock("#runtime/attributes/emit.js", () => ({ setEveAttributes: vi.fn(async () => {}) }));

const SESSION_ID = "remote-input-session";
const CALL_ID = "call-remote-1";
const REQUEST_ID = `remote-input_${CALL_ID}`;
const TOOL_NAME = "run_query";
const SECRET_PREFIX = "SECRET-ASK-STATE";
const ASK_PROMPTS = [
  "Allow run_query?",
  "Sign in to analytics to continue.",
  "You have not finished signing in to analytics.",
];

const alice: SessionAuthContext = {
  attributes: {},
  authenticator: "test",
  issuer: "test",
  principalId: "alice",
  principalType: "user",
};

type Mode = "generate" | "stream";

function createContext(): ContextContainer {
  const ctx = new ContextContainer();
  ctx.set(AuthKey, alice);
  ctx.set(SessionIdKey, SESSION_ID);
  ctx.set(SessionKey, {
    auth: { current: alice, initiator: null },
    sessionId: SESSION_ID,
    turn: { id: "turn-1", sequence: 1 },
  });
  return ctx;
}

function createSession(): HarnessSession {
  return {
    agent: {
      modelReference: { id: "remote-input-model" },
      system: "You are a test assistant.",
      tools: [
        {
          description: "Run an analytics query.",
          inputSchema: { type: "object" },
          name: TOOL_NAME,
        },
      ],
    },
    compaction: { recentWindowSize: 10, threshold: 100_000 },
    continuationToken: `http:${SESSION_ID}`,
    history: [],
    sessionId: SESSION_ID,
  };
}

function generateResult(
  content: Awaited<ReturnType<MockLanguageModelV4["doGenerate"]>>["content"],
  finish: "stop" | "tool-calls",
): Awaited<ReturnType<MockLanguageModelV4["doGenerate"]>> {
  return { content, finishReason: { raw: undefined, unified: finish }, usage, warnings: [] };
}

/**
 * A model that calls the tool once, then answers each later step with text,
 * and a tool that asks `asks` times (attempt 1, 2, ...) before it succeeds.
 */
function createFixture(mode: Mode, asks: number, texts: readonly string[]) {
  const sql = JSON.stringify({ sql: "select count(*) from signups" });
  const streams = [
    toolCallStreamResult({ input: sql, toolCallId: CALL_ID, toolName: TOOL_NAME }),
    ...texts.map((text) => textStreamResult(text)),
  ];
  const generations = [
    generateResult(
      [{ input: sql, toolCallId: CALL_ID, toolName: TOOL_NAME, type: "tool-call" }],
      "tool-calls",
    ),
    ...texts.map((text) => generateResult([{ text, type: "text" }], "stop")),
  ];
  const model = new MockLanguageModelV4({
    doGenerate: async () => {
      const next = generations.shift();
      if (next === undefined) throw new Error("Unexpected extra model call.");
      return next;
    },
    doStream: async () => {
      const next = streams.shift();
      if (next === undefined) throw new Error("Unexpected extra model call.");
      return next;
    },
    modelId: "remote-input-model",
    provider: "eve-integration-mock",
  });
  const attempts: (number | undefined)[] = [];
  const execute = vi.fn(async (_input: unknown, options: { readonly toolCallId: string }) => {
    const continuation = takeRemoteInputContinuation(options.toolCallId);
    attempts.push(continuation?.attempt);
    if (execute.mock.calls.length > asks)
      return { continued: continuation !== undefined, ok: true };
    const attempt = (continuation?.attempt ?? 0) + 1;
    return requestRemoteInput({
      approve: {
        attempt,
        inputResponses: { k: { action: "accept" } },
        requestState: `${SECRET_PREFIX}-${attempt}`,
      },
      connection: "analytics",
      prompt: ASK_PROMPTS[attempt - 1]!,
    });
  });
  const events: unknown[] = [];
  const config: ToolLoopHarnessConfig = {
    capabilities: { requestInput: true },
    ...(mode === "stream" ? { handleEvent: async (event) => void events.push(event) } : {}),
    resolveModel: async (): Promise<LanguageModel> => model,
    tools: new Map([
      [
        TOOL_NAME,
        {
          description: "Run an analytics query.",
          execute,
          inputSchema: jsonSchema({ type: "object" }),
          name: TOOL_NAME,
        },
      ],
    ]),
  };
  const runStep = createToolLoopHarness(config);
  const prompts = () =>
    mode === "stream"
      ? model.doStreamCalls.map((call) => call.prompt)
      : model.doGenerateCalls.map((call) => call.prompt);

  /** Runs one delivery and drains its deferred steps under the same context. */
  async function deliver(session: HarnessSession, input: StepInput): Promise<StepResult> {
    const ctx = createContext();
    let result = await contextStorage.run(ctx, () => runStep(session, input));
    for (let index = 0; index < 5 && typeof result.next === "function"; index += 1) {
      const { next, session: current } = result;
      result = await contextStorage.run(ctx, () => next(current));
    }
    return result;
  }

  return { attempts, deliver, events, execute, prompts };
}

type Fixture = ReturnType<typeof createFixture>;

function answer(
  auth: SessionAuthContext | null,
  requestId: string,
  optionId: "approve" | "cancel" = "approve",
): StepInput {
  return { attributedInputResponses: [{ auth, response: { optionId, requestId } }] };
}

function pendingRequests(session: HarnessSession): InputRequest[] {
  return getPendingInputBatches(session.state).flatMap((batch) => batch.requests);
}

function eventsOf(fixture: Fixture, type: string): { data?: Record<string, unknown> }[] {
  return fixture.events.filter((event) => (event as { type: string }).type === type) as {
    data?: Record<string, unknown>;
  }[];
}

/** The provider prompt message right after the assistant message holding the call. */
function messageAfterCall(prompt: unknown): unknown {
  const messages = prompt as { content: unknown; role: string }[];
  const index = messages.findIndex(
    (message) =>
      message.role === "assistant" &&
      Array.isArray(message.content) &&
      message.content.some(
        (part: { toolCallId?: string; type: string }) =>
          part.type === "tool-call" && part.toolCallId === CALL_ID,
      ),
  );
  return index === -1 ? undefined : messages[index + 1];
}

function expectNoLeak(fixture: Fixture, session: HarnessSession): void {
  expect(JSON.stringify(fixture.prompts())).not.toContain(SECRET_PREFIX);
  expect(JSON.stringify(fixture.events)).not.toContain(SECRET_PREFIX);
  expect(JSON.stringify(session.history)).not.toContain(SECRET_PREFIX);
}

describe("tool loop remote input (real AI SDK)", () => {
  it.each([
    ["the requester cancels", answer(alice, REQUEST_ID, "cancel"), undefined],
    [
      "the answer names no responder (fails closed)",
      answer(null, REQUEST_ID),
      REMOTE_INPUT_FAILED_CLOSED_FEEDBACK,
    ],
  ])("ends the call denied, without re-running it, when %s", async (_label, input, feedback) => {
    const fixture = createFixture("stream", 1, ["The query was not run."]);
    const parked = await fixture.deliver(createSession(), { message: "How many signups?" });
    expect(pendingRequests(parked.session).map((request) => request.requestId)).toEqual([
      REQUEST_ID,
    ]);

    const result = await fixture.deliver(parked.session, input);

    const messages = eventsOf(fixture, "message.completed").map((event) => event.data?.["message"]);
    if (feedback === undefined) expect(messages).not.toContain(REMOTE_INPUT_FAILED_CLOSED_FEEDBACK);
    else expect(messages).toContain(feedback);
    expect(fixture.execute).toHaveBeenCalledOnce();
    expect(messageAfterCall(fixture.prompts().at(-1))).toMatchObject({
      content: [{ output: { type: "execution-denied" }, toolCallId: CALL_ID }],
      role: "tool",
    });
    expect(pendingRequests(result.session)).toEqual([]);
    expect(getPendingRemoteInputs(result.session.state)).toEqual([]);
    expectNoLeak(fixture, result.session);
  });

  describe.each<Mode>(["stream", "generate"])("re-asks on a resumed call (%s)", (mode) => {
    it("re-parks the call with a fresh request id each time it asks again, then finishes", async () => {
      const fixture = createFixture(mode, ASK_PROMPTS.length, [
        "Please sign in to analytics.",
        "Still waiting for you to finish signing in.",
        "There were 42 signups today.",
      ]);
      let { session } = await fixture.deliver(createSession(), { message: "How many signups?" });
      let requestId = REQUEST_ID;

      for (const ask of [2, 3]) {
        ({ session } = await fixture.deliver(session, answer(alice, requestId)));
        requestId = `${REQUEST_ID}_${ask}`;
        const pending = pendingRequests(session);
        expect(pending).toMatchObject([
          {
            action: { callId: CALL_ID, kind: "tool-call", toolName: TOOL_NAME },
            kind: "tool-approval",
            prompt: ASK_PROMPTS[ask - 1],
            requestId,
          },
        ]);
        if (mode === "stream") {
          expect(eventsOf(fixture, "input.requested").at(-1)?.data?.["requests"]).toEqual(pending);
        }
        expect(getPendingRemoteInputs(session.state)).toMatchObject([
          { callId: CALL_ID, requestId, responder: alice, retry: { attempt: ask } },
        ]);
        expect(JSON.stringify(session.state)).toContain(`${SECRET_PREFIX}-${ask}`);
        expectNoLeak(fixture, session);
      }
      const done = await fixture.deliver(session, answer(alice, requestId));

      expect(fixture.attempts).toEqual([undefined, 1, 2, 3]);
      expect(pendingRequests(done.session)).toEqual([]);
      expect(getPendingRemoteInputs(done.session.state)).toEqual([]);
      expect(done.session.history.at(-1)).toMatchObject({
        content: [{ text: "There were 42 signups today.", type: "text" }],
        role: "assistant",
      });
      // One model call per park plus the final answer, and the call sits
      // right before its result in what the provider sees.
      expect(fixture.prompts()).toHaveLength(4);
      expect(messageAfterCall(fixture.prompts().at(-1))).toMatchObject({
        content: [
          {
            output: { type: "json", value: { continued: true, ok: true } },
            toolCallId: CALL_ID,
            type: "tool-result",
          },
        ],
        role: "tool",
      });
      if (mode === "stream") {
        expect(eventsOf(fixture, "action.result")).toMatchObject([
          { data: { result: { callId: CALL_ID, output: { continued: true, ok: true } } } },
        ]);
      }
      expect(JSON.stringify(done.session)).not.toContain(SECRET_PREFIX);
      expectNoLeak(fixture, done.session);
    });
  });
});
