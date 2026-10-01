import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ContextContainer, contextStorage } from "#context/container.js";
import { AuthKey, SessionIdKey, SessionKey } from "#context/keys.js";
import { isMcpInputRequiredOutcome, McpConnectionClient } from "#runtime/connections/mcp-client.js";
import { TOOL_SESSION_META_KEY } from "#runtime/connections/mcp-forwarding.js";
import type { ResolvedConnectionDefinition } from "#runtime/types.js";

/**
 * MRTR through the real bundled `@ai-sdk/mcp` client: only HTTP I/O is
 * replaced. These lock what the SDK decides and eve must agree with (which
 * SSE events count, cancellation) and what eve puts on the wire around it.
 */

const PROTOCOL = "2026-07-28";

const INPUT_REQUESTS = {
  "dev.eve/approval": {
    method: "elicitation/create",
    params: {
      message: "Allow deploy?",
      mode: "form",
      requestedSchema: {
        properties: { approved: { type: "boolean" } },
        required: ["approved"],
        type: "object",
      },
    },
  },
};

const INPUT_REQUIRED = {
  inputRequests: INPUT_REQUESTS,
  requestState: "state-1",
  resultType: "input_required",
};

const COMPLETED = {
  content: [{ text: "deployed", type: "text" }],
  isError: false,
  resultType: "complete",
};

type ToolsCall = (id: number, body: Record<string, unknown>) => Response | Promise<Response>;

let toolsCall: ToolsCall;
let serverCapabilities: Record<string, unknown>;
const callBodies: Record<string, unknown>[] = [];
let client: McpConnectionClient | undefined;

function connection(
  overrides: Partial<ResolvedConnectionDefinition> = {},
): ResolvedConnectionDefinition {
  return {
    connectionName: "ops",
    description: "Ops",
    logicalPath: "connections/ops.ts",
    protocol: "mcp",
    sourceId: "connections/ops",
    sourceKind: "module",
    url: "https://mcp.example.com/mcp",
    ...overrides,
  } as ResolvedConnectionDefinition;
}

function sse(text: string): Response {
  return new Response(text, { headers: { "content-type": "text/event-stream" } });
}

function frame(id: number, result: unknown, event?: string): string {
  const head = event === undefined ? "" : `event: ${event}\n`;
  return `${head}data: ${JSON.stringify({ id, jsonrpc: "2.0", result })}\n\n`;
}

async function run<T>(fn: () => Promise<T>): Promise<T> {
  const ctx = new ContextContainer();
  ctx.set(AuthKey, null);
  ctx.set(SessionIdKey, "session-1");
  ctx.set(SessionKey, {
    auth: { current: null, initiator: null },
    sessionId: "session-1",
    turn: { id: "turn-1", sequence: 0 },
  });
  return await contextStorage.run(ctx, fn);
}

beforeEach(() => {
  callBodies.length = 0;
  serverCapabilities = { tools: {} };
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    const message = (await request.json()) as {
      id: number;
      method: string;
      params?: Record<string, unknown>;
    };
    switch (message.method) {
      case "server/discover":
        return Response.json({
          id: message.id,
          jsonrpc: "2.0",
          result: {
            capabilities: serverCapabilities,
            resultType: "complete",
            serverInfo: { name: "ops", version: "1.0.0" },
            supportedVersions: [PROTOCOL],
          },
        });
      case "tools/list":
        return Response.json({
          id: message.id,
          jsonrpc: "2.0",
          result: {
            resultType: "complete",
            tools: [
              {
                inputSchema: {
                  properties: { context: { type: "object" }, query: { type: "string" } },
                  type: "object",
                },
                name: "deploy",
              },
            ],
          },
        });
      case "tools/call":
        callBodies.push(message.params ?? {});
        return await toolsCall(message.id, message.params ?? {});
      default:
        throw new Error(`Unexpected MCP method: ${message.method}`);
    }
  });
});

afterEach(async () => {
  await client?.close();
  client = undefined;
  vi.unstubAllGlobals();
});

