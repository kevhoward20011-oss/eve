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
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import { getPendingInputBatches } from "#harness/pending-input-batches.js";
import {
  getPendingRemoteInputs,
  REMOTE_INPUT_FAILED_CLOSED_FEEDBACK,
  REMOTE_INPUT_REFUSED_FEEDBACK,
  requestRemoteInput,
  takeRemoteInputContinuation,
  type RemoteInputRetry,
} from "#harness/remote-input.js";
import { createToolLoopHarness } from "#harness/tool-loop.js";
import type {
  HarnessSession,
  StepResult,
  StepInput,
  ToolLoopHarnessConfig,
} from "#harness/types.js";
import type { InputRequest } from "#shared/input.js";

// The harness runs outside a workflow body here, where run attributes cannot
// be written; the attribute contract is covered by emit.test.ts.
vi.mock("#runtime/attributes/emit.js", () => ({ setEveAttributes: vi.fn(async () => {}) }));

const SECRET = "SECRET-STATE-123";
const SESSION_ID = "remote-input-session";
const CALL_ID = "call-remote-1";
const REQUEST_ID = `remote-input_${CALL_ID}`;
const TOOL_NAME = "run_query";

function principal(principalId: string): SessionAuthContext {
  return {
    attributes: {},
    authenticator: "test",
    issuer: "test",
    principalId,
    principalType: "user",
  };
}

const alice = principal("alice");
const bob = principal("bob");

