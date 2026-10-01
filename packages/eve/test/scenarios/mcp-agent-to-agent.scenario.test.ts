import { spawn, type ChildProcessByStdio } from "node:child_process";
import { once } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import type { Readable } from "node:stream";

import { jsonSchema, type LanguageModel } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { SessionAuthContext } from "../../src/channel/types.js";
import { ContextContainer, contextStorage } from "../../src/context/container.js";
import type { ContextKey } from "../../src/context/key.js";
import { AuthKey, CapabilitiesKey, SessionIdKey, SessionKey } from "../../src/context/keys.js";
import { ConnectionRegistryKey } from "../../src/context/providers/connection-key.js";
import { resolveConnectionTools } from "../../src/execution/tools/connection-tools.js";
import { CONNECTION_EXECUTE_TOOL_NAME } from "../../src/execution/tools/connection-target.js";
import type { HarnessToolDefinition } from "../../src/harness/execute-tool.js";
import { getPendingRemoteInputs } from "../../src/harness/remote-input.js";
import { createToolLoopHarness } from "../../src/harness/tool-loop.js";
import type { HarnessSession, StepInput, StepResult } from "../../src/harness/types.js";
import { buildApplication } from "../../src/internal/nitro/host/build-application.js";
import {
  textStreamResult,
  toolCallStreamResult,
} from "../../src/internal/testing/approval-resume.js";
import { materializeScenarioApp } from "../../src/internal/testing/scenario-app.js";
import { McpConnectionClient } from "../../src/runtime/connections/mcp-client.js";
import type { ConnectionRegistry } from "../../src/runtime/connections/registry-types.js";
import type { ResolvedConnectionDefinition } from "../../src/runtime/types.js";
import type { InputRequest } from "../../src/shared/input.js";
import type { Approval } from "../../src/approval/definition.js";
import { always } from "../../src/tools/approval/policies.js";
import type { ToolContext } from "../../src/tools/definition.js";

/**
 * Agent-to-agent over MCP, end to end. Agent B is a real production build
 * serving `mcpChannel` over HTTP. Agent A is eve's real tool loop (with a
 * scripted model) whose `connection_execute` tool goes through the real
 * `McpConnectionClient` with `forwardPrincipal: true`, authenticating to B
 * as the trusted forwarder `router`.
 *
 * Covers the phase-1 client acceptance list: B's approval surfaces to A's
 * user as `input.requested` and runs as that user after they approve; a
 * second person in the thread cannot answer it; a run that cannot ask
 * (scheduled) fails cleanly; B's provider-run sign-in surfaces to A's user and
 * is asked again until it has finished; one B tool session backs each A
 * conversation and caller; and a skill read round-trips through A's
 * connection.
 */

const SETUP_TIMEOUT_MS = 360_000;
const OPERATION_TIMEOUT_MS = 60_000;
const REQUEST_STATE_SECRET = "a2a-scenario-request-state-secret-0123456789";
const CONNECTION = "ops";

const SKILL_MD = [
  "---",
  "name: deploy-runbook",
  "description: How to deploy an environment safely.",
  "---",
  "",
  "# Deploy runbook",
  "",
  "Call `deploy` with the environment name.",
  "",
].join("\n");

