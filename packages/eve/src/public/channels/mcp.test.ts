import { describe, expect, it, vi } from "vitest";

import type { SessionAuthContext } from "#channel/types.js";
import type { RouteHandlerArgs } from "#channel/routes.js";
import type { AgentDescription } from "#channel/agent-description.js";
import type { InvokeToolFn } from "#channel/invoke-tool.js";
import { SkillReadError } from "#channel/skill-files.js";
import {
  attachAgentInfoRouteResponse,
  attachRouteChannelName,
  attachRouteSessionCreator,
} from "#internal/nitro/routes/channel-route-context.js";
import { MCP_PROTOCOL_VERSION } from "#internal/mcp/streamable-http-server.js";
import { ForbiddenError, none, oauthResource, withAuthChallenges } from "#public/channels/auth.js";
import { mcpChannel } from "#public/channels/mcp.js";
import { mockAgentDescriptionRouteArgs } from "#internal/testing/mocks/mock-route-args.js";
import { unusedInvokeTool } from "#internal/testing/unused-invoke-tool.js";

const MCP_LEGACY_PROTOCOL_VERSION = "2025-11-25";

const principal: SessionAuthContext = {
  attributes: {},
  authenticator: "test",
  principalId: "user-1",
  principalType: "user",
};

describe("mcpChannel", () => {
  it("fails closed when auth is omitted", () => {
    expect(() => mcpChannel({} as never)).toThrow(
      "mcpChannel requires auth. Use none() for explicit public access.",
    );
  });

  it("publishes task-mode durable invocation compatibility tools", async () => {
    const channel = mcpChannel({ auth: none() });
    expect(channel.routes.map((route) => `${route.method} ${route.path}`)).toEqual([
      "GET /eve/v1/mcp",
      "POST /eve/v1/mcp",
      "DELETE /eve/v1/mcp",
    ]);
    const postRoute = channel.routes[1]!;
    if (postRoute.transport === "websocket") throw new Error("expected HTTP route");

    const initialize = await postRoute.handler(
      mcpRequest({
        id: 1,
        jsonrpc: "2.0",
        method: "initialize",
        params: {
          capabilities: {},
          clientInfo: { name: "test-client", version: "0.0.0" },
          protocolVersion: MCP_LEGACY_PROTOCOL_VERSION,
        },
      }),
      routeArgs(),
    );
    await expect(jsonRpcResponse(initialize)).resolves.toMatchObject({
      result: {
        instructions: expect.stringContaining("pollAfterMs"),
        serverInfo: { name: "compiled-agent" },
      },
    });

    const discovered = await postRoute.handler(
      mcpRequest(
        {
          id: "discover",
          jsonrpc: "2.0",
          method: "server/discover",
          params: {
            _meta: {
              "io.modelcontextprotocol/clientCapabilities": {},
              "io.modelcontextprotocol/clientInfo": { name: "test-client", version: "0.0.0" },
              "io.modelcontextprotocol/protocolVersion": MCP_PROTOCOL_VERSION,
            },
          },
        },
        { "mcp-method": "server/discover", "mcp-protocol-version": MCP_PROTOCOL_VERSION },
      ),
      routeArgs(),
    );
    const discovery = (await jsonRpcResponse(discovered)) as {
      result: { instructions: string };
    };
    expect(discovery.result.instructions).toContain("agent_start is not idempotent");
    expect(discovery.result.instructions).toContain("ask the user before starting again");
    expect(discovery.result.instructions).toContain("agent_cancel");
    expect(discovery.result.instructions.length).toBeLessThan(800);

    const tools = await postRoute.handler(
      mcpRequest({ id: 2, jsonrpc: "2.0", method: "tools/list" }),
      routeArgs(),
    );
    const body = (await jsonRpcResponse(tools)) as {
      result: {
        tools: Array<{
          description?: string;
          inputSchema: Record<string, unknown>;
          name: string;
          outputSchema?: Record<string, unknown>;
        }>;
      };
    };
    expect(body.result.tools.map((tool) => tool.name)).toEqual([
      "agent_start",
      "agent_get",
      "agent_update",
      "agent_cancel",
    ]);
    expect(body.result.tools[0]).toMatchObject({
      annotations: {
        destructiveHint: true,
        openWorldHint: true,
      },
      description: expect.stringContaining("Investigates tasks."),
      outputSchema: { type: "object" },
    });
    expect(body.result.tools[0]?.description).toContain("Not idempotent");
    expect(body.result.tools[1]).toMatchObject({
      annotations: {
        idempotentHint: true,
        openWorldHint: false,
        readOnlyHint: true,
      },
      description: expect.stringContaining("pollAfterMs"),
    });
    expect(body.result.tools[2]?.description).toContain("partial batches are rejected");
    expect(body.result.tools[3]?.description).toContain("until status is terminal");
    expect(body.result.tools[3]?.description).not.toContain("until status is cancelled");
    expect(body.result.tools[2]).toMatchObject({
      annotations: {
        idempotentHint: false,
      },
      inputSchema: {
        properties: {
          responses: {
            items: {
              properties: {
                optionId: { type: "string" },
                requestId: { type: "string" },
                text: { type: "string" },
              },
              required: ["requestId"],
            },
          },
        },
      },
      outputSchema: {
        oneOf: expect.arrayContaining([
          expect.objectContaining({
            properties: expect.objectContaining({
              inputRequests: expect.any(Object),
              status: { const: "input_required", type: "string" },
            }),
            required: expect.arrayContaining(["inputRequests"]),
          }),
          expect.objectContaining({
            properties: expect.objectContaining({
              authorizations: expect.objectContaining({ minItems: 1 }),
              status: { const: "authorization_required", type: "string" },
            }),
            required: expect.arrayContaining(["authorizations"]),
          }),
          expect.objectContaining({
            properties: expect.objectContaining({
              error: expect.any(Object),
              status: { const: "failed", type: "string" },
            }),
            required: expect.arrayContaining(["error"]),
          }),
        ]),
      },
    });
  });

  it("uses existing eve auth strategies directly", async () => {
    const channel = mcpChannel({ auth: () => principal });
    const route = channel.routes[1]!;
    if (route.transport === "websocket") throw new Error("expected HTTP route");

    const response = await route.handler(
      mcpRequest({
        id: 1,
        jsonrpc: "2.0",
        method: "initialize",
        params: {
          capabilities: {},
          clientInfo: { name: "test-client", version: "0.0.0" },
          protocolVersion: MCP_LEGACY_PROTOCOL_VERSION,
        },
      }),
      routeArgs(),
    );
    expect(response.status).toBe(200);
  });

  it("rejects cross-origin requests before running auth", async () => {
    const authenticate = vi.fn(() => principal);
    const channel = mcpChannel({ auth: authenticate });
    const route = channel.routes[1]!;
    if (route.transport === "websocket") throw new Error("expected HTTP route");

    const response = await route.handler(
      mcpRequest(
        {
          id: 1,
          jsonrpc: "2.0",
          method: "tools/list",
        },
        { origin: "https://attacker.example" },
      ),
      routeArgs(),
    );

    expect(response.status).toBe(403);
    expect(authenticate).not.toHaveBeenCalled();
  });

  it("rejects oversized UTF-8 messages and input responses before starting work", async () => {
    const createSession = vi.fn();
    const channel = mcpChannel({ auth: none() });
    const route = channel.routes[1]!;
    if (route.transport === "websocket") throw new Error("expected HTTP route");

    const oversizedStart = await route.handler(
      mcpRequest({
        id: 1,
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          // 3 bytes per char: well under 64 Ki characters, over 64 KiB.
          arguments: { message: "日".repeat(24 * 1_024) },
          name: "agent_start",
        },
      }),
      routeArgs(createSession),
    );
    await expect(jsonRpcResponse(oversizedStart)).resolves.toMatchObject({
      result: {
        content: [{ text: expect.stringContaining("Input validation error"), type: "text" }],
        isError: true,
      },
    });

    const oversizedUpdate = await route.handler(
      mcpRequest({
        id: 2,
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          arguments: {
            invocationId: "inv",
            responses: [{ requestId: "r", text: "日".repeat(6 * 1_024) }],
          },
          name: "agent_update",
        },
      }),
      routeArgs(createSession),
    );
    await expect(jsonRpcResponse(oversizedUpdate)).resolves.toMatchObject({
      result: { isError: true },
    });
    expect(createSession).not.toHaveBeenCalled();
  });

  it("mounts OAuth resource metadata and augments auth failures", async () => {
    const channel = mcpChannel({
      auth: oauthResource(
        withAuthChallenges(
          () => null,
          [{ parameters: { realm: "eve" }, scheme: "Basic" }, { scheme: "Bearer" }],
        ),
        {
          issuer: "https://issuer.example",
          resource: "https://agent.example/delegate",
          scopes: ["agent:invoke"],
        },
      ),
      route: "/delegate",
    });
    expect(channel.routes.map((route) => `${route.method} ${route.path}`)).toEqual([
      "GET /.well-known/oauth-protected-resource/delegate",
      "HEAD /.well-known/oauth-protected-resource/delegate",
      "OPTIONS /.well-known/oauth-protected-resource/delegate",
      "GET /delegate",
      "POST /delegate",
      "DELETE /delegate",
    ]);

    const metadataRoute = channel.routes[0]!;
    if (metadataRoute.transport === "websocket") throw new Error("expected HTTP route");
    const metadata = await metadataRoute.handler(
      requestWithHost("https://private.example/.well-known/oauth-protected-resource/delegate"),
      {} as never,
    );
    await expect(metadata.json()).resolves.toEqual({
      authorization_servers: ["https://issuer.example"],
      resource: "https://agent.example/delegate",
      scopes_supported: ["agent:invoke"],
    });
    expect(metadata.headers.get("access-control-allow-origin")).toBe("*");

    const route = channel.routes[4]!;
    if (route.transport === "websocket") throw new Error("expected HTTP route");
    const response = await route.handler(
      requestWithHost("https://private.example/delegate", { method: "POST" }),
      {} as never,
    );
    expect(response.status).toBe(401);
    const challenge = response.headers.get("www-authenticate");
    expect(challenge).toContain(
      'resource_metadata="https://agent.example/.well-known/oauth-protected-resource/delegate"',
    );
    expect(challenge).toContain('Basic realm="eve"');
    expect(challenge).toContain('scope="agent:invoke"');
    expect(challenge?.match(/\bBearer\b/g)).toHaveLength(1);
  });

  it("adds resource metadata only to explicit insufficient-scope responses", async () => {
    const genericChannel = mcpChannel({
      auth: oauthResource(
        () => {
          throw new ForbiddenError();
        },
        { issuer: "https://issuer.example", scopes: ["agent:invoke"] },
      ),
    });
    const genericRoute = genericChannel.routes[4]!;
    if (genericRoute.transport === "websocket") throw new Error("expected HTTP route");
    const generic = await genericRoute.handler(
      requestWithHost("https://agent.example/eve/v1/mcp", { method: "POST" }),
      {} as never,
    );
    expect(generic.status).toBe(403);
    expect(generic.headers.get("www-authenticate")).toBeNull();

    const scopedChannel = mcpChannel({
      auth: oauthResource(
        () => {
          throw new ForbiddenError({
            challenges: [
              {
                parameters: { error: "insufficient_scope", scope: "agent:admin" },
                scheme: "Bearer",
              },
            ],
          });
        },
        { issuer: "https://issuer.example", scopes: ["agent:invoke"] },
      ),
    });
    const scopedRoute = scopedChannel.routes[4]!;
    if (scopedRoute.transport === "websocket") throw new Error("expected HTTP route");
    const scoped = await scopedRoute.handler(
      requestWithHost("https://agent.example/eve/v1/mcp", { method: "POST" }),
      {} as never,
    );
    const scopedChallenge = scoped.headers.get("www-authenticate");
    expect(scoped.status).toBe(403);
    expect(scopedChallenge).toContain('error="insufficient_scope"');
    expect(scopedChallenge).toContain('scope="agent:admin"');
    expect(scopedChallenge).not.toContain('scope="agent:invoke"');
    expect(scopedChallenge).toContain(
      'resource_metadata="https://agent.example/.well-known/oauth-protected-resource/eve/v1/mcp"',
    );
    expect(scopedChallenge?.match(/\bBearer\b/g)).toHaveLength(1);
  });

  it("preserves invalid_token in the OAuth resource challenge", async () => {
    const channel = mcpChannel({
      auth: oauthResource(
        withAuthChallenges(() => null, [{ scheme: "Bearer" }]),
        {
          issuer: "https://issuer.example",
          scopes: ["agent:invoke"],
        },
      ),
    });
    const route = channel.routes[4]!;
    if (route.transport === "websocket") throw new Error("expected HTTP route");
    const response = await route.handler(
      requestWithHost("https://agent.example/eve/v1/mcp", {
        headers: { authorization: "Bearer expired-token" },
        method: "POST",
      }),
      {} as never,
    );

    expect(response.status).toBe(401);
    const challenge = response.headers.get("www-authenticate");
    expect(challenge).toContain('error="invalid_token"');
    expect(challenge).toContain('scope="agent:invoke"');
    expect(challenge).toContain(
      'resource_metadata="https://agent.example/.well-known/oauth-protected-resource/eve/v1/mcp"',
    );
    expect(challenge?.match(/\bBearer\b/g)).toHaveLength(1);
  });

  it("derives the protected resource from the public request origin", async () => {
    const channel = mcpChannel({
      auth: oauthResource(() => null, { issuer: "https://issuer.example" }),
      route: "/delegate",
    });
    const route = channel.routes[0]!;
    if (route.transport === "websocket") throw new Error("expected HTTP route");
    const response = await route.handler(
      requestWithHost("https://agent.example/.well-known/oauth-protected-resource/delegate"),
      {} as never,
    );
    await expect(response.json()).resolves.toEqual({
      authorization_servers: ["https://issuer.example"],
      resource: "https://agent.example/delegate",
    });
  });

  it("allows overriding the protected-resource metadata path", () => {
    const channel = mcpChannel({
      auth: oauthResource(() => null, {
        issuer: "https://issuer.example",
        metadataPath: "/.well-known/custom-resource",
      }),
    });
    expect(channel.routes.slice(0, 3).map((route) => `${route.method} ${route.path}`)).toEqual([
      "GET /.well-known/custom-resource",
      "HEAD /.well-known/custom-resource",
      "OPTIONS /.well-known/custom-resource",
    ]);
  });

  it("serves protected-resource metadata to cross-origin browser clients", async () => {
    const channel = mcpChannel({
      auth: oauthResource(() => null, { issuer: "https://issuer.example" }),
    });
    const [getRoute, headRoute, optionsRoute] = channel.routes;
    if (
      getRoute?.transport === "websocket" ||
      headRoute?.transport === "websocket" ||
      optionsRoute?.transport === "websocket" ||
      getRoute === undefined ||
      headRoute === undefined ||
      optionsRoute === undefined
    ) {
      throw new Error("expected HTTP metadata routes");
    }

    const origin = "https://client.example";
    const get = await getRoute.handler(
      requestWithHost("https://agent.example/.well-known/oauth-protected-resource/eve/v1/mcp", {
        headers: { origin },
      }),
      {} as never,
    );
    expect(get.status).toBe(200);
    expect(get.headers.get("access-control-allow-origin")).toBe("*");

    const head = await headRoute.handler(
      requestWithHost("https://agent.example/.well-known/oauth-protected-resource/eve/v1/mcp", {
        headers: { origin },
        method: "HEAD",
      }),
      {} as never,
    );
    expect(head.status).toBe(200);
    expect(head.headers.get("access-control-allow-origin")).toBe("*");
    expect(head.headers.get("content-type")).toContain("application/json");
    expect(await head.text()).toBe("");

    const options = await optionsRoute.handler(
      requestWithHost("https://agent.example/.well-known/oauth-protected-resource/eve/v1/mcp", {
        headers: {
          "access-control-request-headers": "authorization, mcp-protocol-version",
          "access-control-request-method": "GET",
          origin,
        },
        method: "OPTIONS",
      }),
      {} as never,
    );
    expect(options.status).toBe(204);
    expect(options.headers.get("access-control-allow-origin")).toBe("*");
    expect(options.headers.get("access-control-allow-methods")).toBe("GET, HEAD, OPTIONS");
    expect(options.headers.get("access-control-allow-headers")).toBe(
      "authorization, mcp-protocol-version",
    );
    expect(options.headers.get("vary")).toBe("Access-Control-Request-Headers");
  });
});

