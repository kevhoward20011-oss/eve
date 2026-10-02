import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { Client, SdkHttpError, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { jsonSchema } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { ContextContainer, contextStorage } from "../../src/context/container.js";
import { AuthKey, CapabilitiesKey, SessionIdKey, SessionKey } from "../../src/context/keys.js";
import { ConnectionRegistryKey } from "../../src/context/providers/connection-key.js";
import { CONNECTION_EXECUTE_TOOL_NAME as EXECUTE } from "../../src/execution/tools/connection-target.js";
import { resolveConnectionTools } from "../../src/execution/tools/connection-tools.js";
import { createToolLoopHarness } from "../../src/harness/tool-loop.js";
import type { HarnessSession, StepInput, StepResult } from "../../src/harness/types.js";
import { buildApplication } from "../../src/internal/nitro/host/build-application.js";
import { startProductionServer } from "../../src/internal/nitro/host/start-production-server.js";
import type { ProductionServerHandle } from "../../src/internal/nitro/host/types.js";
import {
  textStreamResult,
  toolCallStreamResult,
} from "../../src/internal/testing/approval-resume.js";
import { materializeScenarioApp } from "../../src/internal/testing/scenario-app.js";
import { McpConnectionClient } from "../../src/runtime/connections/mcp-client.js";
import type { ConnectionRegistry } from "../../src/runtime/connections/registry-types.js";
import type { ResolvedConnectionDefinition } from "../../src/runtime/types.js";
import type { InputRequest } from "../../src/shared/input.js";
import type { ToolContext } from "../../src/tools/definition.js";

// What the agent-mcp e2e evals cannot reach: two processes sharing only the
// secret, provider sign-in between agents, both client eras, the build output.

const MODERN = "2026-07-28";
const SKILL_MD = "---\nname: usage-triage\ndescription: Triage a usage spike.\n---\n\n# Triage\n";
const DESCRIPTOR_FILES: Record<string, string> = {
  "agent/agent.ts": 'export default { model: "openai/gpt-5.4" };\n',
  "agent/instructions.md": "Publish ops tools over MCP.\n",
  "agent/channels/mcp.ts": `import { mcpChannel } from "eve/channels/mcp";
export default mcpChannel({
  tools: true,
  skills: true,
  auth: (request) => {
    const principalId = request.headers.get("x-test-principal");
    return principalId === null ? null : { attributes: {}, authenticator: "scenario", principalId, principalType: principalId === "router" ? "service" : "user" };
  },
  trustedForwarders: (forwarder) => forwarder.principalId === "router",
});
`,
  "agent/tools/deploy.ts": `import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";
export default defineTool({
  approval: always(),
  description: "Deploy an environment.",
  inputSchema: z.object({ env: z.string() }),
  execute: async (input) => ({ deployed: input.env }),
});
`,
  // Provider-run sign-in: the grant "exists" once the test creates the flag file.
  "agent/tools/issues.ts": `import { appendFileSync, existsSync } from "node:fs";
import { ConnectionAuthorizationRequiredError } from "eve/connections";
import { defineTool } from "eve/tools";
import { z } from "zod";
export default defineTool({
  description: "List Linear issues.",
  inputSchema: z.object({ flag: z.string() }),
  async execute(input, ctx) {
    const dir = process.env.SCENARIO_DIR + "/";
    await ctx.getToken({
      completeAuthorization: async () => ({ token: "fresh" }), displayName: "Linear", principalType: "user",
      async getToken() {
        if (!existsSync(dir + input.flag)) throw new ConnectionAuthorizationRequiredError("linear");
        return { token: "signed-in" };
      },
      startAuthorization: async () => ({ challenge: { url: "https://idp.example/authorize" } }),
    }, { authKey: "linear" });
    const caller = ctx.session.auth.current?.principalId ?? "anonymous";
    appendFileSync(dir + "runs.log", caller + ":" + input.flag + "\\n");
    return { caller, count: 3 };
  },
});
`,
  "agent/skills/usage-triage/SKILL.md": SKILL_MD,
  "agent/skills/usage-triage/references/runbook.md": "# Runbook\n",
};

let appRoot = "";
let cleanupApp: (() => Promise<void>) | undefined;
const servers: ProductionServerHandle[] = [];

beforeAll(async () => {
  const app = await materializeScenarioApp({
    dependencies: { zod: "4.5.4" },
    files: DESCRIPTOR_FILES,
    installDependencies: true,
    name: "mcp-channel",
  });
  appRoot = app.appRoot;
  cleanupApp = () => app.cleanup();
  await buildApplication(appRoot, { skipSandboxPrewarm: true });
  await writeFile(join(appRoot, "runs.log"), "");
  // The server processes inherit this worker's environment.
  vi.stubEnv("EVE_DEV", undefined);
  vi.stubEnv("EVE_MCP_REQUEST_STATE_SECRET", "scenario-request-state-secret-0123456789");
  vi.stubEnv("SCENARIO_DIR", appRoot);
  // One at a time: both share the app's local workflow world, and two
  // processes initializing it at once can read its version file half-written.
  for (let index = 0; index < 2; index += 1) {
    servers.push(await startProductionServer(appRoot, { host: "127.0.0.1", port: 0 }));
  }
}, 360_000);

afterAll(async () => {
  await Promise.all(servers.map((server) => server.close()));
  vi.unstubAllEnvs();
  await cleanupApp?.();
}, 60_000);

const mcpUrl = (index = 0) => new URL("/eve/v1/mcp", servers[index]!.url).href;
const runs = async () => (await readFile(join(appRoot, "runs.log"), "utf8")).split("\n");

async function post(index: number, method: string, params: Record<string, unknown>) {
  const _meta = {
    ...(params._meta as object),
    "io.modelcontextprotocol/clientCapabilities": {
      elicitation: { form: {}, url: {} },
      extensions: { "dev.eve/tool-sessions": {} },
    },
    "io.modelcontextprotocol/clientInfo": { name: "eve-scenario", version: "0.0.0" },
    "io.modelcontextprotocol/protocolVersion": MODERN,
  };
  return await fetch(mcpUrl(index), {
    body: JSON.stringify({ id: 1, jsonrpc: "2.0", method, params: { ...params, _meta } }),
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "mcp-method": method,
      "mcp-protocol-version": MODERN,
      ...(typeof params.name === "string" && { "mcp-name": params.name }),
      "x-test-principal": "alice",
    },
    method: "POST",
  });
}