function createContext(auth: SessionAuthContext): ContextContainer {
  const ctx = new ContextContainer();
  ctx.set(AuthKey, auth);
  ctx.set(SessionIdKey, SESSION_ID);
  ctx.set(SessionKey, {
    auth: { current: auth, initiator: null },
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

interface Fixture {
  readonly events: unknown[];
  readonly execute: ReturnType<typeof vi.fn>;
  readonly model: MockLanguageModelV4;
  readonly requested: InputRequest[];
  readonly retries: (RemoteInputRetry | undefined)[];
  readonly runStep: ReturnType<typeof createToolLoopHarness>;
}

function createFixture(): Fixture {
  const responses = [
    toolCallStreamResult({
      input: JSON.stringify({ sql: "select count(*) from signups" }),
      toolCallId: CALL_ID,
      toolName: TOOL_NAME,
    }),
    textStreamResult("There were 42 signups today."),
  ];
  const model = new MockLanguageModelV4({
    doStream: async () => {
      const next = responses.shift();
      if (next === undefined) throw new Error("Unexpected extra model call.");
      return next;
    },
    modelId: "remote-input-model",
    provider: "eve-integration-mock",
  });
  const retries: (RemoteInputRetry | undefined)[] = [];
  const execute = vi.fn(async (_input: unknown, options: { readonly toolCallId: string }) => {
    if (execute.mock.calls.length === 1) {
      return requestRemoteInput({
        approve: { inputResponses: { k: { action: "accept" } }, requestState: SECRET },
        connection: "analytics",
        prompt: "Allow run_query?",
      });
    }
    const retry = takeRemoteInputContinuation(options.toolCallId);
    retries.push(retry);
    // The model-facing result says only whether a continuation arrived, so
    // the leak checks below catch the framework, not this tool echoing it.
    return { continued: retry !== undefined, ok: true };
  });
  const tool: HarnessToolDefinition = {
    description: "Run an analytics query.",
    execute,
    inputSchema: jsonSchema({ type: "object" }),
    name: TOOL_NAME,
  };
  const events: unknown[] = [];
  const requested: InputRequest[] = [];
  const config = {
    capabilities: { requestInput: true },
    handleEvent: async (event) => {
      events.push(event);
      if (event.type === "input.requested") requested.push(...event.data.requests);
    },
    resolveModel: async (): Promise<LanguageModel> => model,
    tools: new Map([[TOOL_NAME, tool]]),
  } satisfies ToolLoopHarnessConfig;
  return { events, execute, model, requested, retries, runStep: createToolLoopHarness(config) };
}

/** Runs one delivery and drains its deferred steps under the same context. */
async function deliver(
  fixture: Fixture,
  ctx: ContextContainer,
  session: HarnessSession,
  input: StepInput,
): Promise<StepResult> {
  let result = await contextStorage.run(ctx, () => fixture.runStep(session, input));
  for (let index = 0; index < 5 && typeof result.next === "function"; index += 1) {
    const { next, session: current } = result;
    result = await contextStorage.run(ctx, () => next(current));
  }
  return result;
}

async function parkFirstTurn(fixture: Fixture): Promise<StepResult> {
  return await deliver(fixture, createContext(alice), createSession(), {
    message: "How many signups today?",
  });
}

function answer(auth: SessionAuthContext | null, optionId: "approve" | "cancel"): StepInput {
  return { attributedInputResponses: [{ auth, response: { optionId, requestId: REQUEST_ID } }] };
}

function modelPrompts(fixture: Fixture): string {
  return JSON.stringify(fixture.model.doStreamCalls.map((call) => call.prompt));
}

function messagesOf(fixture: Fixture): string[] {
  return fixture.events.flatMap((event) => {
    const typed = event as { type: string; data?: { message?: unknown } };
    return typed.type === "message.completed" && typeof typed.data?.message === "string"
      ? [typed.data.message]
      : [];
  });
}

function lastToolOutput(fixture: Fixture): unknown {
  const prompt = fixture.model.doStreamCalls.at(-1)?.prompt ?? [];
  const tool = prompt.at(-1);
  return tool?.role === "tool" ? tool.content[0] : undefined;
}

function pendingRequestIds(session: HarnessSession): string[] {
  return getPendingInputBatches(session.state).flatMap((batch) =>
    batch.requests.map((request) => request.requestId),
  );
}

function approvalResponse(session: HarnessSession): unknown {
  for (const message of session.history) {
    if (message.role !== "tool" || !Array.isArray(message.content)) continue;
    const part = message.content.find(
      (candidate) =>
        candidate.type === "tool-approval-response" && candidate.approvalId === REQUEST_ID,
    );
    if (part !== undefined) return part;
  }
  return undefined;
}

describe("tool loop remote input (real AI SDK)", () => {
  it("parks a remote input as a tool-approval request without leaking the retry state", async () => {
    const fixture = createFixture();
    const parked = await parkFirstTurn(fixture);

    expect(fixture.execute).toHaveBeenCalledOnce();
    expect(fixture.requested).toHaveLength(1);
    expect(fixture.requested[0]).toMatchObject({
      action: { callId: CALL_ID, kind: "tool-call", toolName: TOOL_NAME },
      kind: "tool-approval",
      prompt: "Allow run_query?",
      requestId: REQUEST_ID,
    });
    expect(pendingRequestIds(parked.session)).toEqual([REQUEST_ID]);
    expect(getPendingRemoteInputs(parked.session.state)).toMatchObject([
      { callId: CALL_ID, requestId: REQUEST_ID, responder: alice },
    ]);
    expect(fixture.model.doStreamCalls).toHaveLength(1);
    expect(JSON.stringify(fixture.events)).not.toContain(SECRET);
    expect(modelPrompts(fixture)).not.toContain(SECRET);
    expect(JSON.stringify(parked.session.history)).not.toContain(SECRET);
    // The retry payload is journaled on state, so the checks above are not vacuous.
    expect(JSON.stringify(parked.session.state)).toContain(SECRET);
  });

  it("re-runs the call with the continuation when the requester approves", async () => {
    const fixture = createFixture();
    const parked = await parkFirstTurn(fixture);

    const result = await deliver(
      fixture,
      createContext(alice),
      parked.session,
      answer(alice, "approve"),
    );

    expect(fixture.execute).toHaveBeenCalledTimes(2);
    expect(fixture.retries).toEqual([
      { inputResponses: { k: { action: "accept" } }, requestState: SECRET },
    ]);
    expect(approvalResponse(result.session)).toMatchObject({ approved: true });
    expect(result.session.history.at(-1)).toMatchObject({
      content: [{ text: "There were 42 signups today.", type: "text" }],
      role: "assistant",
    });
    expect(pendingRequestIds(result.session)).toEqual([]);
    expect(getPendingRemoteInputs(result.session.state)).toEqual([]);
    expect(fixture.model.doStreamCalls).toHaveLength(2);
    expect(lastToolOutput(fixture)).toMatchObject({
      output: { type: "json", value: { continued: true, ok: true } },
      toolCallId: CALL_ID,
    });
    expect(modelPrompts(fixture)).not.toContain(SECRET);
    expect(JSON.stringify(fixture.events)).not.toContain(SECRET);
    expect(JSON.stringify(result.session)).not.toContain(SECRET);
  });

  it("refuses another person's answer and keeps the request pending for the requester", async () => {
    const fixture = createFixture();
    const parked = await parkFirstTurn(fixture);

    const refused = await deliver(
      fixture,
      createContext(bob),
      parked.session,
      answer(bob, "approve"),
    );

    expect(messagesOf(fixture)).toContain(REMOTE_INPUT_REFUSED_FEEDBACK);
    expect(fixture.execute).toHaveBeenCalledOnce();
    expect(pendingRequestIds(refused.session)).toEqual([REQUEST_ID]);
    expect(getPendingRemoteInputs(refused.session.state)).toHaveLength(1);
    expect(approvalResponse(refused.session)).toBeUndefined();
    expect(fixture.model.doStreamCalls).toHaveLength(1);

    const approved = await deliver(
      fixture,
      createContext(alice),
      refused.session,
      answer(alice, "approve"),
    );

    expect(fixture.execute).toHaveBeenCalledTimes(2);
    expect(fixture.retries).toEqual([
      { inputResponses: { k: { action: "accept" } }, requestState: SECRET },
    ]);
    expect(approvalResponse(approved.session)).toMatchObject({ approved: true });
    expect(pendingRequestIds(approved.session)).toEqual([]);
  });

  it("fails the call closed when the answer names no responder", async () => {
    const fixture = createFixture();
    const parked = await parkFirstTurn(fixture);

    const result = await deliver(
      fixture,
      createContext(alice),
      parked.session,
      answer(null, "approve"),
    );

    expect(messagesOf(fixture)).toContain(REMOTE_INPUT_FAILED_CLOSED_FEEDBACK);
    expect(fixture.execute).toHaveBeenCalledOnce();
    expect(approvalResponse(result.session)).toMatchObject({ approved: false });
    expect(lastToolOutput(fixture)).toMatchObject({
      output: { type: "execution-denied" },
      toolCallId: CALL_ID,
    });
    expect(pendingRequestIds(result.session)).toEqual([]);
    expect(getPendingRemoteInputs(result.session.state)).toEqual([]);
    expect(modelPrompts(fixture)).not.toContain(SECRET);
  });

  it("ends the call denied when the requester cancels", async () => {
    const fixture = createFixture();
    const parked = await parkFirstTurn(fixture);

    const result = await deliver(
      fixture,
      createContext(alice),
      parked.session,
      answer(alice, "cancel"),
    );

    expect(fixture.execute).toHaveBeenCalledOnce();
    expect(approvalResponse(result.session)).toMatchObject({ approved: false });
    expect(lastToolOutput(fixture)).toMatchObject({
      output: { type: "execution-denied" },
      toolCallId: CALL_ID,
    });
    expect(pendingRequestIds(result.session)).toEqual([]);
    expect(getPendingRemoteInputs(result.session.state)).toEqual([]);
    expect(modelPrompts(fixture)).not.toContain(SECRET);
  });
});

// ---------------------------------------------------------------------------
// Resumed calls that ask again
// ---------------------------------------------------------------------------

const MAX_ASKS = 3;
const SECRET_PREFIX = "SECRET-ASK-STATE";
const ASK_PROMPTS = [
  "Allow run_query?",
  "Sign in to analytics to continue.",
  "You have not finished signing in to analytics.",
];

type Mode = "generate" | "stream";

interface AskingFixture {
  readonly attempts: (number | undefined)[];
  readonly events: unknown[];
  readonly execute: ReturnType<typeof vi.fn>;
  readonly model: MockLanguageModelV4;
  readonly prompts: () => unknown[];
  readonly runStep: ReturnType<typeof createToolLoopHarness>;
}

function generateResult(
  content: Awaited<ReturnType<MockLanguageModelV4["doGenerate"]>>["content"],
  finish: "stop" | "tool-calls",
): Awaited<ReturnType<MockLanguageModelV4["doGenerate"]>> {
  return { content, finishReason: { raw: undefined, unified: finish }, usage, warnings: [] };
}

/**
 * A model that calls the tool once, then answers each later step with text,
 * and a tool that asks `asks` times before it succeeds. It follows
 * connection-tools' bound: an ask past {@link MAX_ASKS} fails the call.
 */
function createAskingFixture(mode: Mode, asks: number, texts: readonly string[]): AskingFixture {
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
    if (attempt > MAX_ASKS) {
      throw new Error(`${TOOL_NAME} asked for input ${MAX_ASKS} times without finishing.`);
    }
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
  const prompts = () =>
    mode === "stream"
      ? model.doStreamCalls.map((call) => call.prompt)
      : model.doGenerateCalls.map((call) => call.prompt);
  return {
    attempts,
    events,
    execute,
    model,
    prompts,
    runStep: createToolLoopHarness(config),
  };
}

async function deliverTo(
  fixture: AskingFixture,
  session: HarnessSession,
  input: StepInput,
): Promise<StepResult> {
  const ctx = createContext(alice);
  let result = await contextStorage.run(ctx, () => fixture.runStep(session, input));
  for (let index = 0; index < 5 && typeof result.next === "function"; index += 1) {
    const { next, session: current } = result;
    result = await contextStorage.run(ctx, () => next(current));
  }
  return result;
}

function approve(requestId: string): StepInput {
  return {
    attributedInputResponses: [{ auth: alice, response: { optionId: "approve", requestId } }],
  };
}

function pendingRequests(session: HarnessSession): InputRequest[] {
  return getPendingInputBatches(session.state).flatMap((batch) => batch.requests);
}

function requestedEvents(fixture: AskingFixture): InputRequest[] {
  return fixture.events.flatMap((event) => {
    const typed = event as { type: string; data?: { requests?: InputRequest[] } };
    return typed.type === "input.requested" ? (typed.data?.requests ?? []) : [];
  });
}

function actionResults(fixture: AskingFixture): unknown[] {
  return fixture.events.filter((event) => (event as { type: string }).type === "action.result");
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

function expectNoLeak(fixture: AskingFixture, session: HarnessSession): void {
  expect(JSON.stringify(fixture.prompts())).not.toContain(SECRET_PREFIX);
  expect(JSON.stringify(fixture.events)).not.toContain(SECRET_PREFIX);
  expect(JSON.stringify(session.history)).not.toContain(SECRET_PREFIX);
}

/** Approves the pending ask and expects the re-run call to ask again. */
async function approveAndExpectReask(
  fixture: AskingFixture,
  mode: Mode,
  session: HarnessSession,
  previousId: string,
  ask: number,
): Promise<HarnessSession> {
  const result = await deliverTo(fixture, session, approve(previousId));
  const requestId = `${REQUEST_ID}_${ask}`;
  const pending = pendingRequests(result.session);
  expect(pending).toHaveLength(1);
  expect(pending[0]).toMatchObject({
    action: { callId: CALL_ID, kind: "tool-call", toolName: TOOL_NAME },
    kind: "tool-approval",
    prompt: ASK_PROMPTS[ask - 1],
    requestId,
  });
  if (mode === "stream") expect(requestedEvents(fixture).at(-1)).toEqual(pending[0]);
  expect(getPendingRemoteInputs(result.session.state)).toMatchObject([
    { callId: CALL_ID, requestId, responder: alice, retry: { attempt: ask } },
  ]);
  expect(JSON.stringify(result.session.state)).toContain(`${SECRET_PREFIX}-${ask}`);
  expectNoLeak(fixture, result.session);
  return result.session;
}

describe.each<Mode>(["stream", "generate"])(
  "tool loop remote input re-asks on resumed calls (%s)",
  (mode) => {
    it("re-parks a resumed call each time it asks again, then finishes", async () => {
      const fixture = createAskingFixture(mode, MAX_ASKS, [
        "Please sign in to analytics.",
        "Still waiting for you to finish signing in.",
        "There were 42 signups today.",
      ]);
      const first = await deliverTo(fixture, createSession(), {
        message: "How many signups today?",
      });
      expect(pendingRequests(first.session).map((request) => request.requestId)).toEqual([
        REQUEST_ID,
      ]);

      const second = await approveAndExpectReask(fixture, mode, first.session, REQUEST_ID, 2);
      const third = await approveAndExpectReask(fixture, mode, second, `${REQUEST_ID}_2`, 3);
      const done = await deliverTo(fixture, third, approve(`${REQUEST_ID}_3`));

      expect(fixture.execute).toHaveBeenCalledTimes(4);
      expect(fixture.attempts).toEqual([undefined, 1, 2, 3]);
      expect(pendingRequests(done.session)).toEqual([]);
      expect(getPendingRemoteInputs(done.session.state)).toEqual([]);
      expect(done.session.history.at(-1)).toMatchObject({
        content: [{ text: "There were 42 signups today.", type: "text" }],
        role: "assistant",
      });
      // One model call per park plus the final answer.
      expect(fixture.prompts()).toHaveLength(4);
      // The call sits right before its result in what the provider sees.
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
        expect(actionResults(fixture)).toMatchObject([
          { data: { result: { callId: CALL_ID, output: { continued: true, ok: true } } } },
        ]);
      }
      expectNoLeak(fixture, done.session);
      expect(JSON.stringify(done.session)).not.toContain(SECRET_PREFIX);
    });

    it("fails the call cleanly when it asks past the bound", async () => {
      const fixture = createAskingFixture(mode, MAX_ASKS + 1, [
        "Please sign in to analytics.",
        "Still waiting for you to finish signing in.",
        "The query could not finish.",
      ]);
      const first = await deliverTo(fixture, createSession(), {
        message: "How many signups today?",
      });
      const second = await approveAndExpectReask(fixture, mode, first.session, REQUEST_ID, 2);
      const third = await approveAndExpectReask(fixture, mode, second, `${REQUEST_ID}_2`, 3);
      const done = await deliverTo(fixture, third, approve(`${REQUEST_ID}_3`));

      expect(fixture.execute).toHaveBeenCalledTimes(4);
      expect(fixture.attempts).toEqual([undefined, 1, 2, 3]);
      expect(pendingRequests(done.session)).toEqual([]);
      expect(getPendingRemoteInputs(done.session.state)).toEqual([]);
      expect(messageAfterCall(fixture.prompts().at(-1))).toMatchObject({
        content: [
          {
            output: {
              type: "error-text",
              value: expect.stringContaining(`asked for input ${MAX_ASKS} times`),
            },
            toolCallId: CALL_ID,
            type: "tool-result",
          },
        ],
        role: "tool",
      });
      expect(done.session.history.at(-1)).toMatchObject({
        content: [{ text: "The query could not finish.", type: "text" }],
        role: "assistant",
      });
      if (mode === "stream") {
        expect(actionResults(fixture)).toMatchObject([
          { data: { result: { callId: CALL_ID, isError: true } } },
        ]);
      }
      expectNoLeak(fixture, done.session);
      expect(JSON.stringify(done.session)).not.toContain(SECRET_PREFIX);
    });
  },
);
