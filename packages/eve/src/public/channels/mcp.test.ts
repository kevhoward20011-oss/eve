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

const SECRET = "x".repeat(32);
const CAPS_ALL = {
  elicitation: { form: {}, url: {} },
  extensions: { "dev.eve/tool-sessions": {} },
};
const APPROVED = { "dev.eve/approval": { action: "accept", content: { approved: true } } };
const DEPLOYED = [{ text: "deployed", type: "text" }];
const INVALID_REQUEST_STATE = {
  code: -32_602,
  data: { reason: "invalid_request_state" },
  message: "Invalid or expired requestState",
};

const toolsDescription: AgentDescription = {
  name: "compiled-agent",
  skills: [],
  tools: [
    {
      approval: true,
      description: "Deploys.",
      inputSchema: { properties: { env: { type: "string" } }, type: "object" },
      invocable: true,
      name: "deploy",
    },
    {
      approval: false,
      description: "Runs only in a turn.",
      inputSchema: { type: "object" },
      invocable: false,
      name: "harness_only",
    },
    {
      approval: false,
      description: "Reads issues.",
      inputSchema: { type: "object" },
      invocable: true,
      name: "issues",
    },
    {
      approval: false,
      description: "Echoes.",
      inputSchema: {
        additionalProperties: false,
        properties: { x: { type: "number" } },
        type: "object",
      },
      invocable: true,
      name: "plain",
      outputSchema: { properties: { x: { type: "number" } }, type: "object" },
    },
  ],
};

const SKILL_MD =
  "---\nname: usage-triage\ndescription: Triage a usage spike.\n---\nRead references/runbook.md.\n";
const SKILL_FILES: Readonly<Record<string, string>> = {
  "SKILL.md": SKILL_MD,
  "references/runbook.md": "# Runbook\n",
};
const skillsDescription: AgentDescription = {
  ...toolsDescription,
  skills: [
    { description: "Triage a usage spike.", files: Object.keys(SKILL_FILES), name: "usage-triage" },
  ],
};

async function readSkill(skill: string, path = "SKILL.md"): Promise<string> {
  const content = skill === "usage-triage" ? SKILL_FILES[path] : undefined;
  if (content === undefined) throw new SkillReadError("unknown-file", path);
  return content;
}

interface ModernCall {
  readonly capabilities?: Readonly<Record<string, unknown>>;
  readonly headers?: Record<string, string>;
  readonly meta?: Readonly<Record<string, unknown>>;
}

function modernRequest(
  method: string,
  params: Readonly<Record<string, unknown>> = {},
  call: ModernCall = {},
): Request {
  const headers: Record<string, string> = {
    "mcp-method": method,
    "mcp-protocol-version": MCP_PROTOCOL_VERSION,
    ...call.headers,
  };
  if (typeof params.name === "string") headers["mcp-name"] = params.name;
  return mcpRequest(
    {
      id: 1,
      jsonrpc: "2.0",
      method,
      params: {
        ...params,
        _meta: {
          ...call.meta,
          "io.modelcontextprotocol/clientCapabilities": call.capabilities ?? CAPS_ALL,
          "io.modelcontextprotocol/clientInfo": { name: "test-client", version: "0.0.0" },
          "io.modelcontextprotocol/protocolVersion": MCP_PROTOCOL_VERSION,
        },
      },
    },
    headers,
  );
}

type JsonRpc = {
  readonly error?: { readonly code: number; readonly data?: unknown; readonly message: string };
  readonly result?: Record<string, any>;
};

function postHandler(channel: ReturnType<typeof mcpChannel>) {
  const route = channel.routes.find((entry) => entry.method === "POST")!;
  if (route.transport === "websocket") throw new Error("expected HTTP route");
  return route.handler;
}

async function rpc(
  channel: ReturnType<typeof mcpChannel>,
  request: Request,
  args: RouteHandlerArgs,
): Promise<JsonRpc> {
  return (await jsonRpcResponse(await postHandler(channel)(request, args))) as JsonRpc;
}

/** A core stand-in: `deploy` needs approval, `issues` needs a sign-in until `signedIn`. */
function fakeCore(state: { signedIn?: boolean; challengeUrl?: string | null } = {}) {
  return vi.fn<InvokeToolFn>(async (name, input, options) => {
    const callId = options.callId ?? "call_new";
    const nonce = options.key === undefined ? (options.oneOffNonce ?? "nonce-1") : undefined;
    const pause = nonce === undefined ? {} : { oneOffNonce: nonce };
    if (name === "plain") {
      return {
        modelOutput: { type: "json", value: input },
        output: input,
        sandbox: { ms: 12, state: "created" },
        status: "completed",
      };
    }
    if (name === "deploy") {
      if (options.approval === undefined) return { callId, status: "approval-required", ...pause };
      if (!options.approval.approved) return { reason: "The person declined.", status: "denied" };
      if (state.signedIn === false) {
        return {
          callId,
          challenges: [{ challenge: { url: "https://idp.example/a" }, name: "linear" }],
          status: "authorization-required",
          ...pause,
        };
      }
      return {
        modelOutput: { type: "text", value: "deployed" },
        output: "deployed",
        status: "completed",
      };
    }
    if (name === "issues") {
      if (state.signedIn !== true) {
        return {
          callId,
          challenges: [
            {
              challenge:
                state.challengeUrl === null
                  ? { message: "Approve on your phone." }
                  : { url: state.challengeUrl ?? "https://idp.example/a", userCode: "ABCD" },
              name: "linear",
            },
          ],
          status: "authorization-required",
          ...pause,
        };
      }
      return {
        modelOutput: { type: "text", value: "3 issues" },
        output: { count: 3 },
        status: "completed",
      };
    }
    return {
      errorId: "err_1",
      message: `The agent has no tool named "${name}".`,
      status: "failed",
    };
  });
}