describe("MRTR with the bundled MCP client", () => {
  it.each([
    ["an unnamed", undefined],
    ["a `message`", "message"],
  ])("returns input_required from %s SSE event split across chunks", async (_label, event) => {
    toolsCall = (id) => {
      const text = frame(id, INPUT_REQUIRED, event);
      const encoder = new TextEncoder();
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            for (let index = 0; index < text.length; index += 7) {
              controller.enqueue(encoder.encode(text.slice(index, index + 7)));
            }
            controller.close();
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    };
    client = new McpConnectionClient(connection());

    const result = await run(() => client!.executeTool("deploy", {}, { callId: "c1" }));

    expect(isMcpInputRequiredOutcome(result)).toBe(true);
    expect(result).toMatchObject({ inputRequests: INPUT_REQUESTS, requestState: "state-1" });
    expect(result).not.toHaveProperty("status");
  });

  it("keeps the SDK's completed result when an ignored event type carries input_required", async () => {
    toolsCall = (id) => sse(frame(id, INPUT_REQUIRED, "other") + frame(id, COMPLETED, "message"));
    client = new McpConnectionClient(connection());

    const result = await run(() => client!.executeTool("deploy", {}, { callId: "c1" }));

    expect(isMcpInputRequiredOutcome(result)).toBe(false);
    expect(result).toMatchObject({ content: [{ text: "deployed", type: "text" }] });
    expect(callBodies).toHaveLength(1);
  });

  it("ignores an input_required result that follows the call's first answer", async () => {
    toolsCall = (id) => sse(frame(id, COMPLETED) + frame(id, INPUT_REQUIRED));
    client = new McpConnectionClient(connection());

    const result = await run(() => client!.executeTool("deploy", {}, { callId: "c1" }));

    expect(isMcpInputRequiredOutcome(result)).toBe(false);
    expect(callBodies).toHaveLength(1);
  });

  it("does not capture an event the stream ends before finishing", async () => {
    // The SDK's parser drops an unterminated event and keeps waiting, so the
    // call ends only when it is cancelled, and it ends cancelled.
    toolsCall = (id) => sse(frame(id, INPUT_REQUIRED).replace(/\n\n$/u, "\n"));
    client = new McpConnectionClient(connection());
    const controller = new AbortController();

    const pending = run(() =>
      client!.executeTool("deploy", {}, { abortSignal: controller.signal, callId: "c1" }),
    );
    await vi.waitFor(() => expect(callBodies).toHaveLength(1));
    controller.abort(new Error("cancelled by test"));

    await expect(pending).rejects.toThrow(/abort/iu);
    expect(callBodies).toHaveLength(1);
  });

  it("retries with inputResponses, requestState, and the first round's resolved arguments", async () => {
    // The server binds `requestState` to the arguments; a provided-arguments
    // callback that returns something new each call must not change them.
    let nonce = 0;
    const resolver = vi.fn(() => ({ nonce: ++nonce }));
    toolsCall = (id) =>
      sse(
        frame(
          id,
          callBodies.length === 1
            ? { requestState: "s1", resultType: "input_required" }
            : COMPLETED,
        ),
      );
    client = new McpConnectionClient(
      connection({ toolCall: { providedArguments: { context: resolver } } }),
    );
    const inputResponses = {
      "dev.eve/approval": { action: "accept", content: { approved: true } },
    };

    const done = await run(async () => {
      const first = await client!.executeTool("deploy", { query: "q" }, { callId: "c1" });
      if (!isMcpInputRequiredOutcome(first)) throw new Error("expected input_required");
      return await client!.executeTool(
        "deploy",
        { query: "q" },
        {
          callId: "c1",
          inputRetry: {
            inputResponses,
            requestState: first.requestState,
            resolvedArguments: first.resolvedArguments,
          },
        },
      );
    });

    expect(done).toMatchObject({ content: [{ text: "deployed", type: "text" }] });
    expect(resolver).toHaveBeenCalledOnce();
    expect(callBodies).toHaveLength(2);
    expect(callBodies[0]).not.toHaveProperty("requestState");
    expect(callBodies[1]).toMatchObject({
      arguments: { context: { nonce: 1 }, query: "q" },
      inputResponses,
      name: "deploy",
      requestState: "s1",
    });
    expect(callBodies[1]).not.toHaveProperty("resolvedArguments");
  });

  it.each([
    ["sends", { "dev.eve/tool-sessions": {} }, true],
    ["withholds", undefined, false],
  ])(
    "%s the tool-session key when the server's extensions are %j",
    async (_label, extensions, sent) => {
      serverCapabilities = extensions === undefined ? { tools: {} } : { extensions, tools: {} };
      toolsCall = (id) => sse(frame(id, COMPLETED));
      client = new McpConnectionClient(connection());

      await run(() => client!.executeTool("deploy", {}, { callId: "c1" }));

      const meta = (callBodies[0]?.["_meta"] ?? {}) as Record<string, unknown>;
      if (sent) expect(meta[TOOL_SESSION_META_KEY]).toEqual(expect.any(String));
      else expect(meta).not.toHaveProperty(TOOL_SESSION_META_KEY);
    },
  );
});