const AGENT_B_FILES = {
  "agent/agent.ts": 'export default { model: "openai/gpt-5.4" };\n',
  "agent/instructions.md": "Publish ops tools over MCP.\n",
  "agent/channels/mcp.ts": `import { mcpChannel } from "eve/channels/mcp";

export default mcpChannel({
  auth: (request) => {
    const principalId = request.headers.get("x-test-principal");
    if (principalId === null) return null;
    return {
      attributes: {},
      authenticator: "scenario",
      principalId,
      principalType: principalId === "router" ? "service" : "user",
    };
  },
  trustedForwarders: (forwarder) => forwarder.principalId === "router",
});
`,
  "agent/tools/deploy.ts": `import { appendFile } from "node:fs/promises";
import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";

export default defineTool({
  approval: always(),
  description: "Deploy an environment.",
  inputSchema: z.object({ env: z.string() }),
  async execute(input, ctx) {
    const caller = ctx.session.auth.current?.principalId ?? "anonymous";
    await appendFile(process.env.SCENARIO_DEPLOY_LOG, caller + ":" + input.env + "\\n");
    return { caller, deployed: input.env };
  },
});
`,
  "agent/tools/issues.ts": `import { existsSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { ConnectionAuthorizationRequiredError } from "eve/connections";
import { defineTool } from "eve/tools";
import { z } from "zod";

// Provider-run sign-in: the grant "exists" once the test creates the flag file.
function linear(flag) {
  return {
    async completeAuthorization() {
      return { token: "fresh" };
    },
    displayName: "Linear",
    async getToken() {
      if (!existsSync(join(process.env.SCENARIO_FLAG_DIR, flag))) {
        throw new ConnectionAuthorizationRequiredError("linear");
      }
      return { token: "signed-in" };
    },
    principalType: "user",
    async startAuthorization() {
      return { challenge: { url: "https://idp.example/authorize" } };
    },
  };
}

export default defineTool({
  description: "List Linear issues.",
  inputSchema: z.object({ flag: z.string() }),
  async execute(input, ctx) {
    await ctx.getToken(linear(input.flag), { authKey: "linear" });
    const caller = ctx.session.auth.current?.principalId ?? "anonymous";
    await appendFile(process.env.SCENARIO_DEPLOY_LOG, caller + ":issues:" + input.flag + "\\n");
    return { caller, count: 3 };
  },
});
`,
  "agent/tools/whereami.ts": `import { defineTool } from "eve/tools";
import { z } from "zod";

export default defineTool({
  description: "Report the tool session this call ran in.",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    return { caller: ctx.session.auth.current?.principalId ?? null, sessionId: ctx.session.id };
  },
});
`,
  "agent/skills/deploy-runbook/SKILL.md": SKILL_MD,
};

type RunningServer = { readonly output: () => string; readonly url: string; stop(): Promise<void> };

let server: RunningServer | undefined;
let cleanup: (() => Promise<void>) | undefined;
let deployLog = "";
let flagDir = "";

function principal(principalId: string): SessionAuthContext {
  return {
    attributes: {},
    authenticator: "scenario",
    issuer: "scenario",
    principalId,
    principalType: "user",
  };
}
const alice = principal("alice");
const bob = principal("bob");

