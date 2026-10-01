import { describe, expect, it, vi } from "vitest";

import { ContextContainer, contextStorage } from "#context/container.js";
import { CapabilitiesKey } from "#context/keys.js";
import { ConnectionRegistryKey } from "#context/providers/connection-key.js";
import {
  getPendingRemoteInputs,
  isRemoteInputSignal,
  loadRemoteInputContinuations,
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
const resolvedArguments = { context: { nonce: 1 }, query: "q" };

/** Same shape `McpConnectionClient.executeTool` returns for `input_required`. */
function inputRequired(result: McpInputRequiredResult & { resolvedArguments?: unknown }): unknown {
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
  resolvedArguments,
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

/** Replies with each value in turn, repeating the last one. */
function replies(...values: unknown[]): ExecuteTool {
  let index = 0;
  return async () => values[Math.min(index++, values.length - 1)];
}

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
  const controller = new AbortController();
  const run = (callId = "call_1") =>
    contextStorage.run(ctx, async () => {
      const tools = resolveConnectionTools()!;
      const tool = tools[CONNECTION_EXECUTE_TOOL_NAME]!;
      return await tool.execute({ connection: "billing", input: {}, tool: "refund" }, {
        abortSignal: controller.signal,
        callId,
      } as ToolContext);
    });
  const retries = () => executeTool.mock.calls.map((call) => call[2].inputRetry);
  return { controller, ctx, executeTool, retries, run };
}

/** Parks a remote input for `callId` and approves it, loading `retry` into `ctx`. */
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
  it.each([
    {
      name: "an approval form",
      outcome: approvalForm,
      approve: {
        attempt: 1,
        inputResponses: { confirm: { action: "accept", content: { approved: true } } },
        requestState: SECRET_STATE,
        resolvedArguments,
      },
      prompt: ["Approve refund of $40?"],
    },
    {
      name: "a sign-in URL",
      outcome: signInUrl,
      approve: {
        attempt: 1,
        inputResponses: { login: { action: "accept" } },
        requestState: SECRET_STATE,
      },
      prompt: ["Billing needs you to sign in.", "https://billing.example/login?session=abc"],
    },
  ])("asks the user about $name through a remote input signal", async (row) => {
    const { executeTool, retries, run } = setup({
      executeTool: async () => row.outcome,
      requestInput: true,
    });

    const output = await run();

    expect(isRemoteInputSignal(output)).toBe(true);
    const signal = output as RemoteInputSignal;
    expect(signal.connection).toBe("billing");
    expect(signal.approve).toEqual(row.approve);
    for (const text of row.prompt) expect(signal.prompt).toContain(text);
    expect(signal.prompt).not.toContain(SECRET_STATE);
    expect(executeTool).toHaveBeenCalledOnce();
    expect(retries()).toEqual([undefined]);
  });

  it.each([
    ["approve it", approvalForm, undefined],
    ["approve it", approvalForm, false],
    ["sign in", signInUrl, undefined],
  ])(
    "fails when the user must %s but requestInput is %s, such as a scheduled run",
    async (verb, outcome, requestInput) => {
      const { executeTool, run } = setup({ executeTool: async () => outcome, requestInput });

      await expect(run()).rejects.toThrow(
        `billing__refund needs the user to ${verb}, but this session cannot ask anyone, such as a scheduled run.`,
      );
      expect(executeTool).toHaveBeenCalledOnce();
    },
  );

  it("fails input eve cannot ask for with the planner's reason", async () => {
    const { run } = setup({
      executeTool: async () =>
        inputRequired({ inputRequests: { s: { method: "sampling/createMessage" } } }),
      requestInput: true,
    });

    await expect(run()).rejects.toThrow(
      "billing__refund needs input eve cannot ask for: it sent a sampling/createMessage request.",
    );
  });

  it("rethrows the client's rejection when the call is cancelled, without retrying", async () => {
    const aborted = new Error("Request was aborted");
    const { controller, executeTool, run } = setup({
      executeTool: async (_name, _args, options) => {
        controller.abort(aborted);
        options.abortSignal?.throwIfAborted();
        return approvalForm;
      },
      requestInput: true,
    });

    await expect(run()).rejects.toBe(aborted);
    expect(executeTool).toHaveBeenCalledOnce();
  });

  it("retries state-only rounds with their requestState and resolved arguments", async () => {
    const { retries, run } = setup({
      executeTool: replies(
        inputRequired({ requestState: "s1", resolvedArguments }),
        inputRequired({ requestState: "s2", resolvedArguments }),
        completed,
      ),
    });

    await expect(run()).resolves.toEqual({ ok: true });
    expect(retries()).toEqual([
      undefined,
      { requestState: "s1", resolvedArguments },
      { requestState: "s2", resolvedArguments },
    ]);
  });

  it("retries an approved continuation with inputResponses, requestState, and resolved arguments, not attempt", async () => {
    const { ctx, executeTool, retries, run } = setup({ executeTool: async () => completed });
    approveContinuation(ctx, "call_1", {
      attempt: 1,
      inputResponses: { confirm: { action: "accept" } },
      requestState: SECRET_STATE,
      resolvedArguments,
    });

    await expect(run("call_1")).resolves.toEqual({ ok: true });
    expect(executeTool.mock.calls[0]![2].callId).toBe("call_1");
    expect(retries()).toEqual([
      {
        inputResponses: { confirm: { action: "accept" } },
        requestState: SECRET_STATE,
        resolvedArguments,
      },
    ]);
    expect(retries()[0]).not.toHaveProperty("attempt");
  });

  describe("bounds", () => {
    it("fails after 3 state-only retries", async () => {
      const { executeTool, run } = setup({
        executeTool: async () => inputRequired({ requestState: SECRET_STATE }),
        requestInput: true,
      });

      await expect(run()).rejects.toThrow(
        "billing__refund kept asking to retry without saying what it needs.",
      );
      // The first call plus three retries.
      expect(executeTool).toHaveBeenCalledTimes(4);
    });

    it.each([
      [2, { attempt: 3 }],
      [3, "billing__refund asked for input 3 times without finishing."],
    ])("after ask %i of 3, a re-ask yields %j", async (asked, expected) => {
      const { ctx, executeTool, run } = setup({
        executeTool: async () => signInUrl,
        requestInput: true,
      });
      approveContinuation(ctx, "call_1", { attempt: asked, inputResponses: {}, requestState: "s" });

      const outcome = run("call_1");

      if (typeof expected === "string") await expect(outcome).rejects.toThrow(expected);
      else expect(((await outcome) as RemoteInputSignal).approve).toMatchObject(expected);
      expect(executeTool).toHaveBeenCalledOnce();
    });
  });
});
