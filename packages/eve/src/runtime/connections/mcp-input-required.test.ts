import { describe, expect, it, vi } from "vitest";

import {
  createMcpInputRequiredFetch,
  parseInputRequiredResult,
  planMcpInput,
  runMcpRequestScope,
  type McpInputRequest,
} from "#runtime/connections/mcp-input-required.js";

type FetchArgs = [Parameters<typeof fetch>[0], Parameters<typeof fetch>[1]];

const ENDPOINT = "https://mcp.example.com";

const APPROVAL_FORM: McpInputRequest = {
  method: "elicitation/create",
  params: {
    message: "Delete the repo?",
    requestedSchema: { properties: { confirm: { type: "boolean" } }, type: "object" },
  },
};
const SIGN_IN_URL: McpInputRequest = {
  method: "elicitation/create",
  params: { mode: "url", url: "https://idp.example.com/a" },
};
const INPUT_REQUESTS = { approve: APPROVAL_FORM };
const CAPTURED = { inputRequests: INPUT_REQUESTS, requestState: "s1", status: "input_required" };

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

function sseFetch(chunks: readonly string[]): typeof fetch {
  const encoder = new TextEncoder();
  return createMcpInputRequiredFetch(
    vi.fn(
      async (..._args: FetchArgs) =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
              controller.close();
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
    ),
  );
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
  const response = await fetcher(ENDPOINT, { body, method: "POST" });
  const text = await response.text();
  if (text.includes("input_required")) throw new Error("SDK: unknown result");
  return text;
}

function bodyOf(fetcher: ReturnType<typeof vi.fn>, call = 0): Record<string, unknown> {
  const init = fetcher.mock.calls[call]?.[1] as RequestInit | undefined;
  return JSON.parse(String(init?.body)) as Record<string, unknown>;
}

const json = JSON.stringify(inputRequiredMessage());
const event = `data: ${json}`;
const comma = json.indexOf(",") + 1;

