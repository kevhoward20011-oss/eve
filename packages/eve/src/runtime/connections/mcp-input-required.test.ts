import { describe, expect, it, vi } from "vitest";

import {
  createMcpInputRequiredFetch,
  parseInputRequiredResult,
  planMcpInput,
  runMcpRequestScope,
} from "#runtime/connections/mcp-input-required.js";

const FORM = JSON.stringify({
  method: "elicitation/create",
  params: {
    message: "Delete the repo?",
    requestedSchema: { properties: { confirm: { type: "boolean" } }, type: "object" },
  },
});
const REQUESTS = `{"approve":${FORM}}`;

function event(id: unknown = 1, requests = REQUESTS): string {
  const result = `{"inputRequests":${requests},"requestState":"s1","resultType":"input_required"}`;
  return `data: {"id":${JSON.stringify(id)},"jsonrpc":"2.0","result":${result}}`;
}

const json = event().slice("data: ".length);
const comma = json.indexOf(",") + 1;

function sseFetch(chunks: readonly string[]): typeof fetch {
  const encoder = new TextEncoder();
  return createMcpInputRequiredFetch(
    async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
            controller.close();
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
  );
}

// Capture must agree with the SDK's SSE parser: only a complete, unnamed or
// `message` event answering this request id decides the call. `captured` is
// the inputRequests JSON eve must hand back, or undefined for the SDK's error.
describe("input_required capture at the transport fetch", () => {
  it.each<{ name: string; chunks: string[]; captured?: string }>([
    { name: "an unnamed event", chunks: [`${event()}\n\n`], captured: REQUESTS },
    { name: "a `message` event", chunks: [`event: message\n${event()}\n\n`], captured: REQUESTS },
    { name: "an event of another type", chunks: [`event: other\n${event()}\n\n`] },
    { name: "a result for another request id", chunks: [`${event(99)}\n\n`] },
    ...(["\n", "\r", "\r\n"] as const).flatMap((eol) => [
      {
        name: `a ${JSON.stringify(eol)}-terminated event`,
        chunks: [event() + eol + eol],
        captured: REQUESTS,
      },
      { name: `an unterminated ${JSON.stringify(eol)} event`, chunks: [event() + eol] },
    ]),
    {
      name: "an event split mid-line across chunks",
      chunks: [`${event()}\n\n`.slice(0, 40), `${event()}\n\n`.slice(40)],
      captured: REQUESTS,
    },
    {
      // Ending the line on the CR alone reads the LF as a blank line.
      name: "a multiline event whose CRLF is split across chunks",
      chunks: [`data: ${json.slice(0, comma)}\r`, `\ndata: ${json.slice(comma)}\r\n\r\n`],
      captured: REQUESTS,
    },
    {
      // The held-back trailing CR may start a CRLF; the final CR ends the event.
      name: "a lone CR that is the stream's last byte",
      chunks: [`${event()}\r`, "\r"],
      captured: REQUESTS,
    },
    {
      // Request ids are server-chosen keys and must stay ordinary entries.
      name: "a request id named __proto__",
      chunks: [`${event(1, `{"__proto__":${FORM}}`)}\n\n`],
      captured: `{"__proto__":${FORM}}`,
    },
  ])("$name", async ({ chunks, captured }) => {
    const fetcher = sseFetch(chunks);
    const sdkError = new Error("SDK: unknown result or stream ended");
    let seen = "";
    const body = JSON.stringify({ id: 1, jsonrpc: "2.0", method: "tools/call", params: {} });

    const outcome = runMcpRequestScope({
      execute: async () => {
        seen = await (await fetcher("https://mcp.example.com", { body, method: "POST" })).text();
        throw sdkError;
      },
    });

    // The SDK reads the exact bytes the server sent.
    if (captured === undefined) {
      await expect(outcome).rejects.toBe(sdkError);
      expect(seen).toBe(chunks.join(""));
      return;
    }
    const result = await outcome;
    expect(seen).toBe(chunks.join(""));
    if (result.status !== "input_required") throw new Error(`unexpected ${result.status}`);
    expect(result.requestState).toBe("s1");
    expect(JSON.stringify(result.inputRequests)).toBe(captured);
    const plan = planMcpInput(result);
    if (!("approve" in plan)) throw new Error(`unexpected plan ${plan.kind}`);
    expect(Object.keys(plan.approve)).toEqual(Object.keys(JSON.parse(captured) as object));
  });

  it("keeps concurrent scopes separate", async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const base = vi.fn(async (_request: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { id: number };
      if (body.id === 1) {
        await firstGate;
        return jsonResponse(inputRequiredMessage(1, "state-a"));
      }
      return jsonResponse({ id: 2, jsonrpc: "2.0", result: { content: [] } });
    });
    const fetcher = createMcpInputRequiredFetch(base);

    const first = runMcpRequestScope({
      execute: () => sdkCall(fetcher, toolsCallBody(1)),
      retry: { requestState: "retry-a" },
    });
    const second = runMcpRequestScope({
      execute: () => sdkCall(fetcher, toolsCallBody(2)),
      retry: { inputResponses: { b: { action: "decline" } }, requestState: "retry-b" },
    });
    await expect(second).resolves.toMatchObject({ status: "completed" });
    releaseFirst();
    await expect(first).resolves.toMatchObject({
      requestState: "state-a",
      status: "input_required",
    });

    const sent = base.mock.calls.map(
      ([, init]) =>
        JSON.parse(String(init?.body)) as { id: number; params: Record<string, unknown> },
    );
    const a = sent.find((m) => m.id === 1)!;
    const b = sent.find((m) => m.id === 2)!;
    expect(a.params["requestState"]).toBe("retry-a");
    expect(a.params).not.toHaveProperty("inputResponses");
    expect(b.params["requestState"]).toBe("retry-b");
    expect(b.params["inputResponses"]).toEqual({ b: { action: "decline" } });
  });
});

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
}

function inputRequiredMessage(id: number, requestState: string) {
  return {
    id,
    jsonrpc: "2.0",
    result: {
      inputRequests: { approve: JSON.parse(FORM) },
      requestState,
      resultType: "input_required",
    },
  };
}

function toolsCallBody(id: number): string {
  return JSON.stringify({
    id,
    jsonrpc: "2.0",
    method: "tools/call",
    params: { arguments: {}, name: "danger" },
  });
}

async function sdkCall(fetcher: typeof fetch, body: string): Promise<unknown> {
  const text = await (await fetcher("https://mcp.example.com", { body, method: "POST" })).text();
  if (text.includes("input_required")) throw new Error("SDK: unknown result");
  return text;
}

// What an untrusted server sends lands in session state and the user's prompt.
it("refuses input_required content over its caps", () => {
  const elicit = (params: object) => ({ method: "elicitation/create", params });
  const many = Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`r${i}`, elicit({})]));
  const rows: Array<[Record<string, unknown>, string | undefined]> = [
    [{ requestState: "s".repeat(64 * 1024) }, undefined],
    [{ requestState: "s".repeat(64 * 1024 + 1) }, "requestState over 65536"],
    [{ inputRequests: many }, "more than 16 inputRequests"],
    [{ inputRequests: { a: elicit({ message: "m".repeat(8 * 1024 + 1) }) } }, "message over 8192"],
    [
      { inputRequests: { a: elicit({ url: `https://x/${"u".repeat(8 * 1024)}` }) } },
      "url over 8192",
    ],
  ];
  for (const [result, refused] of rows) {
    const parsed = parseInputRequiredResult(result);
    if (refused === undefined) expect(typeof parsed).toBe("object");
    else expect(parsed).toContain(refused);
  }
});