describe("eve agent consuming another eve agent's tools over MCP", () => {
  beforeAll(async () => {
    const app = await materializeScenarioApp({
      dependencies: { zod: "4.5.4" },
      files: AGENT_B_FILES,
      installDependencies: true,
      name: "mcp-a2a-provider",
    });
    cleanup = () => app.cleanup();
    await buildApplication(app.appRoot, { skipSandboxPrewarm: true });
    deployLog = join(app.appRoot, "deploys.log");
    await writeFile(deployLog, "");
    flagDir = app.appRoot;
    server = await startServer(app.appRoot, deployLog);
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await server?.stop();
    await cleanup?.();
  }, 60_000);

  it(
    "asks A's user through input.requested, then runs B's tool as that user",
    async () => {
      const agent = createAgentA();
      const sessionId = "a2a-approve";
      const parked = await agent.deliver(alice, createSession(sessionId), {
        message: "Deploy prod.",
      });

      expect(agent.requested).toHaveLength(1);
      const request = agent.requested[0]!;
      expect(request).toMatchObject({
        action: { kind: "tool-call", toolName: CONNECTION_EXECUTE_TOOL_NAME },
        kind: "tool-approval",
      });
      expect(await deploys()).toEqual([]);
      // B's signed requestState is journaled for the retry but never reaches
      // the model, the event stream, or the transcript.
      const pending = getPendingRemoteInputs(parked.session.state);
      expect(pending).toHaveLength(1);
      const stateJson = JSON.stringify(parked.session.state);
      const requestState = /"requestState":"([^"]+)"/u.exec(stateJson)?.[1];
      expect(requestState).toBeDefined();
      expect(JSON.stringify(agent.model.doStreamCalls.map((call) => call.prompt))).not.toContain(
        requestState,
      );
      expect(JSON.stringify(agent.events)).not.toContain(requestState);
      expect(JSON.stringify(parked.session.history)).not.toContain(requestState);

      const done = await agent.deliver(alice, parked.session, answer(alice, request, "approve"));

      expect(await deploys()).toEqual(["alice:prod"]);
      expect(getPendingRemoteInputs(done.session.state)).toEqual([]);
      expect(agent.lastToolOutput()).toMatchObject({
        output: { value: { caller: "alice", deployed: "prod" } },
      });
      expect(done.session.history.at(-1)).toMatchObject({ role: "assistant" });
    },
    OPERATION_TIMEOUT_MS * 2,
  );

  it(
    "refuses an answer from a second person in the thread and does not run the tool",
    async () => {
      const before = await deploys();
      const agent = createAgentA({ followUpText: "Bob cannot approve that." });
      const parked = await agent.deliver(alice, createSession("a2a-bob"), {
        message: "Deploy prod.",
      });
      const request = agent.requested[0]!;

      const refused = await agent.deliver(bob, parked.session, answer(bob, request, "approve"));

      expect(await deploys()).toEqual(before);
      // The request stays Alice's: still pending, still answerable by her.
      expect(getPendingRemoteInputs(refused.session.state)).toMatchObject([
        { responder: { principalId: "alice" } },
      ]);

      // Alice can still answer it, and B then runs as Alice.
      await agent.deliver(alice, refused.session, answer(alice, request, "approve"));
      expect(await deploys()).toEqual([...before, "alice:prod"]);
    },
    OPERATION_TIMEOUT_MS * 2,
  );

  it(
    "retries B's approval when A's connection has a local policy that does not apply",
    async () => {
      const before = await deploys();
      const agent = createAgentA({ localApproval: () => "not-applicable" });
      const parked = await agent.deliver(alice, createSession("a2a-local-na"), {
        message: "Deploy prod.",
      });
      expect(agent.requested).toHaveLength(1);
      expect(await deploys()).toEqual(before);

      await agent.deliver(alice, parked.session, answer(alice, agent.requested[0]!, "approve"));

      expect(await deploys()).toEqual([...before, "alice:prod"]);
      expect(agent.lastToolOutput()).toMatchObject({
        output: { value: { caller: "alice", deployed: "prod" } },
      });
    },
    OPERATION_TIMEOUT_MS * 2,
  );

  it(
    "runs B's tool after a local approval followed by B's own approval",
    async () => {
      const before = await deploys();
      const agent = createAgentA({ localApproval: always() });
      const first = await agent.deliver(alice, createSession("a2a-local-always"), {
        message: "Deploy prod.",
      });
      // A's own approval comes first; B hasn't been called.
      expect(agent.requested).toHaveLength(1);
      expect(await deploys()).toEqual(before);

      const second = await agent.deliver(
        alice,
        first.session,
        answer(alice, agent.requested[0]!, "approve"),
      );
      // Then B asks; still nothing has run.
      expect(agent.requested).toHaveLength(2);
      expect(agent.requested[1]!.requestId).not.toBe(agent.requested[0]!.requestId);
      expect(await deploys()).toEqual(before);

      await agent.deliver(alice, second.session, answer(alice, agent.requested[1]!, "approve"));

      expect(await deploys()).toEqual([...before, "alice:prod"]);
      expect(agent.lastToolOutput()).toMatchObject({
        output: { value: { caller: "alice", deployed: "prod" } },
      });
    },
    OPERATION_TIMEOUT_MS * 2,
  );

  it(
    "fails a run that cannot ask anyone (scheduled) without retrying or running",
    async () => {
      const before = await deploys();
      const agent = createAgentA({ requestInput: false });
      const result = await agent.deliver(null, createSession("a2a-scheduled"), {
        message: "Nightly deploy of prod.",
      });

      expect(agent.requested).toEqual([]);
      expect(getPendingRemoteInputs(result.session.state)).toEqual([]);
      expect(await deploys()).toEqual(before);
      const output = JSON.stringify(agent.lastToolOutput());
      expect(output).toMatch(/approval|input|ask/iu);
      expect(result.session.history.at(-1)).toMatchObject({ role: "assistant" });
    },
    OPERATION_TIMEOUT_MS * 2,
  );

  it(
    "reads B's skill through A's connection",
    async () => {
      const client = new McpConnectionClient(connectionDefinition());
      try {
        const read = await contextStorage.run(createContext(alice, "a2a-skill", true), async () => {
          const mcp = await client.connect();
          return await mcp.readResource({ uri: "skill://deploy-runbook/SKILL.md" });
        });
        expect(read.contents).toEqual([
          expect.objectContaining({ text: SKILL_MD, uri: "skill://deploy-runbook/SKILL.md" }),
        ]);
      } finally {
        await client.close();
      }
    },
    OPERATION_TIMEOUT_MS,
  );

  it(
    "surfaces B's sign-in to A's user and runs the tool once they finish signing in",
    async () => {
      const before = await deploys();
      const flag = "signin-retry.flag";
      const agent = createAgentA({ call: { input: { flag }, tool: "issues" } });
      const parked = await agent.deliver(alice, createSession("a2a-signin"), {
        message: "List my issues.",
      });

      expect(agent.requested).toHaveLength(1);
      expect(JSON.stringify(agent.requested[0])).toContain("https://idp.example/authorize");
      expect(await deploys()).toEqual(before);

      // The person signs in at the provider, then tells A they are done.
      await writeFile(join(flagDir, flag), "");
      const done = await agent.deliver(
        alice,
        parked.session,
        answer(alice, agent.requested[0]!, "approve"),
      );

      expect(await deploys()).toEqual([...before, `alice:issues:${flag}`]);
      expect(getPendingRemoteInputs(done.session.state)).toEqual([]);
      expect(agent.lastToolOutput()).toMatchObject({
        output: { value: { caller: "alice", count: 3 } },
      });
    },
    OPERATION_TIMEOUT_MS * 2,
  );

  it(
    "asks again when A's user says they are done before the sign-in finished",
    async () => {
      const before = await deploys();
      const flag = "signin-reask.flag";
      const agent = createAgentA({ call: { input: { flag }, tool: "issues" } });
      const first = await agent.deliver(alice, createSession("a2a-signin-reask"), {
        message: "List my issues.",
      });
      expect(agent.requested).toHaveLength(1);

      // Answered without signing in: B re-asks with a fresh requestState and
      // nothing runs.
      const second = await agent.deliver(
        alice,
        first.session,
        answer(alice, agent.requested[0]!, "approve"),
      );
      expect(agent.requested).toHaveLength(2);
      expect(agent.requested[1]!.requestId).not.toBe(agent.requested[0]!.requestId);
      expect(JSON.stringify(agent.requested[1])).toContain("https://idp.example/authorize");
      expect(getPendingRemoteInputs(second.session.state)).toHaveLength(1);
      expect(await deploys()).toEqual(before);

      await writeFile(join(flagDir, flag), "");
      await agent.deliver(alice, second.session, answer(alice, agent.requested[1]!, "approve"));
      expect(await deploys()).toEqual([...before, `alice:issues:${flag}`]);
    },
    OPERATION_TIMEOUT_MS * 2,
  );

  it(
    "keeps one B tool session per A conversation and caller",
    async () => {
      const call = async (auth: SessionAuthContext, conversation: string) => {
        const client = new McpConnectionClient(connectionDefinition());
        try {
          return await contextStorage.run(createContext(auth, conversation, true), async () => {
            const mcp = await client.connect();
            const result = await mcp.callTool({ arguments: {}, name: "whereami" });
            return (result as { structuredContent?: { caller: string; sessionId: string } })
              .structuredContent!;
          });
        } finally {
          await client.close();
        }
      };

      const first = await call(alice, "a2a-session-1");
      const again = await call(alice, "a2a-session-1");
      const otherConversation = await call(alice, "a2a-session-2");
      const otherCaller = await call(bob, "a2a-session-1");

      expect(first).toMatchObject({ caller: "alice", sessionId: expect.stringMatching(/^ts_/u) });
      // Same conversation and caller, fresh client and connection: same session.
      expect(again.sessionId).toBe(first.sessionId);
      expect(otherConversation.sessionId).not.toBe(first.sessionId);
      // The key alone never reaches another caller's session.
      expect(otherCaller).toMatchObject({ caller: "bob" });
      expect(otherCaller.sessionId).not.toBe(first.sessionId);
    },
    OPERATION_TIMEOUT_MS,
  );
});