const sseEvents = (body: string): Record<string, any>[] =>
  body
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice("data: ".length)));

const rpcResult = async (response: Response) => {
  const body = await response.text();
  return (body.startsWith("{") ? JSON.parse(body) : sseEvents(body)[0])?.result;
};

describe("mcpChannel across two instances", () => {
  it("retries an approval on the other instance, which holds only the same env secret", async () => {
    // Keyed calls resume the key's session; unkeyed ones a one-off session.
    for (const _meta of [{ "dev.eve/tool-session": "approval-thread" }, {}]) {
      const call = { _meta, arguments: { env: "prod" }, name: "deploy" };
      const asked = await rpcResult(await post(0, "tools/call", call));
      expect(asked?.resultType).toBe("input_required");
      const approved = await post(1, "tools/call", {
        ...call,
        inputResponses: { "dev.eve/approval": { action: "accept", content: { approved: true } } },
        requestState: asked.requestState,
      });
      expect(await rpcResult(approved)).toMatchObject({
        structuredContent: { deployed: "prod" },
      });
    }
  });

  it("acknowledges subscriptions/listen and then closes the stream", async () => {
    const notifications = { toolsListChanged: true };
    const response = await post(0, "subscriptions/listen", { notifications });
    // `text()` resolving at all proves the server ended the stream.
    expect(sseEvents(await response.text())).toMatchObject([
      { method: "notifications/subscriptions/acknowledged", params: { notifications } },
    ]);
  });
});

// Agent A: eve's real tool loop and McpConnectionClient, forwarding alice as "router".
const alice = { attributes: {}, authenticator: "a2a", principalId: "alice", principalType: "user" };

