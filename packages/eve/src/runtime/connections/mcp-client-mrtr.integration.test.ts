import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ContextContainer, contextStorage } from "#context/container.js";
import { AuthKey } from "#context/keys.js";
import { isMcpInputRequiredOutcome, McpConnectionClient } from "#runtime/connections/mcp-client.js";
import type { ResolvedConnectionDefinition } from "#runtime/types.js";

/**
 * MRTR capture through the real bundled `@ai-sdk/mcp` client: only HTTP I/O is
 * replaced. These lock the two transport boundaries the SDK decides and eve's
 * capture must agree with: which SSE events count, and cancellation.
 */

const PROTOCOL = "2026-07-28";

const INPUT_REQUIRED = {
  inputRequests: {
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
  },
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
const callBodies: Record<string, unknown>[] = [];
let client: McpConnectionClient | undefined;

function connection(): ResolvedConnectionDefinition {
  return {
    connectionName: "ops",
    description: "Ops",
    logicalPath: "connections/ops.ts",
    protocol: "mcp",
    sourceId: "connections/ops",
    sourceKind: "module",
    url: "https://mcp.example.com/mcp",
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
  return await contextStorage.run(ctx, fn);
}

beforeEach(() => {
  callBodies.length = 0;
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
            capabilities: { tools: {} },
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
            tools: [{ inputSchema: { properties: {}, type: "object" }, name: "deploy" }],
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

describe("MRTR capture with the bundled MCP client", () => {
  it("captures an input_required result in a default SSE event", async () => {
    toolsCall = (id) => sse(frame(id, INPUT_REQUIRED));
    client = new McpConnectionClient(connection());

    const result = await run(() => client!.executeTool("deploy", {}, { callId: "c1" }));

    expect(isMcpInputRequiredOutcome(result)).toBe(true);
    expect(result).toMatchObject({ requestState: "state-1" });
  });

  it("captures one split across chunks in a `message` event", async () => {
    toolsCall = (id) => {
      const text = frame(id, INPUT_REQUIRED, "message");
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

    expect(result).toMatchObject({ requestState: "state-1" });
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
});