/** Keys each delivery sets itself; everything else is carried between turns. */
const TURN_KEYS = new Set([
  AuthKey.name,
  CapabilitiesKey.name,
  ConnectionRegistryKey.name,
  SessionIdKey.name,
  SessionKey.name,
]);

function connectionDefinition(): ResolvedConnectionDefinition {
  if (server === undefined) throw new Error("Agent B did not start.");
  return {
    connectionName: CONNECTION,
    description: "Agent B's ops tools.",
    forwardPrincipal: true,
    headers: { "x-test-principal": "router" },
    logicalPath: `connections/${CONNECTION}.ts`,
    protocol: "mcp",
    sourceId: CONNECTION,
    sourceKind: "module",
    url: `${server.url}/eve/v1/mcp`,
  } as ResolvedConnectionDefinition;
}

function createContext(
  auth: SessionAuthContext | null,
  sessionId: string,
  requestInput: boolean,
  registry?: ConnectionRegistry,
): ContextContainer {
  const ctx = new ContextContainer();
  ctx.set(AuthKey, auth);
  ctx.set(SessionIdKey, sessionId);
  ctx.set(SessionKey, {
    auth: { current: auth, initiator: null },
    sessionId,
    turn: { id: "turn-1", sequence: 1 },
  } as never);
  ctx.set(CapabilitiesKey, { requestInput } as never);
  if (registry !== undefined) ctx.set(ConnectionRegistryKey, registry);
  return ctx;
}