function createAgentA(flag: string) {
  const definition = {
    connectionName: "ops",
    description: "Agent B's ops tools.",
    forwardPrincipal: true,
    logicalPath: "connections/ops.ts",
    sourceId: "ops",
    sourceKind: "module",
    headers: { "x-test-principal": "router" },
    protocol: "mcp",
    url: mcpUrl(),
  } as ResolvedConnectionDefinition;
  const client = new McpConnectionClient(definition);
  const registry: ConnectionRegistry = {
    dispose: async () => {},
    getClient: () => client,
    getConnectionApproval: () => undefined,
    getConnectionNames: () => ["ops"],
    getConnections: () => [definition],
  };
  const context = (sessionId: string) => {
    const ctx = new ContextContainer();
    ctx.set(AuthKey, alice);
    ctx.set(SessionIdKey, sessionId);
    ctx.set(SessionKey, {
      auth: { current: alice, initiator: null },
      sessionId,
      turn: { id: "turn-1", sequence: 1 },
    } as never);
    ctx.set(CapabilitiesKey, { requestInput: true } as never);
    ctx.set(ConnectionRegistryKey, registry);
    return ctx;
  };
  const input = JSON.stringify({ connection: "ops", input: { flag }, tool: "issues" });
  const responses = [
    toolCallStreamResult({ input, toolCallId: "call-issues", toolName: EXECUTE }),
    textStreamResult("Done."),
    textStreamResult("Done."),
  ];
  const model = new MockLanguageModelV4({
    doStream: async () => responses.shift() ?? Promise.reject(new Error("Extra model call.")),
    modelId: "a2a-model",
    provider: "eve-scenario-mock",
  });
  const execute = contextStorage.run(
    context("a2a-setup"),
    () => resolveConnectionTools()?.[EXECUTE],
  );
  if (execute === undefined) throw new Error("connection_execute is not available.");
  const tool = {
    description: "Run a tool on a connection.",
    execute: async (args: unknown, options: unknown) => {
      const { toolCallId } = options as { toolCallId: string };
      const signal = new AbortController().signal;
      return await execute.execute(
        args as never,
        { abortSignal: signal, callId: toolCallId } as ToolContext,
      );
    },
    name: EXECUTE,
  };
  const requested: InputRequest[] = [];
  const runStep = createToolLoopHarness({
    capabilities: { requestInput: true },
    handleEvent: async (event) => {
      if (event.type === "input.requested") requested.push(...event.data.requests);
    },
    resolveModel: async () => model,
    tools: new Map([[EXECUTE, { ...tool, inputSchema: jsonSchema({ type: "object" }) }]]),
  });
  const session: HarnessSession = {
    agent: {
      modelReference: { id: "a2a-model" },
      system: "You are agent A.",
      tools: [{ description: "Run a tool.", inputSchema: { type: "object" }, name: EXECUTE }],
    },
    compaction: { recentWindowSize: 10, threshold: 100_000 },
    continuationToken: `http:${flag}`,
    history: [],
    sessionId: flag,
  };
  async function deliver(current: HarnessSession, step: StepInput): Promise<StepResult> {
    const ctx = context(current.sessionId);
    let result = await contextStorage.run(ctx, () => runStep(current, step));
    for (let index = 0; index < 5 && typeof result.next === "function"; index += 1) {
      const { next, session: resumed } = result;
      result = await contextStorage.run(ctx, () => next(resumed));
    }
    return result;
  }
  const signedIn = (request: InputRequest): StepInput => ({
    attributedInputResponses: [
      { auth: alice, response: { optionId: "approve", requestId: request.requestId } },
    ],
  });
  return { deliver, requested, session, signedIn };
}

describe("an eve agent signing in to another eve agent's tool over MCP", () => {
  it("asks A's user to sign in, re-asks while unfinished, then runs B's tool as that user", async () => {
    const flag = "signin.flag";
    const agent = createAgentA(flag);
    const asked = await agent.deliver(agent.session, { message: "List my issues." });
    expect(agent.requested).toHaveLength(1);
    expect(JSON.stringify(agent.requested[0])).toContain("https://idp.example/authorize");

    // Done before the sign-in finished: B re-asks under a fresh request and nothing runs.
    const reasked = await agent.deliver(asked.session, agent.signedIn(agent.requested[0]!));
    expect(agent.requested).toHaveLength(2);
    expect(agent.requested[1]!.requestId).not.toBe(agent.requested[0]!.requestId);
    expect(await runs()).not.toContain(`alice:${flag}`);

    await writeFile(join(appRoot, flag), "");
    await agent.deliver(reasked.session, agent.signedIn(agent.requested[1]!));
    expect(await runs()).toContain(`alice:${flag}`);
  });
});

describe("a third-party MCP client against mcpChannel", () => {
  it.each([
    ["modern", MODERN],
    ["legacy", "2025-11-25"],
  ] as const)(
    "lists and calls tools, reads skills, and is refused without credentials, %s era",
    async (era, protocolVersion) => {
      const connect = async (headers: Record<string, string>) => {
        const pin = era === "modern" ? { versionNegotiation: { mode: { pin: MODERN } } } : {};
        const client = new Client({ name: "eve-scenario-interop", version: "0.0.0" }, pin);
        const transport = new StreamableHTTPClientTransport(new URL(mcpUrl()), {
          requestInit: { headers },
        });
        await client.connect(transport);
        return client;
      };
      await expect(connect({})).rejects.toSatisfy(
        (error) => error instanceof SdkHttpError && error.status === 401,
      );

      const client = await connect({ "x-test-principal": "interop" });
      try {
        expect(client.getNegotiatedProtocolVersion()).toBe(protocolVersion);
        const { tools } = await client.listTools();
        expect(tools.map((tool) => tool.name)).toEqual(
          expect.arrayContaining(["deploy", "issues"]),
        );
        // runs.log exists, so this sign-in is already done.
        const called = await client.callTool({ arguments: { flag: "runs.log" }, name: "issues" });
        expect(called).toMatchObject({ structuredContent: { caller: "interop", count: 3 } });

        const AnyResult = z.record(z.string(), z.unknown());
        const listed = await client.request({ method: "skills/list", params: {} }, AnyResult);
        expect(listed.skills).toEqual([
          expect.objectContaining({ uri: "skill://usage-triage/SKILL.md" }),
        ]);
        const entry = await client.readResource({ uri: "skill://usage-triage/SKILL.md" });
        expect(entry.contents).toEqual([expect.objectContaining({ text: SKILL_MD })]);
      } finally {
        await client.close();
      }
    },
  );
});