describe("createMcpInputRequiredFetch + runMcpRequestScope", () => {
  it("captures a JSON input_required result and returns it instead of the SDK error", async () => {
    const fetcher = createMcpInputRequiredFetch(
      vi.fn(async (..._args: FetchArgs) => jsonResponse(inputRequiredMessage())),
    );

    const outcome = await runMcpRequestScope({ execute: () => sdkCall(fetcher, toolsCallBody()) });

    expect(outcome).toEqual(CAPTURED);
  });

  // Capture must agree with the SDK's SSE parser: only a complete, unnamed or
  // `message` event answering this request id decides the call.
  it.each<{ name: string; chunks: string[]; captured: boolean }>([
    { name: "an unnamed event", chunks: [`${event}\n\n`], captured: true },
    { name: "a `message` event", chunks: [`event: message\n${event}\n\n`], captured: true },
    { name: "an event of another type", chunks: [`event: other\n${event}\n\n`], captured: false },
    {
      name: "a result for another request id",
      chunks: [`data: ${JSON.stringify(inputRequiredMessage(99))}\n\n`],
      captured: false,
    },
    ...(
      [
        ["LF", "\n"],
        ["CR", "\r"],
        ["CRLF", "\r\n"],
      ] as const
    ).flatMap(([label, eol]) => [
      {
        name: `a ${label}-terminated event at end of stream`,
        chunks: [event + eol + eol],
        captured: true,
      },
      {
        name: `an unterminated ${label} event at end of stream`,
        chunks: [event + eol],
        captured: false,
      },
    ]),
    {
      name: "an event split mid-line across chunks",
      chunks: [`${event}\n\n`.slice(0, 40), `${event}\n\n`.slice(40)],
      captured: true,
    },
    {
      // A scanner that ends the line on the CR alone reads the LF as a blank
      // line and flushes half an event.
      name: "a multiline event whose CRLF is split across chunks",
      chunks: [`data: ${json.slice(0, comma)}\r`, `\ndata: ${json.slice(comma)}\r\n\r\n`],
      captured: true,
    },
    {
      // The first chunk's trailing CR is held back (it may start a CRLF); the
      // final CR then ends the event as a blank line.
      name: "a lone CR that is the stream's last byte",
      chunks: [`${event}\r`, "\r"],
      captured: true,
    },
  ])("SSE: $name (captured: $captured)", async ({ chunks, captured }) => {
    const fetcher = sseFetch(chunks);
    const sdkError = new Error("SDK: unknown result or stream ended");
    let seen = "";

    const outcome = runMcpRequestScope({
      execute: async () => {
        seen = await (await fetcher(ENDPOINT, { body: toolsCallBody(), method: "POST" })).text();
        throw sdkError;
      },
    });

    if (captured) await expect(outcome).resolves.toEqual(CAPTURED);
    else await expect(outcome).rejects.toBe(sdkError);
    // The SDK reads the exact bytes the server sent.
    expect(seen).toBe(chunks.join(""));
  });

  it.each([
    ["throws", true],
    ["swallows the SDK error, as a trace span does,", false],
  ])(
    "rethrows a cancellation that lands after input_required was captured when execute %s",
    async (_label, rethrows) => {
      const fetcher = sseFetch([`${event}\n\n`]);
      const controller = new AbortController();
      const aborted = new Error("Request was aborted");

      const outcome = runMcpRequestScope({
        abortSignal: controller.signal,
        execute: async () => {
          await (await fetcher(ENDPOINT, { body: toolsCallBody(), method: "POST" })).text();
          controller.abort(aborted);
          if (rethrows) throw aborted;
          return "placeholder";
        },
      });

      await expect(outcome).rejects.toBe(aborted);
    },
  );

  it("returns a normal completed result", async () => {
    const completed = { id: 1, jsonrpc: "2.0", result: { content: [], isError: false } };
    const fetcher = createMcpInputRequiredFetch(
      vi.fn(async (..._args: FetchArgs) => jsonResponse(completed)),
    );

    const outcome = await runMcpRequestScope({
      execute: async () =>
        (await (
          await fetcher(ENDPOINT, { body: toolsCallBody(), method: "POST" })
        ).json()) as unknown,
    });

    expect(outcome).toEqual({ status: "completed", value: completed });
  });

  it("throws on a malformed input_required result", async () => {
    const fetcher = createMcpInputRequiredFetch(
      vi.fn(async (..._args: FetchArgs) =>
        jsonResponse({ id: 1, jsonrpc: "2.0", result: { resultType: "input_required" } }),
      ),
    );

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
      execute: () => fetcher(ENDPOINT, init),
      retry: { inputResponses: { a: {} }, requestState: "s1" },
    });

    expect(base.mock.calls[0]?.[1]).toBe(init);
  });

  it("passes requests outside a scope through untouched", async () => {
    const base = vi.fn(async (..._args: FetchArgs) => jsonResponse(inputRequiredMessage()));
    const fetcher = createMcpInputRequiredFetch(base);
    const init = { body: toolsCallBody(), method: "POST" } satisfies RequestInit;

    await fetcher(ENDPOINT, init);

    expect(base.mock.calls[0]?.[1]).toBe(init);
  });

  it("strips elicitation capabilities from initialize", async () => {
    const base = vi.fn(async (..._args: FetchArgs) => jsonResponse({}));
    const fetcher = createMcpInputRequiredFetch(base);

    await fetcher(ENDPOINT, {
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
  it.each<[string, Record<string, unknown>, string]>([
    ["neither field", { resultType: "input_required" }, "without inputRequests or requestState"],
    ["a non-string requestState", { requestState: 1 }, "non-string requestState"],
    ["inputRequests that is an array", { inputRequests: [] }, "malformed inputRequests"],
    ["a request without a method", { inputRequests: { a: { params: {} } } }, 'request "a"'],
    [
      "non-object params",
      { inputRequests: { a: { method: "x", params: 1 } } },
      'malformed params for "a"',
    ],
  ])("rejects %s", (_label, result, message) => {
    expect(parseInputRequiredResult(result)).toEqual(expect.stringContaining(message));
  });

  it("accepts requestState alone", () => {
    expect(parseInputRequiredResult({ requestState: "s" })).toEqual({ requestState: "s" });
  });

  // Request ids are server-chosen keys; `__proto__` must stay an ordinary
  // entry through parsing, planning, and the `inputResponses` sent back.
  it.each([
    ["an approval form", APPROVAL_FORM, { action: "accept", content: { confirm: true } }],
    ["a sign-in URL", SIGN_IN_URL, { action: "accept" }],
  ])(
    "keeps a request id named __proto__ as an ordinary entry for %s",
    (_label, request, answer) => {
      const parsed = parseInputRequiredResult(
        JSON.parse(
          `{"inputRequests":{"__proto__":${JSON.stringify(request)}},"requestState":"s"}`,
        ) as Record<string, unknown>,
      );
      if (typeof parsed === "string") throw new Error(parsed);
      expect(Object.keys(parsed.inputRequests!)).toEqual(["__proto__"]);
      expect(Object.getPrototypeOf(parsed.inputRequests)).toBeNull();

      const plan = planMcpInput(parsed);
      if (!("approve" in plan)) throw new Error(`unexpected plan ${plan.kind}`);
      expect(Object.keys(plan.approve)).toEqual(["__proto__"]);
      expect(JSON.stringify(plan.approve)).toBe(`{"__proto__":${JSON.stringify(answer)}}`);
    },
  );
});

describe("planMcpInput", () => {
  const unsupported = (reason: string) => ({ kind: "unsupported", reason });

  it.each<[string, Record<string, McpInputRequest> | undefined, unknown]>([
    ["a retry when there are no inputRequests", undefined, { kind: "retry" }],
    [
      "an approval for a single boolean form elicitation",
      INPUT_REQUESTS,
      {
        approve: { approve: { action: "accept", content: { confirm: true } } },
        kind: "approval",
        prompt: "Delete the repo?",
      },
    ],
    [
      "a sign-in for an https URL elicitation",
      { login: { ...SIGN_IN_URL, params: { ...SIGN_IN_URL.params, message: "Sign in" } } },
      {
        approve: { login: { action: "accept" } },
        kind: "sign-in",
        links: [{ message: "Sign in", url: "https://idp.example.com/a" }],
      },
    ],
    [
      "one sign-in for several URL elicitations, as mcpChannel sends per connection",
      {
        "auth/github": {
          method: "elicitation/create",
          params: { mode: "url", url: "https://github.example/authorize" },
        },
        "auth/linear": {
          method: "elicitation/create",
          params: { message: "Sign in to Linear", mode: "url", url: "https://linear.example/a" },
        },
      },
      {
        approve: { "auth/github": { action: "accept" }, "auth/linear": { action: "accept" } },
        kind: "sign-in",
        links: [
          { url: "https://github.example/authorize" },
          { message: "Sign in to Linear", url: "https://linear.example/a" },
        ],
      },
    ],
    [
      "nothing for a mix of a URL and a form elicitation",
      {
        a: SIGN_IN_URL,
        b: { method: "elicitation/create", params: { mode: "form", requestedSchema: {} } },
      },
      unsupported("it asked for 2 inputs at once"),
    ],
    [
      "nothing for a javascript: URL elicitation",
      {
        login: {
          method: "elicitation/create",
          params: { mode: "url", url: "javascript:alert(1)" },
        },
      },
      unsupported("it sent a URL elicitation without an http(s) URL"),
    ],
    [
      "nothing for sampling/createMessage",
      { s: { method: "sampling/createMessage", params: {} } },
      unsupported("it sent a sampling/createMessage request"),
    ],
    [
      "nothing for a non-boolean form",
      {
        f: {
          method: "elicitation/create",
          params: {
            message: "Name?",
            requestedSchema: { properties: { name: { type: "string" } }, type: "object" },
          },
        },
      },
      unsupported("it sent a form eve cannot render as an approval"),
    ],
  ])("plans %s", (_label, inputRequests, expected) => {
    expect(
      planMcpInput(inputRequests === undefined ? { requestState: "s" } : { inputRequests }),
    ).toEqual(expected);
  });
});
