import { describe, expect, it } from "vitest";

import {
  createMcpInputRequiredFetch,
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
});
