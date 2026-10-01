import { createHash } from "node:crypto";
import { access, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  Client,
  ResourceNotFoundError,
  SdkHttpError,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { jsonSchema, type LanguageModel } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { Approval } from "../../src/approval/definition.js";
import type { SessionAuthContext } from "../../src/channel/types.js";
import { ContextContainer, contextStorage } from "../../src/context/container.js";
import type { ContextKey } from "../../src/context/key.js";
import { AuthKey, CapabilitiesKey, SessionIdKey, SessionKey } from "../../src/context/keys.js";
import { ConnectionRegistryKey } from "../../src/context/providers/connection-key.js";
import { CONNECTION_EXECUTE_TOOL_NAME } from "../../src/execution/tools/connection-target.js";
import { resolveConnectionTools } from "../../src/execution/tools/connection-tools.js";
import type { HarnessToolDefinition } from "../../src/harness/execute-tool.js";
import {
  getPendingRemoteInputs,
  REMOTE_INPUT_REFUSED_FEEDBACK,
} from "../../src/harness/remote-input.js";
import { createToolLoopHarness } from "../../src/harness/tool-loop.js";
import type { HarnessSession, StepInput, StepResult } from "../../src/harness/types.js";
import { buildApplication } from "../../src/internal/nitro/host/build-application.js";
import { startProductionServer } from "../../src/internal/nitro/host/start-production-server.js";
import type { ProductionServerHandle } from "../../src/internal/nitro/host/types.js";
import {
  textStreamResult,
  toolCallStreamResult,
} from "../../src/internal/testing/approval-resume.js";
import {
  materializeScenarioApp,
  type ScenarioAppDescriptor,
} from "../../src/internal/testing/scenario-app.js";
import { McpConnectionClient } from "../../src/runtime/connections/mcp-client.js";
import type { ConnectionRegistry } from "../../src/runtime/connections/registry-types.js";
import type { ResolvedConnectionDefinition } from "../../src/runtime/types.js";
import type { InputRequest } from "../../src/shared/input.js";
import type { ToolContext } from "../../src/tools/definition.js";
import { always } from "../../src/tools/approval/policies.js";

/**
 * `mcpChannel` end to end: one production build served by two processes that
 * share only EVE_MCP_REQUEST_STATE_SECRET.
 *
 * - Requests minted by one instance retry on the other.
 * - Another eve agent consumes it through the real `McpConnectionClient`
 *   (approval, sign-in, scheduled runs, tool sessions).
 * - A third-party client (`@modelcontextprotocol/client`) calls tools and reads
 *   skills in both protocol eras, byte for byte from Nitro server assets.
 */

const SETUP_TIMEOUT_MS = 360_000;
const OPERATION_TIMEOUT_MS = 60_000;
const MODERN_PROTOCOL_VERSION = "2026-07-28";
const LEGACY_PROTOCOL_VERSION = "2025-11-25";
const CONNECTION = "ops";

const RUNBOOK_SKILL_MD = [
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

const TRIAGE_SKILL_MD = [
  "---",
  "name: usage-triage",
  "description: Triage an account's usage spike with query_usage.",
  "license: Apache-2.0",
  "metadata:",
  '  owner: "billing"',
  "---",
  "",
  "# Usage triage",
  "",
  "Call `query_usage`, then follow [the runbook](references/runbook.md).",
  "",
].join("\n");

const LOWER_SKILL_MD = "---\nname: lower\ndescription: Lower-case entry.\n---\n\n# Lower\n";

/**
 * Files Nitro would alter if it inlined them under their own names: a PNG
 * (NUL and non-UTF-8 bytes), an empty text file (dropped by Nitro's
 * `r.default || r`), text starting with `base64:` (decoded by unstorage), and
 * a text-typed file that is not valid UTF-8. Descriptors hold strings only,
 * so these are written next to the descriptor's files before the build.
 */
const TRIAGE_BYTE_FILES: Readonly<Record<string, Buffer>> = {
  "assets/logo.png": Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    "base64",
  ),
  "references/b64.txt": Buffer.from("base64:SGVsbG8="),
  "references/empty.md": Buffer.alloc(0),
  "references/latin1.md": Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]),
};

const TRIAGE_FILES: Readonly<Record<string, Buffer>> = {
  ...TRIAGE_BYTE_FILES,
  "SKILL.md": Buffer.from(TRIAGE_SKILL_MD),
  "references/deep/api.md": Buffer.from("nested api\n"),
  "references/runbook.md": Buffer.from("# Runbook\n\nCheck the top caller.\n"),
};

