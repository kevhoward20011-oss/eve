import { describe, expect, it, vi } from "vitest";

import {
  createMcpInputRequiredFetch,
  parseInputRequiredResult,
  planMcpInput,
  runMcpRequestScope,
} from "#runtime/connections/mcp-input-required.js";

type FetchArgs = [Parameters<typeof fetch>[0], Parameters<typeof fetch>[1]];

const INPUT_REQUESTS = {
  approve: {
    method: "elicitation/create",
    params: {
      message: "Delete the repo?",
      requestedSchema: { properties: { confirm: { type: "boolean" } }, type: "object" },
    },
  },
};

function inputRequiredMessage(id: unknown = 1, requestState = "s1") {
  return {
    id,
    jsonrpc: "2.0",
    result: { inputRequests: INPUT_REQUESTS, requestState, resultType: "input_required" },
  };
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
  });
}

function sseResponse(value: unknown): Response {
  return new Response(`event: message\ndata: ${JSON.stringify(value)}\n\n`, {
    headers: { "content-type": "text/event-stream" },
  });
}

function toolsCallBody(id: unknown = 1, params: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id,
    jsonrpc: "2.0",
    method: "tools/call",
    params: { arguments: {}, name: "danger", ...params },
  });
}

/** Mimics the SDK: reads the response, throws on input_required. */
async function sdkCall(fetcher: typeof fetch, body: string): Promise<unknown> {
  const response = await fetcher("https://mcp.example.com", { body, method: "POST" });
  const text = await response.text();
  if (text.includes("input_required")) throw new Error("SDK: unknown result");
  return text;
}

function bodyOf(fetcher: ReturnType<typeof vi.fn>, call = 0): Record<string, unknown> {
  const init = fetcher.mock.calls[call]?.[1] as RequestInit | undefined;
  return JSON.parse(String(init?.body)) as Record<string, unknown>;
}