function createSession(sessionId: string): HarnessSession {
  return {
    agent: {
      modelReference: { id: "a2a-model" },
      system: "You are agent A.",
      tools: [
        {
          description: "Run a tool on a connection.",
          inputSchema: { type: "object" },
          name: CONNECTION_EXECUTE_TOOL_NAME,
        },
      ],
    },
    compaction: { recentWindowSize: 10, threshold: 100_000 },
    continuationToken: `http:${sessionId}`,
    history: [],
    sessionId,
  };
}

function createAgentA(
  options: {
    call?: { readonly input: Readonly<Record<string, unknown>>; readonly tool: string };
    followUpText?: string;
    localApproval?: Approval;
    requestInput?: boolean;
  } = {},
) {
  const requestInput = options.requestInput ?? true;
  const call = options.call ?? { input: { env: "prod" }, tool: "deploy" };
  const client = new McpConnectionClient(connectionDefinition());
  const registry: ConnectionRegistry = {
    dispose: async () => {},
    getClient: () => client,
    getConnectionApproval: () => options.localApproval,
    getConnectionNames: () => [CONNECTION],
    getConnections: () => [connectionDefinition()],
  };
  const responses = [
    toolCallStreamResult({
      input: JSON.stringify({
        connection: CONNECTION,
        input: call.input,
        tool: call.tool,
      }),
      toolCallId: "call-deploy",
      toolName: CONNECTION_EXECUTE_TOOL_NAME,
    }),
    textStreamResult(options.followUpText ?? "Done."),
    textStreamResult("Done."),
  ];
  const model = new MockLanguageModelV4({
    doStream: async () => {
      const next = responses.shift();
      if (next === undefined) throw new Error("Unexpected extra model call.");
      return next;
    },
    modelId: "a2a-model",
    provider: "eve-scenario-mock",
  });
  // The real generated `connection_execute`, including its approval
  // callbacks when the connection has a local policy.
  const connectionTool = contextStorage.run(
    createContext(null, "a2a-setup", requestInput, registry),
    () => resolveConnectionTools()?.[CONNECTION_EXECUTE_TOOL_NAME],
  );
  if (connectionTool === undefined) throw new Error("connection_execute is not available.");
  const tool: { -readonly [K in keyof HarnessToolDefinition]: HarnessToolDefinition[K] } = {
    description: "Run a tool on a connection.",
    execute: async (input, execOptions) => {
      return await connectionTool.execute(
        input as never,
        {
          abortSignal: new AbortController().signal,
          callId: (execOptions as { toolCallId: string }).toolCallId,
        } as ToolContext,
      );
    },
    inputSchema: jsonSchema({ type: "object" }),
    name: CONNECTION_EXECUTE_TOOL_NAME,
  };
  if (connectionTool.approval !== undefined) tool.approval = connectionTool.approval;
  if (connectionTool.approvalKey !== undefined) tool.approvalKey = connectionTool.approvalKey;
  const events: unknown[] = [];
  const requested: InputRequest[] = [];
  const runStep = createToolLoopHarness({
    capabilities: { requestInput },
    handleEvent: async (event) => {
      events.push(event);
      if (event.type === "input.requested") requested.push(...event.data.requests);
    },
    resolveModel: async (): Promise<LanguageModel> => model,
    tools: new Map([[CONNECTION_EXECUTE_TOOL_NAME, tool]]),
  });

  let carried: (readonly [ContextKey<unknown>, unknown])[] = [];
  async function deliver(
    auth: SessionAuthContext | null,
    session: HarnessSession,
    input: StepInput,
  ): Promise<StepResult> {
    const ctx = createContext(auth, session.sessionId, requestInput, registry);
    // Durable context (such as connection approval pins) survives between
    // turns, as it does across workflow steps; re-create it JSON round-tripped.
    for (const [key, value] of carried) ctx.set(key, JSON.parse(JSON.stringify(value)));
    let result = await contextStorage.run(ctx, () => runStep(session, input));
    for (let index = 0; index < 5 && typeof result.next === "function"; index += 1) {
      const { next, session: current } = result;
      result = await contextStorage.run(ctx, () => next(current));
    }
    carried = [...ctx.entries()].filter(([key]) => !TURN_KEYS.has(key.name));
    return result;
  }

  function lastToolOutput(): unknown {
    for (const call of [...model.doStreamCalls].reverse()) {
      const last = call.prompt.at(-1);
      if (last?.role === "tool") return last.content[0];
    }
    return undefined;
  }

  return { deliver, events, lastToolOutput, model, requested };
}