interface RouteArgsOverrides {
  readonly createSession?: () => Promise<never>;
  readonly description?: AgentDescription;
  readonly invokeTool?: InvokeToolFn;
  readonly readSkill?: RouteHandlerArgs["readSkill"];
}

function routeArgs(overrides: RouteArgsOverrides | (() => Promise<never>) = {}): RouteHandlerArgs {
  const options = typeof overrides === "function" ? { createSession: overrides } : overrides;
  const unavailable = () => {
    throw new Error("Route operation is unavailable in this test.");
  };
  const description = options.description ?? {
    description: "Investigates tasks.",
    name: "compiled-agent",
    skills: [],
    tools: [],
  };
  const descriptionArgs = mockAgentDescriptionRouteArgs();
  const args: RouteHandlerArgs = {
    ...descriptionArgs,
    attachSession: unavailable,
    describe: async () => description,
    from: unavailable,
    params: {},
    requestIp: "127.0.0.1",
    invokeTool: options.invokeTool ?? unusedInvokeTool,
    readSkill: options.readSkill ?? descriptionArgs.readSkill,
    resolveSession: vi.fn(),
    to: unavailable,
    waitUntil: vi.fn(),
  };
  return attachRouteChannelName(
    attachAgentInfoRouteResponse(
      attachRouteSessionCreator(args, options.createSession ?? vi.fn()),
      async () =>
        Response.json({
          agent: {
            description: "Investigates tasks.",
            name: "compiled-agent",
          },
        }),
    ),
    "mcp",
  );
}

function mcpRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("https://agent.example/mcp", {
    body: JSON.stringify(body),
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      host: "agent.example",
      ...headers,
    },
    method: "POST",
  });
}

function requestWithHost(url: string, init: RequestInit = {}): Request {
  const target = new URL(url);
  return new Request(url, {
    ...init,
    headers: { host: target.host, ...Object.fromEntries(new Headers(init.headers)) },
  });
}

async function jsonRpcResponse(response: Response): Promise<unknown> {
  if (!response.headers.get("content-type")?.includes("text/event-stream")) {
    return await response.json();
  }
  const data = (await response.text()).split("\n").find((line) => line.startsWith("data: "));
  if (data === undefined) throw new Error("MCP SSE response did not contain a data event.");
  return JSON.parse(data.slice("data: ".length));
}

const APPROVED = { "dev.eve/approval": { action: "accept", content: { approved: true } } };
const DEPLOYED = [{ text: "deployed", type: "text" }];
const INVALID_STATE = { code: -32_602, data: { reason: "invalid_request_state" } };
const AGENT_TOOLS = ["agent_start", "agent_get", "agent_update", "agent_cancel"];
const SKILL_URI = "skill://usage-triage/SKILL.md";
const SKILL_MD = "---\nname: usage-triage\ndescription: Triage.\n---\nBody\n";