function decodeState(state: unknown): Record<string, any> {
  if (typeof state !== "string") throw new Error("requestState was not a string.");
  return JSON.parse(Buffer.from(state.split(".")[1]!, "base64url").toString("utf8")).p;
}

function toolsChannel(input: Partial<Parameters<typeof mcpChannel>[0]> = {}) {
  return mcpChannel({
    auth: (request) => ({
      attributes: {},
      authenticator: "test",
      principalId: request.headers.get("x-test-principal") ?? "user-1",
      principalType: "user",
    }),
    requestStateSecret: SECRET,
    tools: true,
    ...input,
  });
}

const AGENT_TOOL_NAMES = ["agent_start", "agent_get", "agent_update", "agent_cancel"];

/** The `agent_*` entries a default channel lists, where the SDK builds them. */
async function defaultAgentTools(): Promise<unknown[]> {
  const listed = await rpc(
    toolsChannel({ tools: false }),
    modernRequest("tools/list"),
    routeArgs({ description: toolsDescription }),
  );
  return listed.result?.tools ?? [];
}

describe("mcpChannel tools", () => {
  it("lists the agent_* tools as a default channel does, then invocable tools in order", async () => {
    const channel = toolsChannel();
    const args = routeArgs({ description: toolsDescription });
    const listed = await rpc(channel, modernRequest("tools/list"), args);
    const agentTools = await defaultAgentTools();

    expect(agentTools.map((tool) => (tool as { name: string }).name)).toEqual(AGENT_TOOL_NAMES);
    expect(listed.result).toEqual({
      cacheScope: "private",
      resultType: "complete",
      tools: [
        ...agentTools,
        {
          _meta: { "dev.eve/approval": true },
          description: "Deploys.",
          inputSchema: toolsDescription.tools[0]!.inputSchema,
          name: "deploy",
        },
        { description: "Reads issues.", inputSchema: { type: "object" }, name: "issues" },
        {
          description: "Echoes.",
          inputSchema: toolsDescription.tools[3]!.inputSchema,
          name: "plain",
          outputSchema: toolsDescription.tools[3]!.outputSchema,
        },
      ],
      ttlMs: 300_000,
      _meta: expect.anything(),
    });

    const discovered = await rpc(channel, modernRequest("server/discover"), args);
    expect(discovered.result).toMatchObject({ cacheScope: "private", ttlMs: 300_000 });

    const legacy = await rpc(
      channel,
      mcpRequest({ id: 1, jsonrpc: "2.0", method: "tools/list" }),
      args,
    );
    expect(legacy.result?.tools).toEqual(listed.result?.tools);
  });

  it("reserves the agent_* names over an agent tool with the same name", async () => {
    const invokeTool = fakeCore();
    const description: AgentDescription = {
      ...toolsDescription,
      tools: [
        {
          approval: false,
          description: "An authored tool that collides.",
          inputSchema: { type: "object" },
          invocable: true,
          name: "agent_start",
        },
        ...toolsDescription.tools,
      ],
    };
    const args = routeArgs({ description, invokeTool });
    const listed = await rpc(toolsChannel(), modernRequest("tools/list"), args);
    const names = listed.result?.tools.map((tool: { name: string }) => tool.name);
    expect(names.filter((name: string) => name === "agent_start")).toHaveLength(1);
    expect(listed.result?.tools[0]).toEqual((await defaultAgentTools())[0]);

    const called = await rpc(
      toolsChannel(),
      modernRequest("tools/call", { arguments: {}, name: "agent_start" }),
      args,
    );
    expect(called.result?.isError).toBe(true);
    expect(invokeTool).not.toHaveBeenCalled();
  });

  it("validates agent_* input the same way whether or not tools are published", async () => {
    const call = modernRequest("tools/call", { arguments: { message: "" }, name: "agent_start" });
    const args = routeArgs({ description: toolsDescription });
    const published = await rpc(toolsChannel(), call.clone(), args);
    const unpublished = await rpc(toolsChannel({ tools: false }), call, args);

    expect(published.result?.isError).toBe(true);
    expect(published.result?.content).toEqual(unpublished.result?.content);
    expect(published.result?.content[0].text).toContain(
      "Input validation error: Invalid arguments for tool agent_start",
    );
  });

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

  it("tools: false serves only the agent_* tools, without the tool-sessions extension", async () => {
    const invokeTool = fakeCore();
    const channel = toolsChannel({ tools: false });
    const args = routeArgs({ description: toolsDescription, invokeTool });

    const discovered = await rpc(channel, modernRequest("server/discover"), args);
    expect(discovered.result?.capabilities.tools).toEqual({ listChanged: false });
    expect(discovered.result?.capabilities.extensions?.["dev.eve/tool-sessions"]).toBeUndefined();

    const listed = await rpc(channel, modernRequest("tools/list"), args);
    expect(listed.result?.tools.map((tool: { name: string }) => tool.name)).toEqual(
      AGENT_TOOL_NAMES,
    );
    const called = await rpc(
      channel,
      modernRequest("tools/call", { arguments: { x: 1 }, name: "plain" }),
      args,
    );
    expect(called.error?.code).toBe(-32_602);
    expect(invokeTool).not.toHaveBeenCalled();
  });

  it("maps a completed call: content, structuredContent, sandbox meta, and the call options", async () => {
    const invokeTool = fakeCore();
    const called = await rpc(
      toolsChannel(),
      modernRequest(
        "tools/call",
        { arguments: { x: 1 }, name: "plain" },
        { meta: { "dev.eve/tool-session": "thread-1" } },
      ),
      routeArgs({ description: toolsDescription, invokeTool }),
    );

    expect(called.result).toMatchObject({
      _meta: { "dev.eve/sandbox": { ms: 12, state: "created" } },
      content: [{ text: '{"x":1}', type: "text" }],
      structuredContent: { x: 1 },
    });
    expect(called.result?.isError).toBeUndefined();
    const [, input, options] = invokeTool.mock.calls[0]!;
    expect(input).toEqual({ x: 1 });
    expect(options.auth.principalId).toBe("user-1");
    expect(options.key).toBe("thread-1");
    expect(options.forwarder).toBeUndefined();
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(options.callId).toBeUndefined();
  });

  it("maps failed, invalid-input, and denied to isError results, keeping sandbox meta", async () => {
    const results = [
      [
        { errorId: "err_9", message: "Boom.", status: "failed" },
        "internal",
        "Boom. (errorId: err_9)",
      ],
      [
        { message: "x must be a number.", status: "invalid-input" },
        "invalid_input",
        "x must be a number.",
      ],
      [{ reason: "Read-only.", status: "denied" }, "denied", "Read-only."],
      [{ status: "denied" }, "denied", "The call was denied."],
    ] as const;
    for (const [result, code, text] of results) {
      const called = await rpc(
        toolsChannel(),
        modernRequest("tools/call", { arguments: {}, name: "plain" }),
        routeArgs({
          description: toolsDescription,
          invokeTool: async () => ({ ...result, sandbox: { ms: 1, state: "reused" } }),
        }),
      );
      expect(called.result).toMatchObject({
        _meta: { "dev.eve/sandbox": { ms: 1, state: "reused" } },
        content: [{ text, type: "text" }],
        isError: true,
        structuredContent: { error: { code, retryable: false } },
      });
    }
  });

  it("never runs unknown or non-invocable tools", async () => {
    const invokeTool = fakeCore();
    for (const name of ["missing", "harness_only"]) {
      const called = await rpc(
        toolsChannel(),
        modernRequest("tools/call", { arguments: {}, name }),
        routeArgs({ description: toolsDescription, invokeTool }),
      );
      expect(called.error?.code).toBe(-32_602);
    }
    expect(invokeTool).not.toHaveBeenCalled();
  });

  it("refuses a non-string tool session key as invalid_input", async () => {
    const invokeTool = fakeCore();
    const called = await rpc(
      toolsChannel(),
      modernRequest(
        "tools/call",
        { arguments: {}, name: "plain" },
        { meta: { "dev.eve/tool-session": 7 } },
      ),
      routeArgs({ description: toolsDescription, invokeTool }),
    );
    expect(called.result?.structuredContent.error.code).toBe("invalid_input");
    expect(invokeTool).not.toHaveBeenCalled();
  });

  it("ignores a tool session key from a client that did not declare dev.eve/tool-sessions", async () => {
    const invokeTool = fakeCore();
    const channel = toolsChannel();
    const args = routeArgs({ description: toolsDescription, invokeTool });
    for (const capabilities of [
      { elicitation: { form: {}, url: {} } },
      { elicitation: { form: {}, url: {} }, extensions: {} },
      { elicitation: { form: {}, url: {} }, extensions: { "dev.eve/other": {} } },
    ]) {
      const called = await rpc(
        channel,
        modernRequest(
          "tools/call",
          { arguments: { x: 1 }, name: "plain" },
          { capabilities, meta: { "dev.eve/tool-session": "thread-1" } },
        ),
        args,
      );
      expect(called.result?.isError).toBeUndefined();
    }
    // Even a malformed key is ignored, not refused: the client never opted in.
    await rpc(
      channel,
      modernRequest(
        "tools/call",
        { arguments: { x: 1 }, name: "plain" },
        { capabilities: { elicitation: {} }, meta: { "dev.eve/tool-session": 7 } },
      ),
      args,
    );
    expect(invokeTool).toHaveBeenCalledTimes(4);
    for (const [, , options] of invokeTool.mock.calls) expect(options.key).toBeUndefined();

    // A paused undeclared call is a one-off: the state carries a nonce, and
    // the retry reaches the same one-off session, not the key's.
    const undeclared = {
      capabilities: { elicitation: { form: {} } },
      meta: { "dev.eve/tool-session": "k1" },
    };
    const asked = await rpc(
      channel,
      modernRequest("tools/call", { arguments: { env: "prod" }, name: "deploy" }, undeclared),
      args,
    );
    expect(decodeState(asked.result?.requestState).nonce).toBe("nonce-1");
    const approved = await rpc(
      channel,
      modernRequest(
        "tools/call",
        {
          arguments: { env: "prod" },
          inputResponses: { "dev.eve/approval": { action: "accept", content: { approved: true } } },
          name: "deploy",
          requestState: asked.result?.requestState,
        },
        undeclared,
      ),
      args,
    );
    expect(approved.result?.content).toEqual([{ text: "deployed", type: "text" }]);
    expect(invokeTool.mock.calls.at(-1)![2]).toMatchObject({ oneOffNonce: "nonce-1" });
    expect(invokeTool.mock.calls.at(-1)![2].key).toBeUndefined();
  });

  it("asks for approval with a signed requestState and maps each answer on the retry", async () => {
    const channel = toolsChannel();
    const first = await rpc(
      channel,
      modernRequest("tools/call", { arguments: { env: "prod" }, name: "deploy" }),
      routeArgs({ description: toolsDescription, invokeTool: fakeCore() }),
    );
    expect(first.result).toMatchObject({
      _meta: { "dev.eve/approval": { callId: "call_new", tool: "deploy" } },
      inputRequests: {
        "dev.eve/approval": {
          method: "elicitation/create",
          params: {
            message: 'Allow the tool "deploy" to run?',
            mode: "form",
            requestedSchema: {
              properties: { approved: { title: "Approve", type: "boolean" } },
              required: ["approved"],
              type: "object",
            },
          },
        },
      },
      resultType: "input_required",
    });
    const requestState = first.result?.requestState as string;
    expect(requestState.startsWith("v1.")).toBe(true);

    const denied = {
      structuredContent: {
        error: { code: "denied", message: "The person declined.", retryable: false },
      },
    };
    const askedAgain = { requestState: expect.any(String), resultType: "input_required" };
    const answers: Array<{
      readonly answer: Readonly<Record<string, unknown>>;
      readonly approval: { readonly approved: boolean } | undefined;
      readonly expected: Readonly<Record<string, unknown>>;
      readonly state?: string;
    }> = [
      {
        answer: { action: "accept", content: { approved: true } },
        approval: { approved: true },
        expected: { content: DEPLOYED },
        state: requestState,
      },
      {
        answer: { action: "decline" },
        approval: { approved: false },
        expected: denied,
        state: requestState,
      },
      {
        answer: { action: "cancel" },
        approval: { approved: false },
        expected: denied,
        state: requestState,
      },
      {
        answer: { action: "accept", content: { approved: false } },
        approval: { approved: false },
        expected: denied,
        state: requestState,
      },
      // No answer asks again; it never declines.
      {
        answer: { action: "accept", content: {} },
        approval: undefined,
        expected: askedAgain,
        state: requestState,
      },
      // Without a requestState, inputResponses are ignored.
      {
        answer: { action: "accept", content: { approved: true } },
        approval: undefined,
        expected: askedAgain,
      },
    ];
    for (const { answer, approval, expected, state } of answers) {
      const invokeTool = fakeCore();
      const params: Record<string, unknown> = {
        arguments: { env: "prod" },
        inputResponses: { "dev.eve/approval": answer },
        name: "deploy",
      };
      if (state !== undefined) params.requestState = state;
      const retried = await rpc(
        channel,
        modernRequest("tools/call", params),
        routeArgs({ description: toolsDescription, invokeTool }),
      );
      const label = `${JSON.stringify(answer)} ${state === undefined ? "without" : "with"} state`;
      expect(retried.result, label).toMatchObject(expected);
      const [, , options] = invokeTool.mock.calls[0]!;
      expect(options.approval, label).toEqual(approval);
      if (state === undefined) {
        expect(options.callId, label).toBeUndefined();
      } else {
        expect(options, label).toMatchObject({ callId: "call_new", oneOffNonce: "nonce-1" });
      }
    }
  });

  it("refuses a forged, edited, expired, or rebound requestState with -32602", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const invokeTool = fakeCore();
      const channel = toolsChannel();
      const args = routeArgs({ description: toolsDescription, invokeTool });
      const keyed = { meta: { "dev.eve/tool-session": "k1" } };
      const deployArgs = { env: "prod", opts: { a: 1, b: 2 } };
      const first = await rpc(
        channel,
        modernRequest("tools/call", { arguments: deployArgs, name: "deploy" }, keyed),
        args,
      );
      const requestState = first.result?.requestState as string;
      const [prefix, body, mac] = requestState.split(".");
      const envelope = JSON.parse(Buffer.from(body!, "base64url").toString("utf8"));
      const editedBody = Buffer.from(
        JSON.stringify({ ...envelope, p: { ...envelope.p, sid: "ts_forged" } }),
      ).toString("base64url");
      const retry = (
        params: Readonly<Record<string, unknown>>,
        call: ModernCall,
        target = channel,
      ): Promise<JsonRpc> =>
        rpc(
          target,
          modernRequest(
            "tools/call",
            {
              arguments: deployArgs,
              inputResponses: APPROVED,
              name: "deploy",
              requestState,
              ...params,
            },
            call,
          ),
          args,
        );

      const refusals: Array<[string, Record<string, unknown>, ModernCall]> = [
        ["edited MAC", { requestState: `${requestState}x` }, keyed],
        ["forged", { requestState: "v1.e30.AAAA" }, keyed],
        ["edited body", { requestState: `${prefix}.${editedBody}.${mac}` }, keyed],
        ["unsigned", { requestState: `${prefix}.${body}.` }, keyed],
        ["edited arguments", { arguments: { ...deployArgs, env: "dev" } }, keyed],
        ["another tool", { name: "plain" }, keyed],
        ["another tool session", {}, { meta: { "dev.eve/tool-session": "k2" } }],
        ["no tool session", {}, {}],
        ["another principal", {}, { ...keyed, headers: { "x-test-principal": "user-2" } }],
      ];
      for (const [label, params, call] of refusals) {
        expect((await retry(params, call)).error, label).toEqual(INVALID_REQUEST_STATE);
      }
      const foreign = toolsChannel({ requestStateSecret: "y".repeat(32) });
      expect((await retry({}, keyed, foreign)).error, "another secret").toEqual(
        INVALID_REQUEST_STATE,
      );
      expect(invokeTool).toHaveBeenCalledTimes(1);

      // Just inside the TTL, a second channel holding only the same secret
      // accepts the honest retry, whatever order its argument keys arrive in.
      vi.setSystemTime(Date.now() + 599_000);
      const accepted = await retry(
        { arguments: { opts: { b: 2, a: 1 }, env: "prod" } },
        keyed,
        toolsChannel(),
      );
      expect(accepted.result?.content).toEqual(DEPLOYED);
      expect(invokeTool.mock.calls[1]![2]).toMatchObject({ callId: "call_new", key: "k1" });
      expect(invokeTool.mock.calls[1]![2].oneOffNonce).toBeUndefined();

      // Past the 600 s TTL the same retry is refused.
      vi.setSystemTime(Date.now() + 2_000);
      expect((await retry({}, keyed)).error, "expired").toEqual(INVALID_REQUEST_STATE);
      expect(invokeTool).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
  it("asks for each sign-in by URL and retries into the same session", async () => {
    const core = { signedIn: false };
    const invokeTool = fakeCore(core);
    const channel = toolsChannel();
    const args = routeArgs({ description: toolsDescription, invokeTool });
    const first = await rpc(
      channel,
      modernRequest("tools/call", { arguments: {}, name: "issues" }),
      args,
    );
    expect(first.result).toMatchObject({
      _meta: { "dev.eve/authorization": { callId: "call_new", connections: ["linear"] } },
      inputRequests: {
        "dev.eve/authorization:linear": {
          method: "elicitation/create",
          params: {
            message: "Sign in to linear to continue. Code: ABCD",
            mode: "url",
            url: "https://idp.example/a",
          },
        },
      },
      resultType: "input_required",
    });

    const retry = (requestState: unknown) =>
      rpc(
        channel,
        modernRequest("tools/call", {
          arguments: {},
          inputResponses: { "dev.eve/authorization:linear": { action: "accept" } },
          name: "issues",
          requestState,
        }),
        args,
      );
    const early = await retry(first.result?.requestState);
    expect(early.result?.resultType).toBe("input_required");
    core.signedIn = true;
    const done = await retry(early.result?.requestState);
    expect(done.result).toMatchObject({ structuredContent: { count: 3 } });
    expect(invokeTool.mock.calls[2]![2]).toMatchObject({
      callId: "call_new",
      oneOffNonce: "nonce-1",
    });
  });

  it("never runs a sign-in retry without an accept for every requested connection", async () => {
    // Any retry that reaches the core completes, so one that ran too early shows.
    const invokeTool = vi.fn<InvokeToolFn>(async (_name, _input, options) => {
      if (options.callId !== undefined) {
        return { modelOutput: { type: "text", value: "ok" }, output: "ok", status: "completed" };
      }
      return {
        callId: "call_two",
        challenges: [
          { challenge: { url: "https://idp.example/a" }, name: "linear" },
          { challenge: { url: "https://idp.example/b" }, name: "github" },
        ],
        oneOffNonce: "nonce-2",
        status: "authorization-required",
      };
    });
    const channel = toolsChannel();
    const args = routeArgs({ description: toolsDescription, invokeTool });
    const first = await rpc(
      channel,
      modernRequest("tools/call", { arguments: {}, name: "issues" }),
      args,
    );
    const retry = (inputResponses?: unknown) => {
      const params: Record<string, unknown> = {
        arguments: {},
        name: "issues",
        requestState: first.result?.requestState,
      };
      if (inputResponses !== undefined) params.inputResponses = inputResponses;
      return rpc(channel, modernRequest("tools/call", params), args);
    };
    const linear = "dev.eve/authorization:linear";
    const github = "dev.eve/authorization:github";
    const accept = { action: "accept" };

    for (const unanswered of [
      undefined,
      {},
      { "dev.eve/authorization:other": accept },
      { [github]: accept, [linear]: { action: "maybe" } },
      { "dev.eve/approval": { action: "accept", content: { approved: true } } },
      { [linear]: accept },
    ]) {
      const again = await retry(unanswered);
      const label = JSON.stringify(unanswered) ?? "no inputResponses";
      // Same questions, a fresh state, nothing run.
      expect(again.result, label).toMatchObject({
        _meta: {
          "dev.eve/authorization": { callId: "call_two", connections: ["linear", "github"] },
        },
        inputRequests: first.result?.inputRequests,
        resultType: "input_required",
      });
      expect(Object.keys(again.result?.inputRequests ?? {}), label).toEqual([linear, github]);
      expect(decodeState(again.result?.requestState), label).toMatchObject({
        callId: "call_two",
        kind: "authorization",
        nonce: "nonce-2",
        signIns: [
          { name: "linear", url: "https://idp.example/a" },
          { name: "github", url: "https://idp.example/b" },
        ],
      });
    }
    for (const declined of [
      { [linear]: { action: "decline" } },
      { [linear]: { action: "cancel" } },
      { [github]: { action: "decline" }, [linear]: accept },
    ]) {
      expect((await retry(declined)).result, JSON.stringify(declined)).toMatchObject({
        isError: true,
        structuredContent: { error: { code: "denied" } },
      });
    }
    expect(invokeTool).toHaveBeenCalledTimes(1);

    const both = await retry({ [github]: accept, [linear]: accept });
    expect(both.result?.content).toEqual([{ text: "ok", type: "text" }]);
    expect(invokeTool).toHaveBeenCalledTimes(2);
  });
  it("carries the approval answer into the sign-in round that follows it", async () => {
    const core = { signedIn: false };
    const invokeTool = fakeCore(core);
    const channel = toolsChannel();
    const args = routeArgs({ description: toolsDescription, invokeTool });
    const asked = await rpc(
      channel,
      modernRequest("tools/call", { arguments: {}, name: "deploy" }),
      args,
    );
    const signIn = await rpc(
      channel,
      modernRequest("tools/call", {
        arguments: {},
        inputResponses: { "dev.eve/approval": { action: "accept", content: { approved: true } } },
        name: "deploy",
        requestState: asked.result?.requestState,
      }),
      args,
    );
    expect(signIn.result?.inputRequests).toHaveProperty(["dev.eve/authorization:linear"]);
    core.signedIn = true;
    const done = await rpc(
      channel,
      modernRequest("tools/call", {
        arguments: {},
        inputResponses: {
          "dev.eve/approval": { action: "decline" },
          "dev.eve/authorization:linear": { action: "accept" },
        },
        name: "deploy",
        requestState: signIn.result?.requestState,
      }),
      args,
    );
    // The carried answer wins; an approval response on a sign-in round is ignored.
    expect(done.result?.content).toEqual([{ text: "deployed", type: "text" }]);
    expect(invokeTool.mock.calls[2]![2].approval).toEqual({ approved: true });
  });

  it("refuses input the client cannot render, before minting anything", async () => {
    const call = (name: string, capabilities: Readonly<Record<string, unknown>>) =>
      modernRequest("tools/call", { arguments: {}, name }, { capabilities });
    const cases: Array<[string, Request]> = [
      ["approval without elicitation", call("deploy", {})],
      ["approval with only url elicitation", call("deploy", { elicitation: { url: {} } })],
      ["sign-in with bare elicitation", call("issues", { elicitation: {} })],
      ["sign-in with only form elicitation", call("issues", { elicitation: { form: {} } })],
      [
        "the stateless 2025 fallback",
        mcpRequest({
          id: 1,
          jsonrpc: "2.0",
          method: "tools/call",
          params: { arguments: {}, name: "deploy" },
        }),
      ],
    ];
    for (const [label, request] of cases) {
      const called = await rpc(
        toolsChannel(),
        request,
        routeArgs({ description: toolsDescription, invokeTool: fakeCore() }),
      );
      expect(called.result, label).toMatchObject({
        isError: true,
        structuredContent: { error: { code: "input_unsupported" } },
      });
    }
    // A bare `elicitation: {}` implies form mode.
    const bare = await rpc(
      toolsChannel(),
      call("deploy", { elicitation: {} }),
      routeArgs({ description: toolsDescription, invokeTool: fakeCore() }),
    );
    expect(bare.result?.resultType).toBe("input_required");
  });

  it("refuses a sign-in challenge without a URL, naming the connection", async () => {
    const called = await rpc(
      toolsChannel(),
      modernRequest("tools/call", { arguments: {}, name: "issues" }),
      routeArgs({ description: toolsDescription, invokeTool: fakeCore({ challengeUrl: null }) }),
    );
    expect(called.result).toMatchObject({ isError: true });
    expect(called.result?.structuredContent.error.message).toContain('"linear"');
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

  it("resolves eve-forwarded-principal before any MCP handling, then calls as the forwarded principal", async () => {
    const endUser: SessionAuthContext = {
      attributes: { team: "équipe" },
      authenticator: "oidc",
      principalId: "end-user",
      principalType: "user",
    };
    const encode = (text: string) => Buffer.from(text).toString("base64url");
    const valid = encode(JSON.stringify({ current: endUser }));
    // Unpadded base64url of 12,288 bytes is exactly the 16 KiB cap; the
    // padding is JSON whitespace, so only the cap can refuse the larger one.
    const sized = (bytes: number) => {
      const json = JSON.stringify({ current: endUser });
      return encode(json + " ".repeat(bytes - Buffer.byteLength(json)));
    };
    const rows: Array<{
      readonly label: string;
      readonly header?: string;
      /** The `trustedForwarders` verdict; omitted for a channel without one. */
      readonly trusted?: boolean;
      readonly anonymous?: true;
      /** An HTTP status, or the principal the tool runs as. */
      readonly expected: number | string;
      readonly message?: string;
      readonly consulted: boolean;
    }> = [
      {
        consulted: false,
        expected: "router",
        header: "%%%",
        label: "no trustedForwarders ignores even a malformed header",
      },
      { consulted: false, expected: "router", label: "no header", trusted: true },
      {
        anonymous: true,
        consulted: false,
        expected: 403,
        header: valid,
        label: "an anonymous caller cannot forward",
        trusted: true,
      },
      {
        consulted: false,
        expected: 400,
        header: `${valid}=`,
        label: "padded",
        message: "unpadded base64url",
        trusted: true,
      },
      {
        consulted: false,
        expected: 400,
        header: "not base64!",
        label: "not base64url",
        message: "unpadded base64url",
        trusted: true,
      },
      {
        consulted: false,
        expected: 400,
        header: Buffer.from([0xff, 0xfe]).toString("base64url"),
        label: "not UTF-8",
        message: "UTF-8 JSON",
        trusted: true,
      },
      {
        consulted: false,
        expected: 400,
        header: encode("{not json"),
        label: "not JSON",
        message: "UTF-8 JSON",
        trusted: true,
      },
      {
        consulted: false,
        expected: 400,
        header: encode(JSON.stringify({ current: { principalId: "x" } })),
        label: "not a principal",
        trusted: true,
      },
      {
        consulted: false,
        expected: 400,
        header: sized(12_289),
        label: "over 16 KiB",
        message: "at most 16384 bytes",
        trusted: true,
      },
      {
        consulted: true,
        expected: 403,
        header: valid,
        label: "refused by trustedForwarders",
        trusted: false,
      },
      {
        consulted: true,
        expected: "end-user",
        header: sized(12_288),
        label: "accepted at the 16 KiB cap",
        trusted: true,
      },
    ];
    for (const row of rows) {
      const trustedForwarders = vi.fn(() => row.trusted ?? false);
      const invokeTool = fakeCore();
      const forwarders = {
        trustedForwarders: row.trusted === undefined ? undefined : trustedForwarders,
      };
      const channel = toolsChannel(row.anonymous ? { ...forwarders, auth: none() } : forwarders);
      const headers: Record<string, string> = { "x-test-principal": "router" };
      if (row.header !== undefined) headers["eve-forwarded-principal"] = row.header;
      const response = await postHandler(channel)(
        modernRequest("tools/call", { arguments: { x: 1 }, name: "plain" }, { headers }),
        routeArgs({ description: toolsDescription, invokeTool }),
      );
      expect(trustedForwarders.mock.calls.length > 0, row.label).toBe(row.consulted);
      if (typeof row.expected === "number") {
        expect(response.status, row.label).toBe(row.expected);
        const { error } = (await response.json()) as { error: string };
        if (row.message !== undefined) expect(error, row.label).toContain(row.message);
        expect(invokeTool, row.label).not.toHaveBeenCalled();
      } else {
        expect(response.status, row.label).toBe(200);
        expect(invokeTool.mock.calls[0]![2].auth.principalId, row.label).toBe(row.expected);
      }
    }

    const invokeTool = fakeCore();
    const trustedForwarders = vi.fn(() => true);
    const channel = toolsChannel({ trustedForwarders });
    const args = routeArgs({ description: toolsDescription, invokeTool });
    const first = await rpc(
      channel,
      modernRequest(
        "tools/call",
        { arguments: {}, name: "deploy" },
        { headers: { "eve-forwarded-principal": valid, "x-test-principal": "router" } },
      ),
      args,
    );
    const stamped = {
      ...endUser,
      attributes: { ...endUser.attributes, "eve:forwarded-by": "router" },
    };
    expect(invokeTool.mock.calls[0]![2]).toMatchObject({
      auth: stamped,
      forwarder: { principalId: "router" },
      initiator: stamped,
    });
    expect(trustedForwarders).toHaveBeenCalledWith(
      expect.objectContaining({ principalId: "router" }),
      {
        principal: { current: stamped, initiator: stamped },
      },
    );

    // The same state replayed by the same user without the forwarder is refused.
    const replayed = await rpc(
      channel,
      modernRequest(
        "tools/call",
        {
          arguments: {},
          inputResponses: APPROVED,
          name: "deploy",
          requestState: first.result?.requestState,
        },
        { headers: { "x-test-principal": "end-user" } },
      ),
      args,
    );
    expect(replayed.error).toEqual(INVALID_REQUEST_STATE);
  });

  it("serves skills only with skills: true, beside the tools", async () => {
    const args = routeArgs({ description: skillsDescription, invokeTool: fakeCore(), readSkill });
    const entry = "skill://usage-triage/SKILL.md";
    for (const skills of [undefined, true]) {
      const label = `skills: ${skills}`;
      const channel = toolsChannel(skills === undefined ? {} : { skills });
      const discovered = await rpc(channel, modernRequest("server/discover"), args);
      const tools = await rpc(channel, modernRequest("tools/list"), args);
      const listed = await rpc(channel, modernRequest("skills/list"), args);
      const read = await rpc(
        channel,
        modernRequest("resources/read", { uri: entry }, { headers: { "mcp-name": entry } }),
        args,
      );
      expect(
        tools.result?.tools.map((tool: { name: string }) => tool.name),
        label,
      ).toEqual([...AGENT_TOOL_NAMES, "deploy", "issues", "plain"]);
      if (skills === true) {
        expect(discovered.result?.capabilities, label).toMatchObject({
          extensions: {
            "dev.eve/tool-sessions": {},
            "io.modelcontextprotocol/skills": { directoryRead: true },
          },
          resources: { listChanged: true, subscribe: true },
        });
        expect(listed.result?.skills.map((skill: { uri: string }) => skill.uri)).toEqual([entry]);
        expect(read.result?.contents).toEqual([
          { mimeType: "text/markdown", text: SKILL_MD, uri: entry },
        ]);
      } else {
        expect(discovered.result?.capabilities.resources, label).toBeUndefined();
        expect(
          discovered.result?.capabilities.extensions?.["io.modelcontextprotocol/skills"],
          label,
        ).toBeUndefined();
        expect(listed.error?.code, label).toBe(-32_601);
        expect(read.error?.code, label).toBe(-32_601);
      }
    }
  });

  it("acknowledges subscriptions/listen with only what it serves, then closes the stream", async () => {
    const served = "skill://usage-triage/references/runbook.md";
    const entry = "skill://usage-triage/SKILL.md";
    const missing = (index: number) => `skill://usage-triage/missing-${index}.md`;
    const hundred = [served, ...Array.from({ length: 99 }, (_, index) => missing(index))];
    const rows: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
      [
        "unserved list kinds are dropped",
        { promptsListChanged: true, toolsListChanged: true },
        { toolsListChanged: true },
      ],
      [
        "only served skill files, once each",
        {
          resourceSubscriptions: [
            served,
            entry,
            served,
            missing(0),
            "skill://nope/SKILL.md",
            "skill://usage-triage",
            "skill://usage-triage/references",
            "https://example.com/x",
            "skill://usage-triage/../SKILL.md",
          ],
          resourcesListChanged: true,
        },
        { resourceSubscriptions: [served, entry], resourcesListChanged: true },
      ],
      ["nothing readable", { resourceSubscriptions: ["skill://nope/SKILL.md"] }, {}],
      [
        "exactly 100 subscriptions",
        { resourceSubscriptions: hundred },
        { resourceSubscriptions: [served] },
      ],
    ];
    const channel = toolsChannel({ skills: true });
    const listen = (notifications: Record<string, unknown>, args: RouteHandlerArgs) =>
      postHandler(channel)(modernRequest("subscriptions/listen", { notifications }), args);
    for (const [label, notifications, acknowledged] of rows) {
      const response = await listen(
        notifications,
        routeArgs({ description: skillsDescription, readSkill }),
      );
      expect(response.headers.get("content-type"), label).toContain("text/event-stream");
      const events = (await response.text())
        .split("\n")
        .filter((line) => line.startsWith("data: "))
        .map((line) => JSON.parse(line.slice("data: ".length)));
      expect(events, label).toEqual([
        expect.objectContaining({
          method: "notifications/subscriptions/acknowledged",
          params: expect.objectContaining({ notifications: acknowledged }),
        }),
      ]);
    }

    // 101 is refused as a JSON error before any skill file is read.
    const reads = vi.fn(readSkill);
    const over = await listen(
      { resourceSubscriptions: [...hundred, missing(99)] },
      routeArgs({ description: skillsDescription, readSkill: reads }),
    );
    expect(over.headers.get("content-type")).toContain("application/json");
    expect(await over.json()).toMatchObject({ error: { code: -32_602 }, id: 1 });
    expect(reads).not.toHaveBeenCalled();
  });
});