function answer(
  auth: SessionAuthContext,
  request: InputRequest,
  optionId: "approve" | "cancel",
): StepInput {
  return {
    attributedInputResponses: [{ auth, response: { optionId, requestId: request.requestId } }],
  };
}

async function deploys(): Promise<string[]> {
  return (await readFile(deployLog, "utf8")).split("\n").filter((line) => line.length > 0);
}

async function freePort(): Promise<number> {
  const probe = createServer().listen(0, "127.0.0.1");
  await once(probe, "listening");
  const address = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  if (address === null || typeof address === "string") throw new Error("No port.");
  return address.port;
}

async function startServer(appRoot: string, log: string): Promise<RunningServer> {
  const port = await freePort();
  const child: ChildProcessByStdio<null, Readable, Readable> = spawn(
    process.execPath,
    [".output/server/index.mjs"],
    {
      cwd: appRoot,
      env: {
        ...process.env,
        EVE_DEV: "",
        EVE_MCP_REQUEST_STATE_SECRET: REQUEST_STATE_SECRET,
        HOST: "127.0.0.1",
        NODE_ENV: "production",
        PORT: String(port),
        SCENARIO_DEPLOY_LOG: log,
        SCENARIO_FLAG_DIR: appRoot,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => (output += chunk));
  child.stderr.on("data", (chunk: string) => (output += chunk));
  const url = `http://127.0.0.1:${port}`;
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    const force = setTimeout(() => child.kill("SIGKILL"), 10_000);
    await exited;
    clearTimeout(force);
  };
  const deadline = Date.now() + OPERATION_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Agent B exited early:\n${output}`);
    try {
      await fetch(`${url}/eve/v1/mcp`, { method: "GET", signal: AbortSignal.timeout(1000) });
      return { output: () => output, stop, url };
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  await stop();
  throw new Error(`Timed out waiting for agent B:\n${output}`);
}