const DESCRIPTOR: ScenarioAppDescriptor = {
  dependencies: { zod: "4.5.4" },
  files: {
    "agent/agent.ts": 'export default { model: "openai/gpt-5.4" };\n',
    "agent/instructions.md": "Publish ops tools over MCP.\n",
    "agent/channels/mcp.ts": `import { mcpChannel } from "eve/channels/mcp";

export default mcpChannel({
  tools: true,
  skills: true,
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
    "agent/tools/query_usage.ts": `import { defineTool } from "eve/tools";

export default defineTool({
  description: "Usage for one account over a window.",
  inputSchema: {
    type: "object",
    properties: {
      account: { type: "string" },
      window: { type: "string", enum: ["7d", "30d"] },
    },
    required: ["account", "window"],
    additionalProperties: false,
  },
  async execute({ account, window }) {
    return { account, window, requests: 1234 };
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
    "agent/skills/deploy-runbook/SKILL.md": RUNBOOK_SKILL_MD,
    "agent/skills/lower/skill.MD": LOWER_SKILL_MD,
  },
  installDependencies: true,
  name: "mcp-channel",
};

let appRoot = "";
let cleanupApp: (() => Promise<void>) | undefined;
let first: ProductionServerHandle | undefined;
let second: ProductionServerHandle | undefined;
let deployLog = "";

beforeAll(async () => {
  const app = await materializeScenarioApp(DESCRIPTOR);
  appRoot = app.appRoot;
  cleanupApp = () => app.cleanup();
  for (const [path, bytes] of Object.entries(TRIAGE_FILES)) {
    const target = join(appRoot, "agent/skills/usage-triage", path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes);
  }
  await buildApplication(appRoot, { skipSandboxPrewarm: true });
  deployLog = join(appRoot, "deploys.log");
  await writeFile(deployLog, "");

  // The server processes inherit this worker's environment.
  vi.stubEnv("EVE_DEV", undefined);
  vi.stubEnv("EVE_MCP_REQUEST_STATE_SECRET", "scenario-request-state-secret-0123456789");
  vi.stubEnv("SCENARIO_DEPLOY_LOG", deployLog);
  vi.stubEnv("SCENARIO_FLAG_DIR", appRoot);
  // One at a time: both share the app's local workflow world, and two
  // processes initializing it at once can read its version file half-written.
  first = await startProductionServer(appRoot, { host: "127.0.0.1", port: 0 });
  second = await startProductionServer(appRoot, { host: "127.0.0.1", port: 0 });
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  await Promise.all([first?.close(), second?.close()]);
  vi.unstubAllEnvs();
  await cleanupApp?.();
}, 60_000);

function mcpUrl(which: 1 | 2 = 1): string {
  const server = which === 1 ? first : second;
  if (server === undefined) throw new Error("Scenario servers did not start.");
  return new URL("/eve/v1/mcp", server.url).href;
}

async function deploys(): Promise<string[]> {
  return (await readFile(deployLog, "utf8")).split("\n").filter((line) => line.length > 0);
}

// ---------- Multi-instance HTTP ----------

type Json = Record<string, any>;

interface RawCallOptions {
  readonly inputResponses?: Json;
  readonly meta?: Json;
  readonly requestState?: unknown;
}

describe("mcpChannel across two instances", () => {
  it("retries an approval on the other instance, which holds only the same env secret", async () => {
    // Keyed calls resume the key's session; unkeyed ones a one-off session.
    for (const meta of [{ "dev.eve/tool-session": "approval-thread" }, undefined]) {
      const label = meta === undefined ? "one-off" : "keyed";
      const asked = await rawCallTool(1, "deploy", { env: label }, { meta });
      expect(asked.result?.resultType, label).toBe("input_required");

      const approved = await rawCallTool(
        2,
        "deploy",
        { env: label },
        {
          inputResponses: { "dev.eve/approval": { action: "accept", content: { approved: true } } },
          meta,
          requestState: asked.result!.requestState,
        },
      );
      expect(approved.result, label).toMatchObject({ structuredContent: { deployed: label } });
    }
  });

  it("acknowledges subscriptions/listen and then closes the stream", async () => {
    const response = await mcpFetch(1, "subscriptions/listen", {
      notifications: { toolsListChanged: true },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    // `text()` resolving at all proves the server ended the stream.
    expect(sseEvents(await response.text())).toEqual([
      expect.objectContaining({
        method: "notifications/subscriptions/acknowledged",
        params: expect.objectContaining({ notifications: { toolsListChanged: true } }),
      }),
    ]);
  });
});

async function rawCallTool(
  which: 1 | 2,
  name: string,
  args: Json,
  options: RawCallOptions,
): Promise<{ readonly error?: Json; readonly result?: Json }> {
  const params: Json = { arguments: args, name };
  if (options.inputResponses !== undefined) params.inputResponses = options.inputResponses;
  if (options.requestState !== undefined) params.requestState = options.requestState;
  const response = await mcpFetch(which, "tools/call", params, options);
  const body = await response.text();
  if (!response.ok) throw new Error(`MCP HTTP ${response.status}: ${body}`);
  if (!response.headers.get("content-type")?.includes("text/event-stream")) {
    return JSON.parse(body) as Json;
  }
  const [event] = sseEvents(body);
  if (event === undefined) throw new Error("MCP response did not contain an SSE data event.");
  return event;
}

function sseEvents(body: string): Json[] {
  return body
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice("data: ".length)) as Json);
}

async function mcpFetch(
  which: 1 | 2,
  method: string,
  params: Json,
  options: RawCallOptions = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
    "mcp-method": method,
    "mcp-protocol-version": MODERN_PROTOCOL_VERSION,
    "x-test-principal": "alice",
  };
  if (typeof params.name === "string") headers["mcp-name"] = params.name;
  return await fetch(mcpUrl(which), {
    body: JSON.stringify({
      id: 1,
      jsonrpc: "2.0",
      method,
      params: {
        ...params,
        _meta: {
          ...options.meta,
          "io.modelcontextprotocol/clientCapabilities": {
            elicitation: { form: {}, url: {} },
            extensions: { "dev.eve/tool-sessions": {} },
          },
          "io.modelcontextprotocol/clientInfo": { name: "eve-scenario", version: "0.0.0" },
          "io.modelcontextprotocol/protocolVersion": MODERN_PROTOCOL_VERSION,
        },
      },
    }),
    headers,
    method: "POST",
    signal: AbortSignal.timeout(OPERATION_TIMEOUT_MS),
  });
}

// ---------- Agent to agent ----------

/**
 * Agent A is eve's real tool loop (with a scripted model) whose
 * `connection_execute` tool goes through the real `McpConnectionClient` with
 * `forwardPrincipal: true`, authenticating to B (the built app) as the
 * trusted forwarder `router`.
 */
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
  it(
    "asks A's user through input.requested, then runs B's tool as that user",
    async () => {
      const before = await deploys();
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
      expect(await deploys()).toEqual(before);
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

      expect(await deploys()).toEqual([...before, "alice:prod"]);
      expect(getPendingRemoteInputs(done.session.state)).toEqual([]);
      expect(agent.lastToolOutput()).toMatchObject({
        output: { value: { caller: "alice", deployed: "prod" } },
      });
      expect(done.session.history.at(-1)).toMatchObject({ role: "assistant" });
      // Nor after the retry that echoed it to B.
      expect(JSON.stringify(agent.model.doStreamCalls.map((call) => call.prompt))).not.toContain(
        requestState,
      );
      expect(JSON.stringify(agent.events)).not.toContain(requestState);
      expect(JSON.stringify(done.session)).not.toContain(requestState);
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
      expect(agent.events).toContainEqual(
        expect.objectContaining({
          data: expect.objectContaining({ message: REMOTE_INPUT_REFUSED_FEEDBACK }),
          type: "message.completed",
        }),
      );
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
      const firstTurn = await agent.deliver(alice, createSession("a2a-local-always"), {
        message: "Deploy prod.",
      });
      // A's own approval comes first; B hasn't been called.
      expect(agent.requested).toHaveLength(1);
      expect(await deploys()).toEqual(before);

      const secondTurn = await agent.deliver(
        alice,
        firstTurn.session,
        answer(alice, agent.requested[0]!, "approve"),
      );
      // Then B asks; still nothing has run.
      expect(agent.requested).toHaveLength(2);
      expect(agent.requested[1]!.requestId).not.toBe(agent.requested[0]!.requestId);
      expect(await deploys()).toEqual(before);

      await agent.deliver(alice, secondTurn.session, answer(alice, agent.requested[1]!, "approve"));

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
      const fetchSpy = vi.spyOn(globalThis, "fetch");
      let result: StepResult;
      let toolCalls: unknown[];
      try {
        result = await agent.deliver(null, createSession("a2a-scheduled"), {
          message: "Nightly deploy of prod.",
        });
      } finally {
        toolCalls = fetchSpy.mock.calls.filter(([, init]) =>
          String(init?.body).includes('"method":"tools/call"'),
        );
        fetchSpy.mockRestore();
      }

      // B was asked once and answered input_required; A neither retried nor asked anyone.
      expect(toolCalls).toHaveLength(1);
      expect(agent.requested).toEqual([]);
      expect(getPendingRemoteInputs(result.session.state)).toEqual([]);
      expect(await deploys()).toEqual(before);
      expect(agent.lastToolOutput()).toMatchObject({
        output: {
          value: expect.stringContaining(
            "ops__deploy needs the user to approve it, but this session cannot ask anyone, such as a scheduled run.",
          ),
        },
      });
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
          expect.objectContaining({
            text: RUNBOOK_SKILL_MD,
            uri: "skill://deploy-runbook/SKILL.md",
          }),
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
      await writeFile(join(appRoot, flag), "");
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
      const firstTurn = await agent.deliver(alice, createSession("a2a-signin-reask"), {
        message: "List my issues.",
      });
      expect(agent.requested).toHaveLength(1);

      // Answered without signing in: B re-asks with a fresh requestState and
      // nothing runs.
      const secondTurn = await agent.deliver(
        alice,
        firstTurn.session,
        answer(alice, agent.requested[0]!, "approve"),
      );
      expect(agent.requested).toHaveLength(2);
      expect(agent.requested[1]!.requestId).not.toBe(agent.requested[0]!.requestId);
      expect(JSON.stringify(agent.requested[1])).toContain("https://idp.example/authorize");
      expect(getPendingRemoteInputs(secondTurn.session.state)).toHaveLength(1);
      expect(await deploys()).toEqual(before);

      await writeFile(join(appRoot, flag), "");
      await agent.deliver(alice, secondTurn.session, answer(alice, agent.requested[1]!, "approve"));
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

      const firstCall = await call(alice, "a2a-session-1");
      const again = await call(alice, "a2a-session-1");
      const otherConversation = await call(alice, "a2a-session-2");
      const otherCaller = await call(bob, "a2a-session-1");

      expect(firstCall).toMatchObject({
        caller: "alice",
        sessionId: expect.stringMatching(/^ts_/u),
      });
      // Same conversation and caller, fresh client and connection: same session.
      expect(again.sessionId).toBe(firstCall.sessionId);
      expect(otherConversation.sessionId).not.toBe(firstCall.sessionId);
      // The key alone never reaches another caller's session.
      expect(otherCaller).toMatchObject({ caller: "bob" });
      expect(otherCaller.sessionId).not.toBe(firstCall.sessionId);
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
  return {
    connectionName: CONNECTION,
    description: "Agent B's ops tools.",
    forwardPrincipal: true,
    headers: { "x-test-principal": "router" },
    logicalPath: `connections/${CONNECTION}.ts`,
    protocol: "mcp",
    sourceId: CONNECTION,
    sourceKind: "module",
    url: mcpUrl(),
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
    for (const streamCall of [...model.doStreamCalls].reverse()) {
      const last = streamCall.prompt.at(-1);
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

// ---------- Third-party client ----------

const AnyResult = z.record(z.string(), z.unknown());

interface SkillResource {
  readonly uri: string;
  readonly digest: string;
  readonly size: number;
}

async function connectThirdPartyClient(
  era: "legacy" | "modern",
  headers: Record<string, string> = { "x-test-principal": "interop" },
): Promise<Client> {
  const client = new Client(
    { name: "eve-scenario-interop", version: "0.0.0" },
    era === "modern"
      ? { versionNegotiation: { mode: { pin: MODERN_PROTOCOL_VERSION } } }
      : undefined,
  );
  await client.connect(
    new StreamableHTTPClientTransport(new URL(mcpUrl()), { requestInit: { headers } }),
  );
  return client;
}

describe("a third-party MCP client against mcpChannel", () => {
  it.each([
    ["modern", MODERN_PROTOCOL_VERSION],
    ["legacy", LEGACY_PROTOCOL_VERSION],
  ] as const)(
    "lists and calls tools and reads skills byte for byte, %s era",
    async (era, protocolVersion) => {
      const client = await connectThirdPartyClient(era);
      try {
        expect(client.getNegotiatedProtocolVersion()).toBe(protocolVersion);

        const { tools } = await client.listTools();
        expect(tools.find((tool) => tool.name === "query_usage")).toMatchObject({
          inputSchema: { required: ["account", "window"], type: "object" },
        });
        await expect(
          client.callTool({ arguments: { account: "acme", window: "30d" }, name: "query_usage" }),
        ).resolves.toMatchObject({
          structuredContent: { account: "acme", requests: 1234, window: "30d" },
        });

        const listed = await client.request({ method: "skills/list", params: {} }, AnyResult);
        const triage = (listed.skills as { uri: string; resources: SkillResource[] }[]).find(
          (skill) => skill.uri === "skill://usage-triage/SKILL.md",
        );
        expect(triage).toEqual({
          uri: "skill://usage-triage/SKILL.md",
          frontmatter: {
            name: "usage-triage",
            description: "Triage an account's usage spike with query_usage.",
            license: "Apache-2.0",
            metadata: { owner: "billing" },
          },
          resources: Object.keys(TRIAGE_FILES)
            .sort()
            .map((path) => expect.objectContaining({ uri: `skill://usage-triage/${path}` })),
        });
        await expect(
          client.request(
            { method: "skills/get", params: { uri: "skill://usage-triage/SKILL.md" } },
            AnyResult,
          ),
        ).resolves.toMatchObject({ skill: { uri: "skill://usage-triage/SKILL.md" } });

        // Every listed file reads back with the listed digest and size, and
        // with exactly the bytes written into the skills tree.
        for (const resource of triage!.resources) {
          const path = resource.uri.slice("skill://usage-triage/".length);
          const { contents } = await client.readResource({ uri: resource.uri });
          expect(contents, path).toHaveLength(1);
          const content = contents[0]!;
          const bytes =
            "blob" in content
              ? Buffer.from(content.blob, "base64")
              : Buffer.from(content.text, "utf8");
          expect(bytes.equals(TRIAGE_FILES[path]!), path).toBe(true);
          expect({ path, digest: resource.digest, size: resource.size }).toEqual({
            path,
            digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
            size: bytes.byteLength,
          });
          if (path === "SKILL.md") expect(content).toMatchObject({ mimeType: "text/markdown" });
          // readSkill returns these as bytes, not strings, through Nitro's server assets.
          if (path === "assets/logo.png" || path === "references/latin1.md") {
            expect(content, path).toHaveProperty("blob");
          }
        }

        await expect(client.readResource({ uri: "skill://lower/SKILL.md" })).resolves.toMatchObject(
          {
            contents: [
              { mimeType: "text/markdown", text: LOWER_SKILL_MD, uri: "skill://lower/SKILL.md" },
            ],
          },
        );

        const directory = await client.request(
          { method: "resources/directory/read", params: { uri: "skill://usage-triage" } },
          AnyResult,
        );
        expect(directory.resources).toEqual([
          expect.objectContaining({ uri: "skill://usage-triage/SKILL.md" }),
          expect.objectContaining({
            mimeType: "inode/directory",
            uri: "skill://usage-triage/assets",
          }),
          expect.objectContaining({
            mimeType: "inode/directory",
            uri: "skill://usage-triage/references",
          }),
        ]);

        await expect(
          client.readResource({ uri: "skill://usage-triage/references/../SKILL.md" }),
        ).rejects.toBeInstanceOf(ResourceNotFoundError);
      } finally {
        await client.close();
      }
    },
    OPERATION_TIMEOUT_MS,
  );

  it("refuses a client without credentials with HTTP 401", async () => {
    const error = await connectThirdPartyClient("modern", {}).then(
      async (client) => {
        await client.close();
        throw new Error("Connected without credentials.");
      },
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(SdkHttpError);
    expect((error as SdkHttpError).status).toBe(401);
  });
});

// ---------- Build output ----------

describe("skill files in production server assets", () => {
  it("inlines the skills tree as Nitro chunks rather than plain copies", async () => {
    const skillFiles =
      Object.keys(TRIAGE_FILES).length +
      Object.keys(DESCRIPTOR.files).filter((path) => path.startsWith("agent/skills/")).length;
    const serverFiles = (
      await readdir(join(appRoot, ".output", "server"), { recursive: true })
    ).map(String);
    expect(serverFiles.filter((path) => /\.(png|md|MD)$/.test(path))).toEqual([]);
    expect(serverFiles.filter((path) => path.endsWith(".bin.mjs"))).toHaveLength(skillFiles);
    await expect(access(join(appRoot, ".output", "server", "_eve-skills"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
