import { describe, expect, it, vi } from "vitest";

import { ContextContainer, contextStorage } from "#context/container.js";
import { CapabilitiesKey } from "#context/keys.js";
import { ConnectionRegistryKey } from "#context/providers/connection-key.js";
import {
  getPendingRemoteInputs,
  isRemoteInputSignal,
  loadRemoteInputContinuations,
  modelFacingRemoteInputOutput,
  parkRemoteInputs,
  type RemoteInputRetry,
  type RemoteInputSignal,
} from "#harness/remote-input.js";
import type { HarnessSession } from "#harness/types.js";
import type { ConnectionRegistry } from "#runtime/connections/registry-types.js";
import type { McpInputRequiredResult } from "#runtime/connections/mcp-input-required.js";
import type { ResolvedConnectionDefinition } from "#runtime/types.js";
import type { ConnectionClient, ConnectionToolExecuteOptions } from "#shared/connection-types.js";
import type { ToolContext } from "#tools/definition.js";

import { resolveConnectionTools } from "./connection-tools.js";
import { CONNECTION_EXECUTE_TOOL_NAME } from "./connection-target.js";

const SECRET_STATE = "opaque-state-SECRET";

/** Same shape `McpConnectionClient.executeTool` returns for `input_required`. */
function inputRequired(result: McpInputRequiredResult): unknown {
  return { ...result, __eveMcpInputRequired: true };
}

const approvalForm = inputRequired({
  inputRequests: {
    confirm: {
      method: "elicitation/create",
      params: {
        message: "Approve refund of $40?",
        mode: "form",
        requestedSchema: { properties: { approved: { type: "boolean" } }, type: "object" },
      },
    },
  },
  requestState: SECRET_STATE,
});

const signInUrl = inputRequired({
  inputRequests: {
    login: {
      method: "elicitation/create",
      params: {
        message: "Billing needs you to sign in.",
        mode: "url",
        url: "https://billing.example/login?session=abc",
      },
    },
  },
  requestState: SECRET_STATE,
});

const completed = { content: [{ text: '{"ok":true}', type: "text" }] };

const connection: ResolvedConnectionDefinition = {
  connectionName: "billing",
  description: "Billing agent",
  logicalPath: "connections/billing.ts",
  protocol: "mcp",
  sourceId: "billing",
  sourceKind: "module",
  url: "https://billing.example/mcp",
} as ResolvedConnectionDefinition;

type ExecuteTool = (
  toolName: string,
  args: unknown,
  options: ConnectionToolExecuteOptions,
) => Promise<unknown>;

function setup(input: { readonly executeTool: ExecuteTool; readonly requestInput?: boolean }) {
  const executeTool = vi.fn(input.executeTool);
  const client: ConnectionClient = {
    close: async () => {},
    connect: async () => undefined,
    executeTool,
    getToolMetadata: async () => [
      { description: "Issue a refund", inputSchema: { type: "object" }, name: "refund" },
    ],
  };
  const registry: ConnectionRegistry = {
    dispose: async () => {},
    getClient: () => client,
    getConnectionApproval: () => undefined,
    getConnectionNames: () => ["billing"],
    getConnections: () => [connection],
  };
  const ctx = new ContextContainer();
  ctx.set(ConnectionRegistryKey, registry);
  if (input.requestInput !== undefined) {
    ctx.set(CapabilitiesKey, { requestInput: input.requestInput } as never);
  }
  const run = (callId = "call_1") =>
    contextStorage.run(ctx, async () => {
      const tools = resolveConnectionTools()!;
      const tool = tools[CONNECTION_EXECUTE_TOOL_NAME]!;
      return await tool.execute({ connection: "billing", input: {}, tool: "refund" }, {
        abortSignal: new AbortController().signal,
        callId,
      } as ToolContext);
    });
  return { ctx, executeTool, run };
}

/** Parks `signal` for `callId` and approves it, loading the continuation into `ctx`. */
function approveContinuation(ctx: ContextContainer, callId: string, retry: RemoteInputRetry) {
  const parked = parkRemoteInputs({
    messages: [
      {
        content: [
          { input: {}, toolCallId: callId, toolName: "connection_execute", type: "tool-call" },
        ],
        role: "assistant",
      },
    ],
    responder: null,
    state: undefined,
    toolResults: [
      {
        output: {
          __eveRemoteInputSignal: true,
          approve: retry,
          connection: "billing",
          prompt: "?",
        },
        toolCallId: callId,
        type: "tool-result",
      } as never,
    ],
  })!;
  const session = {
    agent: { modelReference: { id: "test" }, system: "", tools: [] },
    compaction: { recentWindowSize: 10, threshold: 0.8 },
    continuationToken: "test",
    history: [],
    sessionId: "s",
    state: parked.state,
  } as HarnessSession;
  const next = loadRemoteInputContinuations({
    context: ctx,
    pendingRequestIds: new Set(),
    resolved: [
      { inputs: [{ outcome: "approved", request: { requestId: `remote-input_${callId}` } }] },
    ],
    session,
  });
  expect(getPendingRemoteInputs(next.state)).toEqual([]);
}