describe("createMcpInputRequiredFetch + runMcpRequestScope", () => {
  it("captures a JSON input_required result and returns it instead of the SDK error", async () => {
    const base = vi.fn(async (..._args: FetchArgs) => jsonResponse(inputRequiredMessage()));
    const fetcher = createMcpInputRequiredFetch(base);

    const outcome = await runMcpRequestScope({ execute: () => sdkCall(fetcher, toolsCallBody()) });

    expect(outcome).toEqual({
      inputRequests: INPUT_REQUESTS,
      requestState: "s1",
      status: "input_required",
    });
  });

  it("captures an SSE input_required result and passes bytes through unchanged", async () => {
    const message = inputRequiredMessage();
    const base = vi.fn(async (..._args: FetchArgs) => sseResponse(message));
    const fetcher = createMcpInputRequiredFetch(base);
    let seen = "";

    const outcome = await runMcpRequestScope({
      execute: async () => {
        const response = await fetcher("https://mcp.example.com", {
          body: toolsCallBody(),
          method: "POST",
        });
        expect(response.headers.get("content-type")).toBe("text/event-stream");
        seen = await response.text();
        throw new Error("SDK: unknown result");
      },
    });

    expect(seen).toBe(`event: message\ndata: ${JSON.stringify(message)}\n\n`);
    expect(outcome).toEqual({
      inputRequests: INPUT_REQUESTS,
      requestState: "s1",
      status: "input_required",
    });
  });

  it("rethrows a cancellation that lands after input_required was captured", async () => {
    const base = vi.fn(async (..._args: FetchArgs) => sseResponse(inputRequiredMessage()));
    const fetcher = createMcpInputRequiredFetch(base);
    const controller = new AbortController();
    const aborted = new Error("Request was aborted");

    const outcome = runMcpRequestScope({
      abortSignal: controller.signal,
      execute: async () => {
        const response = await fetcher("https://mcp.example.com", {
          body: toolsCallBody(),
          method: "POST",
        });
        await response.text(); // captured
        controller.abort(aborted); // then cancelled, before the SDK settles
        throw aborted;
      },
    });

    await expect(outcome).rejects.toBe(aborted);
  });

  it("rethrows a cancellation even when the SDK error was swallowed inside the scope", async () => {
    const base = vi.fn(async (..._args: FetchArgs) => sseResponse(inputRequiredMessage()));
    const fetcher = createMcpInputRequiredFetch(base);
    const controller = new AbortController();
    const aborted = new Error("Request was aborted");

    const outcome = runMcpRequestScope({
      abortSignal: controller.signal,
      execute: async () => {
        await (
          await fetcher("https://mcp.example.com", { body: toolsCallBody(), method: "POST" })
        ).text();
        controller.abort(aborted);
        return "placeholder"; // a trace span that ended cleanly on the SDK error
      },
    });

    await expect(outcome).rejects.toBe(aborted);
  });

  it("ignores data in SSE events of other types", async () => {
    const base = vi.fn(
      async (..._args: FetchArgs) =>
        new Response(`event: other\ndata: ${JSON.stringify(inputRequiredMessage())}\n\n`, {
          headers: { "content-type": "text/event-stream" },
        }),
    );
    const fetcher = createMcpInputRequiredFetch(base);

    const outcome = await runMcpRequestScope({
      execute: async () => {
        await (
          await fetcher("https://mcp.example.com", { body: toolsCallBody(), method: "POST" })
        ).text();
        return "done";
      },
    });

    expect(outcome).toEqual({ status: "completed", value: "done" });
  });

  describe.each([
    ["LF", "\n"],
    ["CR", "\r"],
    ["CRLF", "\r\n"],
  ])("an SSE event at end of stream (%s)", (_label, eol) => {
    function streamOf(text: string): typeof fetch {
      return createMcpInputRequiredFetch(
        vi.fn(
          async (..._args: FetchArgs) =>
            new Response(text, { headers: { "content-type": "text/event-stream" } }),
        ),
      );
    }

    it("is not captured without a terminating blank line, so a later error comes through", async () => {
      const fetcher = streamOf(`data: ${JSON.stringify(inputRequiredMessage())}${eol}`);
      const later = new Error("SDK: stream ended without a response");

      const outcome = runMcpRequestScope({
        execute: async () => {
          await (
            await fetcher("https://mcp.example.com", { body: toolsCallBody(), method: "POST" })
          ).text();
          throw later;
        },
      });

      await expect(outcome).rejects.toBe(later);
    });

    it("is captured when a blank line terminates it", async () => {
      const fetcher = streamOf(`data: ${JSON.stringify(inputRequiredMessage())}${eol}${eol}`);

      const outcome = await runMcpRequestScope({
        execute: async () => {
          await (
            await fetcher("https://mcp.example.com", { body: toolsCallBody(), method: "POST" })
          ).text();
          throw new Error("SDK: unknown result");
        },
      });

      expect(outcome).toMatchObject({ requestState: "s1", status: "input_required" });
    });
  });

  it("captures SSE split across chunks", async () => {
    const text = `data: ${JSON.stringify(inputRequiredMessage())}\n\n`;
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const mid = Math.floor(text.length / 2);
        controller.enqueue(encoder.encode(text.slice(0, mid)));
        controller.enqueue(encoder.encode(text.slice(mid)));
        controller.close();
      },
    });
    const base = vi.fn(
      async (..._args: FetchArgs) =>
        new Response(stream, { headers: { "content-type": "text/event-stream" } }),
    );
    const fetcher = createMcpInputRequiredFetch(base);

    const outcome = await runMcpRequestScope({ execute: () => sdkCall(fetcher, toolsCallBody()) });

    expect(outcome).toMatchObject({ requestState: "s1", status: "input_required" });
  });

  it("keeps a multiline SSE event whole when a CRLF is split across chunks", async () => {
    // The JSON spans two `data:` lines; the chunk boundary falls inside the
    // CRLF between them, so a scanner that ends the line on the CR alone reads
    // the LF as a blank line and flushes half an event.
    const [head, tail] = JSON.stringify(inputRequiredMessage()).split(/(?<=,)/u, 2) as [
      string,
      string,
    ];
    const rest = JSON.stringify(inputRequiredMessage()).slice(head.length + tail.length);
    const chunks = [`data: ${head}\r`, `\ndata: ${tail}${rest}\r\n\r\n`];
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    });
    const base = vi.fn(
      async (..._args: FetchArgs) =>
        new Response(stream, { headers: { "content-type": "text/event-stream" } }),
    );
    const fetcher = createMcpInputRequiredFetch(base);

    const outcome = await runMcpRequestScope({ execute: () => sdkCall(fetcher, toolsCallBody()) });

    expect(outcome).toMatchObject({ requestState: "s1", status: "input_required" });
  });

  it("keeps a lone CR as a line ending when it is the last byte of the stream", async () => {
    // The first chunk's trailing CR is held back (it may start a CRLF); the
    // final CR then ends the event as a blank line.
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(inputRequiredMessage())}\r`));
        controller.enqueue(encoder.encode("\r"));
        controller.close();
      },
    });
    const base = vi.fn(
      async (..._args: FetchArgs) =>
        new Response(stream, { headers: { "content-type": "text/event-stream" } }),
    );
    const fetcher = createMcpInputRequiredFetch(base);

    const outcome = await runMcpRequestScope({ execute: () => sdkCall(fetcher, toolsCallBody()) });

    expect(outcome).toMatchObject({ requestState: "s1", status: "input_required" });
  });

  it("returns a normal completed result", async () => {
    const completed = { id: 1, jsonrpc: "2.0", result: { content: [], isError: false } };
    const base = vi.fn(async (..._args: FetchArgs) => jsonResponse(completed));
    const fetcher = createMcpInputRequiredFetch(base);

    const outcome = await runMcpRequestScope({
      execute: async () => {
        const response = await fetcher("https://mcp.example.com", {
          body: toolsCallBody(),
          method: "POST",
        });
        return (await response.json()) as unknown;
      },
    });

    expect(outcome).toEqual({ status: "completed", value: completed });
  });

  it("ignores an input_required result for a different request id", async () => {
    const base = vi.fn(async (..._args: FetchArgs) => jsonResponse(inputRequiredMessage(99)));
    const fetcher = createMcpInputRequiredFetch(base);

    await expect(
      runMcpRequestScope({ execute: () => sdkCall(fetcher, toolsCallBody(1)) }),
    ).rejects.toThrow("SDK: unknown result");
  });

  it("rethrows unrelated failures unchanged", async () => {
    const error = new Error("boom");
    await expect(
      runMcpRequestScope({
        execute: async () => {
          throw error;
        },
      }),
    ).rejects.toBe(error);
  });

  it("throws on a malformed input_required result", async () => {
    const base = vi.fn(async (..._args: FetchArgs) =>
      jsonResponse({ id: 1, jsonrpc: "2.0", result: { resultType: "input_required" } }),
    );
    const fetcher = createMcpInputRequiredFetch(base);

    await expect(
      runMcpRequestScope({ execute: () => sdkCall(fetcher, toolsCallBody()) }),
    ).rejects.toThrow("without inputRequests or requestState");
  });

  it("injects inputResponses and an exact requestState echo on retry", async () => {
    const base = vi.fn(async (..._args: FetchArgs) =>
      jsonResponse({ id: 1, jsonrpc: "2.0", result: { content: [] } }),
    );
    const fetcher = createMcpInputRequiredFetch(base);
    const requestState = "opaque/+=state with spaces ✓";
    const inputResponses = { approve: { action: "accept", content: { confirm: true } } };

    await runMcpRequestScope({
      execute: () => sdkCall(fetcher, toolsCallBody(1, { _meta: { keep: "me" } })),
      retry: { inputResponses, requestState },
    });

    const params = bodyOf(base)["params"] as Record<string, unknown>;
    expect(params["inputResponses"]).toEqual(inputResponses);
    expect(params["requestState"]).toBe(requestState);
    expect(params["name"]).toBe("danger");
    expect(params["_meta"]).toEqual({ keep: "me" });
  });

  it("leaves non-MRTR methods like tools/list untouched inside a retry scope", async () => {
    const base = vi.fn(async (..._args: FetchArgs) =>
      jsonResponse({ id: 2, jsonrpc: "2.0", result: { tools: [] } }),
    );
    const fetcher = createMcpInputRequiredFetch(base);
    const init = {
      body: JSON.stringify({ id: 2, jsonrpc: "2.0", method: "tools/list", params: {} }),
      method: "POST",
    } satisfies RequestInit;

    await runMcpRequestScope({
      execute: () => fetcher("https://mcp.example.com", init),
      retry: { inputResponses: { a: {} }, requestState: "s1" },
    });

    expect(base.mock.calls[0]?.[1]).toBe(init);
  });

  it("passes requests outside a scope through untouched", async () => {
    const base = vi.fn(async (..._args: FetchArgs) => jsonResponse(inputRequiredMessage()));
    const fetcher = createMcpInputRequiredFetch(base);
    const init = { body: toolsCallBody(), method: "POST" } satisfies RequestInit;

    await fetcher("https://mcp.example.com", init);

    expect(base.mock.calls[0]?.[1]).toBe(init);
  });

  it("strips elicitation capabilities from initialize", async () => {
    const base = vi.fn(async (..._args: FetchArgs) => jsonResponse({}));
    const fetcher = createMcpInputRequiredFetch(base);

    await fetcher("https://mcp.example.com", {
      body: JSON.stringify({
        id: 0,
        jsonrpc: "2.0",
        method: "initialize",
        params: { capabilities: { elicitation: { form: {} }, extensions: { x: {} } } },
      }),
      method: "POST",
    });

    expect((bodyOf(base)["params"] as Record<string, unknown>)["capabilities"]).toEqual({
      extensions: { x: {} },
    });
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

describe("parseInputRequiredResult", () => {
  it("rejects a result with neither inputRequests nor requestState", () => {
    expect(parseInputRequiredResult({ resultType: "input_required" })).toEqual(
      expect.stringContaining("without inputRequests or requestState"),
    );
  });

  it("rejects a non-string requestState", () => {
    expect(typeof parseInputRequiredResult({ requestState: 1 })).toBe("string");
  });

  it("rejects malformed requests", () => {
    expect(typeof parseInputRequiredResult({ inputRequests: { a: { params: {} } } })).toBe(
      "string",
    );
    expect(
      typeof parseInputRequiredResult({ inputRequests: { a: { method: "x", params: 1 } } }),
    ).toBe("string");
    expect(typeof parseInputRequiredResult({ inputRequests: [] })).toBe("string");
  });

  it("keeps a request id named __proto__ as an ordinary entry", () => {
    const result = JSON.parse(
      `{"inputRequests":{"__proto__":${JSON.stringify(INPUT_REQUESTS.approve)}},"requestState":"s"}`,
    ) as Record<string, unknown>;

    const parsed = parseInputRequiredResult(result);

    expect(typeof parsed).toBe("object");
    const requests = (parsed as { inputRequests: Record<string, unknown> }).inputRequests;
    expect(Object.keys(requests)).toEqual(["__proto__"]);
    expect(Object.getPrototypeOf(requests)).toBeNull();
    expect(planMcpInput(parsed as never)).toMatchObject({
      approve: { ["__proto__"]: { action: "accept", content: { confirm: true } } },
      kind: "approval",
    });
  });

  it("accepts requestState alone", () => {
    expect(parseInputRequiredResult({ requestState: "s" })).toEqual({ requestState: "s" });
  });
});

describe("planMcpInput", () => {
  it("plans a retry when there are no inputRequests", () => {
    expect(planMcpInput({ requestState: "s" })).toEqual({ kind: "retry" });
  });

  it("plans an approval for a single boolean form elicitation", () => {
    expect(planMcpInput({ inputRequests: INPUT_REQUESTS, requestState: "s1" })).toEqual({
      approve: { approve: { action: "accept", content: { confirm: true } } },
      kind: "approval",
      prompt: "Delete the repo?",
    });
  });

  it("plans a sign-in for an https URL elicitation", () => {
    expect(
      planMcpInput({
        inputRequests: {
          login: {
            method: "elicitation/create",
            params: { message: "Sign in", mode: "url", url: "https://idp.example.com/a" },
          },
        },
      }),
    ).toEqual({
      approve: { login: { action: "accept" } },
      kind: "sign-in",
      links: [{ message: "Sign in", url: "https://idp.example.com/a" }],
    });
  });

  it("plans one sign-in for several URL elicitations, as mcpChannel sends per connection", () => {
    expect(
      planMcpInput({
        inputRequests: {
          "auth/github": {
            method: "elicitation/create",
            params: { mode: "url", url: "https://github.example/authorize" },
          },
          "auth/linear": {
            method: "elicitation/create",
            params: { message: "Sign in to Linear", mode: "url", url: "https://linear.example/a" },
          },
        },
      }),
    ).toEqual({
      approve: { "auth/github": { action: "accept" }, "auth/linear": { action: "accept" } },
      kind: "sign-in",
      links: [
        { url: "https://github.example/authorize" },
        { message: "Sign in to Linear", url: "https://linear.example/a" },
      ],
    });
  });

  it("answers a sign-in request id named __proto__", () => {
    const parsed = parseInputRequiredResult(
      JSON.parse(
        `{"inputRequests":{"__proto__":{"method":"elicitation/create","params":{"mode":"url","url":"https://idp.example.com/a"}}}}`,
      ) as Record<string, unknown>,
    );

    const plan = planMcpInput(parsed as never);

    expect(plan.kind).toBe("sign-in");
    const approve = (plan as { approve: Record<string, unknown> }).approve;
    expect(Object.keys(approve)).toEqual(["__proto__"]);
    expect(JSON.parse(JSON.stringify(approve))).toEqual(
      JSON.parse(`{"__proto__":{"action":"accept"}}`),
    );
  });

  it("refuses a mix of a URL and a form elicitation", () => {
    expect(
      planMcpInput({
        inputRequests: {
          a: { method: "elicitation/create", params: { mode: "url", url: "https://x.example" } },
          b: { method: "elicitation/create", params: { mode: "form", requestedSchema: {} } },
        },
      }).kind,
    ).toBe("unsupported");
  });

  it("rejects a javascript: URL elicitation", () => {
    expect(
      planMcpInput({
        inputRequests: {
          login: {
            method: "elicitation/create",
            params: { mode: "url", url: "javascript:alert(1)" },
          },
        },
      }),
    ).toMatchObject({ kind: "unsupported" });
  });

  it("rejects multiple requests", () => {
    expect(
      planMcpInput({ inputRequests: { ...INPUT_REQUESTS, other: INPUT_REQUESTS.approve } }),
    ).toMatchObject({ kind: "unsupported" });
  });

  it("rejects sampling/createMessage", () => {
    expect(
      planMcpInput({ inputRequests: { s: { method: "sampling/createMessage", params: {} } } }),
    ).toMatchObject({ kind: "unsupported" });
  });

  it("rejects a non-boolean form", () => {
    expect(
      planMcpInput({
        inputRequests: {
          f: {
            method: "elicitation/create",
            params: {
              message: "Name?",
              requestedSchema: { properties: { name: { type: "string" } }, type: "object" },
            },
          },
        },
      }),
    ).toMatchObject({ kind: "unsupported" });
  });
});