const tool = (name: string, approval = false, invocable = true) => ({
  approval,
  description: name,
  inputSchema: { type: "object" },
  invocable,
  name,
});
const toolsDescription: AgentDescription = {
  name: "compiled-agent",
  skills: [{ description: "Triage.", files: ["SKILL.md", "notes.md"], name: "usage-triage" }],
  tools: [tool("deploy", true), tool("harness_only", false, false), tool("issues"), tool("plain")],
};

async function readSkill(skill: string, path = "SKILL.md"): Promise<string> {
  const files: Record<string, string> = { "SKILL.md": SKILL_MD, "notes.md": "notes\n" };
  if (skill === "usage-triage" && path in files) return files[path]!;
  throw new SkillReadError("unknown-file", path);
}

type ModernCall = { capabilities?: object; headers?: Record<string, string>; meta?: object };

function modernRequest(method: string, params: Record<string, unknown>, call: ModernCall = {}) {
  const headers = { "mcp-method": method, "mcp-protocol-version": MCP_PROTOCOL_VERSION };
  const name = params.name ?? params.uri;
  const _meta = {
    ...call.meta,
    "io.modelcontextprotocol/clientCapabilities": call.capabilities ?? {
      elicitation: { form: {}, url: {} },
      extensions: { "dev.eve/tool-sessions": {} },
    },
    "io.modelcontextprotocol/clientInfo": { name: "test-client", version: "0.0.0" },
    "io.modelcontextprotocol/protocolVersion": MCP_PROTOCOL_VERSION,
  };
  return mcpRequest(
    { id: 1, jsonrpc: "2.0", method, params: { ...params, _meta } },
    { ...headers, ...(typeof name === "string" && { "mcp-name": name }), ...call.headers },
  );
}

const callTool = (params: Record<string, unknown>, call: ModernCall = {}) =>
  modernRequest("tools/call", { arguments: {}, ...params }, call);

const post = (channel: ReturnType<typeof mcpChannel>, request: Request, args: RouteHandlerArgs) => {
  const route = channel.routes.find((entry) => entry.method === "POST")!;
  if (route.transport === "websocket") throw new Error("expected HTTP route");
  return route.handler(request, args);
};