describe("connection_execute with MCP input_required", () => {
  it("returns a remote input signal for an approval form when the session can ask", async () => {
    const { executeTool, run } = setup({
      executeTool: async () => approvalForm,
      requestInput: true,
    });
    const output = await run();

    expect(isRemoteInputSignal(output)).toBe(true);
    const signal = output as RemoteInputSignal;
    expect(signal.connection).toBe("billing");
    expect(signal.prompt).toBe("Approve refund of $40?");
    expect(signal.approve).toEqual({
      attempt: 1,
      inputResponses: { confirm: { action: "accept", content: { approved: true } } },
      requestState: SECRET_STATE,
    });
    expect(executeTool).toHaveBeenCalledOnce();
    expect(executeTool.mock.calls[0]![2].inputRetry).toBeUndefined();
  });

  it.each([
    ["absent", undefined],
    ["false", false],
  ])("fails a scheduled-style run when requestInput is %s", async (_label, requestInput) => {
    const { run } = setup({
      executeTool: async () => approvalForm,
      requestInput,
    });
    const error = await run().then(
      (value) => {
        throw new Error(`expected a failure, got ${JSON.stringify(value)}`);
      },
      (caught: unknown) => caught as Error,
    );
    expect(error.message).toContain("billing__refund");
    expect(error.message).toContain("approve it");
    expect(error.message).toContain("scheduled run");
    expect(error.message).not.toContain(SECRET_STATE);
  });

  it("propagates a cancellation without parking or retrying", async () => {
    const aborted = new Error("Request was aborted");
    const { executeTool, run } = setup({
      executeTool: async () => {
        throw aborted;
      },
      requestInput: true,
    });

    await expect(run()).rejects.toBe(aborted);
    expect(executeTool).toHaveBeenCalledOnce();
  });

  it("fails sign-in in a session that cannot ask", async () => {
    const { run } = setup({ executeTool: async () => signInUrl });
    await expect(run()).rejects.toThrow(/sign in.*scheduled run/su);
  });

  it("retries state-only rounds with the requestState and returns the final result", async () => {
    let calls = 0;
    const { executeTool, run } = setup({
      executeTool: async () =>
        ++calls <= 2 ? inputRequired({ requestState: `s${calls}` }) : completed,
    });
    await expect(run()).resolves.toEqual({ ok: true });
    expect(executeTool).toHaveBeenCalledTimes(3);
    expect(executeTool.mock.calls[0]![2].inputRetry).toBeUndefined();
    expect(executeTool.mock.calls[1]![2].inputRetry).toEqual({ requestState: "s1" });
    expect(executeTool.mock.calls[2]![2].inputRetry).toEqual({ requestState: "s2" });
  });

  it("bounds state-only retries (fails after 3)", async () => {
    const { executeTool, run } = setup({
      executeTool: async () => inputRequired({ requestState: SECRET_STATE }),
      requestInput: true,
    });
    await expect(run()).rejects.toThrow(/billing__refund kept asking to retry/u);
    // The first call plus three retries.
    expect(executeTool).toHaveBeenCalledTimes(4);
  });

  it.each([
    [
      "several inputs",
      inputRequired({
        inputRequests: {
          a: { method: "elicitation/create", params: {} },
          b: { method: "elicitation/create", params: {} },
        },
      }),
      /2 inputs at once/u,
    ],
    [
      "sampling",
      inputRequired({ inputRequests: { s: { method: "sampling/createMessage" } } }),
      /sampling\/createMessage/u,
    ],
    [
      "a rich form",
      inputRequired({
        inputRequests: {
          f: {
            method: "elicitation/create",
            params: {
              requestedSchema: { properties: { name: { type: "string" } }, type: "object" },
            },
          },
        },
      }),
      /form eve cannot render/u,
    ],
  ])("fails unsupported input (%s)", async (_label, outcome, pattern) => {
    const { run } = setup({ executeTool: async () => outcome, requestInput: true });
    await expect(run()).rejects.toThrow(/billing__refund needs input eve cannot ask for/u);
    await expect(
      setup({ executeTool: async () => outcome, requestInput: true }).run(),
    ).rejects.toThrow(pattern);
  });

  it("retries an approved continuation with its inputResponses and requestState, not attempt", async () => {
    const { ctx, executeTool, run } = setup({
      executeTool: async () => completed,
      requestInput: true,
    });
    const retry: RemoteInputRetry = {
      attempt: 1,
      inputResponses: { confirm: { action: "accept", content: { approved: true } } },
      requestState: SECRET_STATE,
    };
    approveContinuation(ctx, "call_1", retry);

    await expect(run("call_1")).resolves.toEqual({ ok: true });
    expect(executeTool).toHaveBeenCalledOnce();
    const options = executeTool.mock.calls[0]![2];
    expect(options.callId).toBe("call_1");
    expect(options.inputRetry).toEqual({
      inputResponses: retry.inputResponses,
      requestState: SECRET_STATE,
    });
    expect(options.inputRetry).not.toHaveProperty("attempt");

    // A continuation is read once: a second run of the same call starts fresh.
    await run("call_1");
    expect(executeTool.mock.calls[1]![2].inputRetry).toBeUndefined();
  });

  it("does not hand a continuation to a different call", async () => {
    const { ctx, executeTool, run } = setup({ executeTool: async () => completed });
    approveContinuation(ctx, "call_1", { inputResponses: { x: 1 }, requestState: "s" });
    await run("call_2");
    expect(executeTool.mock.calls[0]![2].inputRetry).toBeUndefined();
  });

  it("asks to sign in with the URL in the prompt", async () => {
    const { run } = setup({ executeTool: async () => signInUrl, requestInput: true });
    const output = await run();

    expect(isRemoteInputSignal(output)).toBe(true);
    const signal = output as RemoteInputSignal;
    expect(signal.prompt).toContain("https://billing.example/login?session=abc");
    expect(signal.prompt).toContain("Billing needs you to sign in.");
    expect(signal.prompt).not.toContain(SECRET_STATE);
    expect(signal.approve).toEqual({
      attempt: 1,
      inputResponses: { login: { action: "accept" } },
      requestState: SECRET_STATE,
    });
  });

  it("increments attempt across a re-ask after a continuation", async () => {
    const { ctx, run } = setup({ executeTool: async () => signInUrl, requestInput: true });
    approveContinuation(ctx, "call_1", { attempt: 2, inputResponses: {}, requestState: "s" });
    const output = (await run("call_1")) as RemoteInputSignal;
    expect(isRemoteInputSignal(output)).toBe(true);
    expect(output.approve.attempt).toBe(3);
  });

  it("fails once a call has asked more than 3 times", async () => {
    const { ctx, executeTool, run } = setup({
      executeTool: async () => signInUrl,
      requestInput: true,
    });
    approveContinuation(ctx, "call_1", { attempt: 3, inputResponses: {}, requestState: "s" });
    await expect(run("call_1")).rejects.toThrow(/billing__refund asked for input 3 times/u);
    expect(executeTool).toHaveBeenCalledOnce();
  });

  describe("resolved arguments", () => {
    const resolvedArguments = { context: { nonce: 1 }, query: "q" };

    it("journals the first round's resolved arguments on the signal, not for the model", async () => {
      const { run } = setup({
        executeTool: async () => ({ ...(approvalForm as object), resolvedArguments }),
        requestInput: true,
      });
      const signal = (await run()) as RemoteInputSignal;
      expect(signal.approve.resolvedArguments).toEqual(resolvedArguments);
      expect(modelFacingRemoteInputOutput(signal)).not.toHaveProperty("approve");
      expect(JSON.stringify(modelFacingRemoteInputOutput(signal))).not.toContain("nonce");
    });

    it("passes them back on a continuation, still without attempt", async () => {
      const { ctx, executeTool, run } = setup({ executeTool: async () => completed });
      approveContinuation(ctx, "call_1", {
        attempt: 1,
        inputResponses: { confirm: { action: "accept" } },
        requestState: SECRET_STATE,
        resolvedArguments,
      });
      await run("call_1");
      const options = executeTool.mock.calls[0]![2];
      expect(options.inputRetry).toEqual({
        inputResponses: { confirm: { action: "accept" } },
        requestState: SECRET_STATE,
        resolvedArguments,
      });
      expect(options.inputRetry).not.toHaveProperty("attempt");
    });

    it("passes them back on state-only retries", async () => {
      let calls = 0;
      const { executeTool, run } = setup({
        executeTool: async () =>
          ++calls === 1
            ? { ...(inputRequired({ requestState: "s1" }) as object), resolvedArguments }
            : completed,
      });
      await expect(run()).resolves.toEqual({ ok: true });
      expect(executeTool.mock.calls[1]![2].inputRetry).toEqual({
        requestState: "s1",
        resolvedArguments,
      });
    });
  });
});