async function rpc(...input: Parameters<typeof post>): Promise<Record<string, any>> {
  return (await jsonRpcResponse(await post(...input))) as Record<string, any>;
}

const signInResult = (callId: string, ...names: string[]) => ({
  callId,
  challenges: names.map((name) => ({ challenge: { url: `https://idp/${name}` }, name })),
  status: "authorization-required" as const,
});

/** A core stand-in: `deploy` needs approval (then a sign-in until `signedIn`), `issues` a sign-in. */
function fakeCore(state: { signedIn?: boolean } = {}) {
  return vi.fn<InvokeToolFn>(async (name, input, options) => {
    const nonce = options.key === undefined && { oneOffNonce: "nonce-1" };
    const pause = { callId: options.callId ?? "call_new", ...nonce };
    if (name === "plain") {
      return { modelOutput: { type: "json", value: input }, output: input, status: "completed" };
    }
    if (name === "deploy") {
      if (options.approval === undefined) return { ...pause, status: "approval-required" };
      if (!options.approval.approved) return { reason: "Declined.", status: "denied" };
    }
    if ((name === "deploy" && state.signedIn === false) || (name === "issues" && !state.signedIn)) {
      return { ...signInResult(pause.callId, "linear"), ...nonce };
    }
    return { modelOutput: { type: "text", value: "deployed" }, output: "ok", status: "completed" };
  });
}

function toolsChannel(input: Partial<Parameters<typeof mcpChannel>[0]> = {}) {
  return mcpChannel({
    auth: (request) => ({
      attributes: {},
      authenticator: "test",
      principalId: request.headers.get("x-test-principal") ?? "user-1",
      principalType: "user",
    }),
    requestStateSecret: "x".repeat(32),
    tools: true,
    ...input,
  });
}

function setup(core = fakeCore()) {
  return { args: routeArgs({ description: toolsDescription, invokeTool: core, readSkill }), core };
}

describe("mcpChannel tools", () => {
  it("starts agent_* work as the route caller, not the forwarded principal", async () => {
    const createSession = vi.fn(async (_input: unknown) => {
      throw new Error("stop after createSession");
    });
    const header = Buffer.from(
      JSON.stringify({
        current: {
          attributes: {},
          authenticator: "oidc",
          principalId: "end-user",
          principalType: "user",
        },
      }),
    ).toString("base64url");
    await rpc(
      toolsChannel({ trustedForwarders: () => true }),
      modernRequest(
        "tools/call",
        { arguments: { message: "hello" }, name: "agent_start" },
        { headers: { "eve-forwarded-principal": header, "x-test-principal": "router" } },
      ),
      routeArgs({ createSession: createSession as never, description: toolsDescription }),
    );
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(createSession.mock.calls[0]![0]).toMatchObject({ auth: { principalId: "router" } });
  });

  it("without a secret in production, fails paused calls naming the env var and runs plain ones", async () => {
    const previous = { env: process.env.EVE_MCP_REQUEST_STATE_SECRET, dev: process.env.EVE_DEV };
    delete process.env.EVE_MCP_REQUEST_STATE_SECRET;
    delete process.env.EVE_DEV;
    try {
      const channel = toolsChannel({ requestStateSecret: undefined });
      const args = routeArgs({ description: toolsDescription, invokeTool: fakeCore() });
      const paused = await rpc(
        channel,
        modernRequest("tools/call", { arguments: {}, name: "deploy" }),
        args,
      );
      expect(paused.result).toMatchObject({
        isError: true,
        structuredContent: { error: { code: "internal" } },
      });
      expect(paused.result?.structuredContent.error.message).toContain(
        "EVE_MCP_REQUEST_STATE_SECRET",
      );
      expect(paused.result?.requestState).toBeUndefined();

      const plain = await rpc(
        channel,
        modernRequest("tools/call", { arguments: { x: 2 }, name: "plain" }),
        args,
      );
      expect(plain.result?.structuredContent).toEqual({ x: 2 });

      const echoed = await rpc(
        channel,
        modernRequest("tools/call", { arguments: {}, name: "deploy", requestState: "anything" }),
        args,
      );
      expect(echoed.error?.code).toBe(-32_602);
    } finally {
      if (previous.env !== undefined) process.env.EVE_MCP_REQUEST_STATE_SECRET = previous.env;
      if (previous.dev !== undefined) process.env.EVE_DEV = previous.dev;
    }
  });

  it("publishes tools only with tools: true and skills only with skills: true", async () => {
    const all = [...AGENT_TOOLS, "deploy", "issues", "plain"];
    const rows = [
      [{ tools: false }, AGENT_TOOLS, false],
      [{}, all, false],
      [{ skills: true }, all, true],
    ] as const;
    for (const [options, names, skills] of rows) {
      const label = JSON.stringify(options);
      const { args, core } = setup();
      const channel = toolsChannel(options);
      const { capabilities } = (await rpc(channel, modernRequest("server/discover", {}), args))
        .result;
      const listed = await rpc(channel, modernRequest("tools/list", {}), args);
      expect(
        listed.result.tools.map((t: { name: string }) => t.name),
        label,
      ).toEqual(names);
      const { "dev.eve/tool-sessions": sessions, "io.modelcontextprotocol/skills": skillsExt } =
        capabilities.extensions ?? {};
      expect([sessions, skillsExt !== undefined], label).toEqual([
        names === all ? {} : undefined,
        skills,
      ]);
      const read = await rpc(channel, modernRequest("resources/read", { uri: SKILL_URI }), args);
      if (skills) expect(read.result.contents[0], label).toMatchObject({ text: SKILL_MD });
      else expect(read.error.code, label).toBe(-32_601);
      // Never runs an unpublished or turn-only tool.
      for (const name of ["harness_only", ...(names === all ? [] : ["plain"])]) {
        const called = await rpc(channel, callTool({ name }), args);
        expect(called.error?.code ?? called.result?.isError, `${label} ${name}`).toBeTruthy();
      }
      expect(core, label).not.toHaveBeenCalled();
    }
  });

  it("agent: false serves only what tools and skills publish and frees the agent_* names", async () => {
    const core = fakeCore();
    const description: AgentDescription = {
      ...toolsDescription,
      tools: [
        {
          approval: false,
          description: "An authored tool named like the channel's.",
          inputSchema: { type: "object" },
          invocable: true,
          name: "agent_start",
        },
        ...toolsDescription.tools,
      ],
    };
    const args = routeArgs({ description, invokeTool: core, readSkill });

    const toolsOnly = toolsChannel({ agent: false });
    const discovered = (await rpc(toolsOnly, modernRequest("server/discover", {}), args)).result;
    expect(discovered.instructions).toBeUndefined();
    const listed = await rpc(toolsOnly, modernRequest("tools/list", {}), args);
    expect(listed.result.tools.map((t: { name: string }) => t.name)).toEqual([
      "agent_start",
      "deploy",
      "issues",
      "plain",
    ]);
    await rpc(toolsOnly, callTool({ arguments: {}, name: "agent_start" }), args);
    expect(core.mock.calls.map(([name]) => name)).toEqual(["agent_start"]);

    const skillsOnly = toolsChannel({ agent: false, skills: true, tools: false });
    const skillsDiscover = (await rpc(skillsOnly, modernRequest("server/discover", {}), args))
      .result;
    expect(skillsDiscover.capabilities.tools).toBeUndefined();
    expect((await rpc(skillsOnly, modernRequest("tools/list", {}), args)).error?.code).toBe(
      -32_601,
    );

    expect(() => toolsChannel({ agent: false, skills: false, tools: false })).toThrow(
      "mcpChannel publishes nothing with agent, tools, and skills all false. Enable at least one.",
    );
  });

  it("refuses a forged, edited, expired, or rebound requestState with -32602", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const { args, core } = setup();
      const channel = toolsChannel();
      const keyed = { meta: { "dev.eve/tool-session": "k1" } };
      const deployArgs = { env: "prod", opts: { a: 1, b: 2 } };
      const deploy = { arguments: deployArgs, name: "deploy" };
      const state = (await rpc(channel, callTool(deploy, keyed), args)).result.requestState;
      const [prefix, body, mac] = state.split(".");
      const envelope = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
      envelope.p.sid = "ts_forged";
      const edited = Buffer.from(JSON.stringify(envelope)).toString("base64url");
      const retry = (params: object, call: ModernCall, target = channel) => {
        const request = { ...deploy, inputResponses: APPROVED, requestState: state, ...params };
        return rpc(target, callTool(request, call), args);
      };
      const rows: Array<[string, object, ModernCall, ReturnType<typeof mcpChannel>?]> = [
        ["edited MAC", { requestState: `${state}x` }, keyed],
        ["forged", { requestState: "v1.e30.AAAA" }, keyed],
        ["edited body", { requestState: `${prefix}.${edited}.${mac}` }, keyed],
        ["unsigned", { requestState: `${prefix}.${body}.` }, keyed],
        ["edited arguments", { arguments: { ...deployArgs, env: "dev" } }, keyed],
        ["another tool", { name: "plain" }, keyed],
        ["another tool session", {}, { meta: { "dev.eve/tool-session": "k2" } }],
        ["no tool session", {}, {}],
        ["another principal", {}, { ...keyed, headers: { "x-test-principal": "user-2" } }],
        ["another secret", {}, keyed, toolsChannel({ requestStateSecret: "y".repeat(32) })],
      ];
      for (const [label, params, call, target] of rows) {
        expect((await retry(params, call, target)).error, label).toMatchObject(INVALID_STATE);
      }
      expect(core).toHaveBeenCalledTimes(1);

      // Just inside the TTL, another channel holding the same secret accepts
      // the honest retry, whatever order its argument keys arrive in.
      vi.setSystemTime(Date.now() + 599_000);
      const reordered = { arguments: { opts: { b: 2, a: 1 }, env: "prod" } };
      expect((await retry(reordered, keyed, toolsChannel())).result.content).toEqual(DEPLOYED);
      expect(core.mock.calls[1]![2]).toMatchObject({ callId: "call_new", key: "k1" });
      vi.setSystemTime(Date.now() + 2_000);
      expect((await retry({}, keyed)).error, "expired").toMatchObject(INVALID_STATE);
      expect(core).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("decodes each approval answer on the retry; no answer or no state asks again", async () => {
    const channel = toolsChannel();
    const first = (await rpc(channel, callTool({ name: "deploy" }), setup().args)).result;
    const denied = { structuredContent: { error: { code: "denied" } } };
    const again = { requestState: expect.any(String), resultType: "input_required" };
    const yes = { action: "accept", content: { approved: true } };
    const rows: Array<[object, unknown, object, boolean?]> = [
      [yes, { approved: true }, { content: DEPLOYED }],
      [{ action: "decline" }, { approved: false }, denied],
      [{ action: "cancel" }, { approved: false }, denied],
      [{ action: "accept", content: { approved: false } }, { approved: false }, denied],
      [{ action: "accept", content: {} }, undefined, again],
      [yes, undefined, again, false],
    ];
    for (const [answer, approval, expected, withState = true] of rows) {
      const label = `${JSON.stringify(answer)} ${withState ? "with" : "without"} state`;
      const { args, core } = setup();
      const params = {
        inputResponses: { "dev.eve/approval": answer },
        name: "deploy",
        ...(withState && { requestState: first.requestState }),
      };
      expect((await rpc(channel, callTool(params), args)).result, label).toMatchObject(expected);
      expect(core.mock.calls[0]![2].approval, label).toEqual(approval);
      expect(core.mock.calls[0]![2].callId, label).toBe(withState ? "call_new" : undefined);
    }
  });

  it("asks for each sign-in by URL and runs only once every connection is accepted", async () => {
    const core = vi.fn<InvokeToolFn>(async (_name, _input, { callId }) =>
      callId === undefined
        ? { ...signInResult("call_two", "linear", "github"), oneOffNonce: "nonce-2" }
        : { modelOutput: { type: "text", value: "deployed" }, output: "ok", status: "completed" },
    );
    const { args } = setup(core);
    const channel = toolsChannel();
    const first = (await rpc(channel, callTool({ name: "issues" }), args)).result;
    expect(first).toMatchObject({
      _meta: { "dev.eve/authorization": { callId: "call_two", connections: ["linear", "github"] } },
      inputRequests: { "dev.eve/authorization:linear": { params: { mode: "url" } } },
    });
    const retry = async (inputResponses?: unknown) => {
      const params = { inputResponses, name: "issues", requestState: first.requestState };
      return (await rpc(channel, callTool(params), args)).result;
    };
    const [linear, github] = ["dev.eve/authorization:linear", "dev.eve/authorization:github"];
    const ok = { action: "accept" };
    const rows: Array<[unknown, "asked" | "denied"]> = [
      [undefined, "asked"],
      [{ "dev.eve/authorization:other": ok }, "asked"],
      [{ [github]: ok, [linear]: { action: "maybe" } }, "asked"],
      [APPROVED, "asked"],
      [{ [linear]: ok }, "asked"],
      [{ [linear]: { action: "decline" } }, "denied"],
      [{ [linear]: { action: "cancel" } }, "denied"],
      [{ [github]: { action: "decline" }, [linear]: ok }, "denied"],
    ];
    for (const [inputResponses, outcome] of rows) {
      const result = await retry(inputResponses);
      const label = JSON.stringify(inputResponses) ?? "no inputResponses";
      if (outcome === "denied") expect(result.structuredContent.error.code, label).toBe("denied");
      else expect(result.inputRequests, label).toEqual(first.inputRequests);
    }
    expect(core).toHaveBeenCalledTimes(1);
    expect((await retry({ [github]: ok, [linear]: ok })).content).toEqual(DEPLOYED);

    // An approval answer carries into the sign-in round that follows it, and
    // an approval response on that sign-in round is ignored.
    const signedIn = { signedIn: false };
    const deploy = setup(fakeCore(signedIn));
    const step = async (requestState: unknown, inputResponses: object) => {
      const params = { inputResponses, name: "deploy", requestState };
      return (await rpc(channel, callTool(params), deploy.args)).result;
    };
    const asked = await step(undefined, {});
    const signIn = await step(asked.requestState, APPROVED);
    expect(signIn.inputRequests).toHaveProperty([linear]);
    signedIn.signedIn = true;
    const late = { "dev.eve/approval": { action: "decline" }, [linear]: ok };
    expect((await step(signIn.requestState, late)).content).toEqual(DEPLOYED);
    expect(deploy.core.mock.calls[2]![2].approval).toEqual({ approved: true });
  });

  it("refuses input the client cannot render, before minting anything", async () => {
    const call2025 = { id: 1, jsonrpc: "2.0", method: "tools/call", params: { name: "deploy" } };
    const rows: Array<[string, Request, boolean?]> = [
      ["approval, no elicitation", callTool({ name: "deploy" }, { capabilities: {} })],
      [
        "approval, url only",
        callTool({ name: "deploy" }, { capabilities: { elicitation: { url: {} } } }),
      ],
      ["sign-in, bare", callTool({ name: "issues" }, { capabilities: { elicitation: {} } })],
      [
        "sign-in, form only",
        callTool({ name: "issues" }, { capabilities: { elicitation: { form: {} } } }),
      ],
      ["the stateless 2025 fallback", mcpRequest(call2025)],
      [
        "approval, bare is form",
        callTool({ name: "deploy" }, { capabilities: { elicitation: {} } }),
        true,
      ],
    ];
    for (const [label, request, supported] of rows) {
      const { result } = await rpc(toolsChannel(), request, setup().args);
      if (supported) expect(result.resultType, label).toBe("input_required");
      else
        expect([result.structuredContent.error.code, result.requestState], label).toEqual([
          "input_unsupported",
          undefined,
        ]);
    }
  });

  it("resolves eve-forwarded-principal before any MCP handling, then calls as the forwarded principal", async () => {
    const endUser: SessionAuthContext = {
      attributes: { team: "équipe" },
      authenticator: "oidc",
      principalId: "end-user",
      principalType: "user",
    };
    const encode = (text: string) => Buffer.from(text).toString("base64url");
    const json = JSON.stringify({ current: endUser });
    const valid = encode(json);
    // Unpadded base64url of 12,288 bytes is exactly the 16 KiB cap; the
    // padding is JSON whitespace, so only the cap can refuse the larger one.
    const sized = (bytes: number) => encode(json + " ".repeat(bytes - Buffer.byteLength(json)));
    const notPrincipal = encode('{"current":{"principalId":"x"}}');
    const latin = Buffer.from([0xff, 0xfe]).toString("base64url");
    // [label, header, trustedForwarders verdict (undefined: none configured),
    //  status or principal, verdict consulted, error substring, anonymous caller]
    type Row = [string, string?, boolean?, (number | string)?, boolean?, string?, boolean?];
    const rows: Row[] = [
      ["no trustedForwarders ignores even a malformed header", "%%%", undefined, "router"],
      ["no header", undefined, true, "router"],
      ["an anonymous caller cannot forward", valid, true, 403, false, undefined, true],
      ["padded", `${valid}=`, true, 400, false, "unpadded base64url"],
      ["not base64url", "not base64!", true, 400, false, "unpadded base64url"],
      ["not UTF-8", latin, true, 400, false, "UTF-8 JSON"],
      ["not JSON", encode("{not json"), true, 400, false, "UTF-8 JSON"],
      ["not a principal", notPrincipal, true, 400],
      ["over 16 KiB", sized(12_289), true, 400, false, "at most 16384 bytes"],
      ["refused by trustedForwarders", valid, false, 403, true],
      ["accepted at the 16 KiB cap", sized(12_288), true, "end-user", true],
    ];
    for (const [label, header, trusted, expected, consulted = false, message, anon] of rows) {
      const trustedForwarders = vi.fn(() => trusted ?? false);
      const { args, core } = setup();
      const forwarders = {
        trustedForwarders: trusted === undefined ? undefined : trustedForwarders,
      };
      const channel = toolsChannel(anon ? { ...forwarders, auth: none() } : forwarders);
      const headers: Record<string, string> = { "x-test-principal": "router" };
      if (header !== undefined) headers["eve-forwarded-principal"] = header;
      const response = await post(channel, callTool({ name: "plain" }, { headers }), args);
      expect(trustedForwarders.mock.calls.length > 0, label).toBe(consulted);
      if (typeof expected === "number") {
        expect(response.status, label).toBe(expected);
        const { error } = (await response.json()) as { error: string };
        expect(error, label).toContain(message ?? "");
        expect(core, label).not.toHaveBeenCalled();
      } else {
        expect(response.status, label).toBe(200);
        expect(core.mock.calls[0]![2].auth.principalId, label).toBe(expected);
      }
    }

    const channel = toolsChannel({ trustedForwarders: () => true });
    const { args } = setup();
    const forwarded = {
      headers: { "eve-forwarded-principal": valid, "x-test-principal": "router" },
    };
    const first = await rpc(channel, callTool({ name: "deploy" }, forwarded), args);
    // The same state replayed by the same user without the forwarder is refused.
    const replay = {
      inputResponses: APPROVED,
      name: "deploy",
      requestState: first.result.requestState,
    };
    const direct = { headers: { "x-test-principal": "end-user" } };
    expect((await rpc(channel, callTool(replay, direct), args)).error).toMatchObject(INVALID_STATE);
  });

  it("acknowledges subscriptions/listen with only what it serves, capped at 100 subscriptions", async () => {
    const notes = "skill://usage-triage/notes.md";
    const missing = (index: number) => `skill://usage-triage/missing-${index}.md`;
    const hundred = [notes, ...Array.from({ length: 99 }, (_, index) => missing(index))];
    const unserved = ["skill://nope/SKILL.md", "skill://usage-triage", "https://example.com/x"];
    const subscribed = [
      notes,
      SKILL_URI,
      notes,
      missing(0),
      ...unserved,
      "skill://usage-triage/../SKILL.md",
    ];
    const rows: Array<[string, object, object]> = [
      [
        "unserved kinds",
        { promptsListChanged: true, toolsListChanged: true },
        { toolsListChanged: true },
      ],
      [
        "served files, once",
        { resourceSubscriptions: subscribed },
        { resourceSubscriptions: [notes, SKILL_URI] },
      ],
      ["nothing readable", { resourceSubscriptions: unserved }, {}],
      ["exactly 100", { resourceSubscriptions: hundred }, { resourceSubscriptions: [notes] }],
    ];
    const channel = toolsChannel({ skills: true });
    const listen = (notifications: object, args = setup().args) =>
      post(channel, modernRequest("subscriptions/listen", { notifications }), args);
    for (const [label, notifications, acknowledged] of rows) {
      expect(await jsonRpcResponse(await listen(notifications)), label).toMatchObject({
        method: "notifications/subscriptions/acknowledged",
        params: expect.objectContaining({ notifications: acknowledged }),
      });
    }
    // 101 is refused as a JSON error before any skill file is read.
    const reads = vi.fn(readSkill);
    const over = await listen(
      { resourceSubscriptions: [...hundred, missing(99)] },
      routeArgs({ description: toolsDescription, readSkill: reads }),
    );
    expect(over.headers.get("content-type")).toContain("application/json");
    expect(await over.json()).toMatchObject({ error: { code: -32_602 }, id: 1 });
    expect(reads).not.toHaveBeenCalled();
  });
});
