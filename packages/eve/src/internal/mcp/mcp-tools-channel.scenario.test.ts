import { execFile, spawn, type ChildProcessByStdio } from "node:child_process";
import { once } from "node:events";
import { writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  materializeScenarioApp,
  type ScenarioAppDescriptor,
} from "#internal/testing/scenario-app.js";

type ScenarioApp = Awaited<ReturnType<typeof materializeScenarioApp>>;

const execFileAsync = promisify(execFile);
const SETUP_TIMEOUT_MS = 360_000;
const OPERATION_TIMEOUT_MS = 30_000;
const MCP_PROTOCOL_VERSION = "2026-07-28";
const REQUEST_STATE_SECRET = "scenario-request-state-secret-0123456789";

const DESCRIPTOR: ScenarioAppDescriptor = {
  dependencies: { zod: "4.5.4" },
  files: {
    "agent/agent.ts": `export default { model: "openai/gpt-5.4" };\n`,
    "agent/instructions.md": "Publish tools over MCP.\n",
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
    "agent/tools/echo.ts": `import { defineTool } from "eve/tools";
import { z } from "zod";

export default defineTool({
  description: "Echo the text back.",
  inputSchema: z.object({ text: z.string() }),
  async execute(input) {
    return { echoed: input.text };
  },
});
`,
    "agent/tools/deploy.ts": `import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";

export default defineTool({
  approval: always(),
  description: "Deploy an environment.",
  inputSchema: z.object({ env: z.string() }),
  async execute(input) {
    return { deployed: input.env };
  },
});
`,
    "agent/tools/issues.ts": `import { existsSync } from "node:fs";
import { ConnectionAuthorizationRequiredError } from "eve/connections";
import { defineTool } from "eve/tools";
import { z } from "zod";

const linear = {
  async completeAuthorization() {
    return { token: "fresh" };
  },
  displayName: "Linear",
  async getToken() {
    const flag = process.env.SCENARIO_SIGNED_IN_FLAG;
    if (flag === undefined || !existsSync(flag)) {
      throw new ConnectionAuthorizationRequiredError("linear");
    }
    return { token: "signed-in" };
  },
  principalType: "user",
  async startAuthorization() {
    return { challenge: { url: "https://idp.example/authorize" } };
  },
};

export default defineTool({
  description: "List Linear issues.",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    const { token } = await ctx.getToken(linear, { authKey: "linear" });
    return { count: 3, token };
  },
});
`,
  },
  installDependencies: true,
  name: "mcp-tools-channel",
};

type Json = Record<string, any>;

interface RunningServer {
  readonly output: () => string;
  readonly url: string;
  stop(): Promise<void>;
}

let app: ScenarioApp | undefined;
let first: RunningServer | undefined;
let second: RunningServer | undefined;
let signedInFlag = "";

/**
 * Two production servers built from one app, sharing only
 * EVE_MCP_REQUEST_STATE_SECRET: a requestState minted by one must verify on
 * the other, which is what a multi-instance deployment needs.
 */
describe("mcpChannel tools over real HTTP", () => {
  beforeAll(async () => {
    app = await materializeScenarioApp(DESCRIPTOR);
    await execFileAsync(
      process.execPath,
      [join(app.appRoot, "node_modules/eve/bin/eve.js"), "build"],
      {
        cwd: app.appRoot,
        maxBuffer: 20 * 1024 * 1024,
        timeout: 180_000,
      },
    );
    signedInFlag = join(app.appRoot, "signed-in.flag");
    // One at a time: both share the app's local workflow world, and two
    // processes initializing it at once can read its version file half-written.
    first = await startServer(app.appRoot, signedInFlag);
    second = await startServer(app.appRoot, signedInFlag);
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await Promise.all([first?.stop(), second?.stop()]);
    await app?.cleanup();
  }, 60_000);

  it("advertises tools, the tool-session extension, and cache hints in discover and the list", async () => {
    const discover = await rpc(server(1), "alice", "server/discover", {});
    expect(discover.result).toMatchObject({
      cacheScope: "private",
      capabilities: {
        extensions: { "dev.eve/tool-sessions": {} },
        tools: { listChanged: true },
      },
      ttlMs: 300_000,
    });

    const listed = await rpc(server(1), "alice", "tools/list", {});
    expect(listed.result).toMatchObject({ cacheScope: "private", ttlMs: 300_000 });
    const tools = listed.result!.tools as Json[];
    const names = tools.map((tool) => tool.name);
    // The channel's own agent_* tools come first; the agent's tools follow in name order.
    expect(names.slice(0, 4)).toEqual(["agent_start", "agent_get", "agent_update", "agent_cancel"]);
    expect(names.slice(4)).toEqual(names.slice(4).sort());
    expect(names).toEqual(expect.arrayContaining(["deploy", "echo", "issues"]));
    expect(tools.find((tool) => tool.name === "deploy")).toMatchObject({
      _meta: { "dev.eve/approval": true },
      inputSchema: { properties: { env: { type: "string" } }, type: "object" },
    });
    expect(tools.find((tool) => tool.name === "echo")?._meta).toBeUndefined();
  });

  it("runs a plain tool", async () => {
    const called = await callTool(server(1), "alice", "echo", { text: "hi" });
    expect(called.result).toMatchObject({ structuredContent: { echoed: "hi" } });
    expect(called.result?.isError).toBeUndefined();
  });

  it("asks for approval and runs after the person approves", async () => {
    const meta = { "dev.eve/tool-session": "approval-thread" };
    const asked = await callTool(server(1), "alice", "deploy", { env: "prod" }, { meta });
    expect(asked.result).toMatchObject({
      inputRequests: { "dev.eve/approval": { params: { mode: "form" } } },
      resultType: "input_required",
    });

    const approved = await callTool(
      server(1),
      "alice",
      "deploy",
      { env: "prod" },
      {
        inputResponses: { "dev.eve/approval": { action: "accept", content: { approved: true } } },
        meta,
        requestState: asked.result!.requestState,
      },
    );
    expect(approved.result).toMatchObject({ structuredContent: { deployed: "prod" } });
  });

  it("retries a sign-in on another instance holding only the same secret", async () => {
    const meta = { "dev.eve/tool-session": "sign-in-thread" };
    const asked = await callTool(server(1), "alice", "issues", {}, { meta });
    expect(asked.result?.resultType).toBe("input_required");
    const keys = Object.keys(asked.result!.inputRequests);
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(/^dev\.eve\/authorization:/u);
    expect(asked.result!.inputRequests[keys[0]!]).toMatchObject({
      method: "elicitation/create",
      params: { mode: "url", url: "https://idp.example/authorize" },
    });

    // The person finishes signing in at the provider.
    await writeFile(signedInFlag, "1");
    const retried = await callTool(
      server(2),
      "alice",
      "issues",
      {},
      {
        inputResponses: { [keys[0]!]: { action: "accept" } },
        meta,
        requestState: asked.result!.requestState,
      },
    );
    expect(retried.result).toMatchObject({ structuredContent: { count: 3, token: "signed-in" } });
  });

  it("falls back to a one-off session without a key, and the nonce round-trips across instances", async () => {
    const asked = await callTool(server(1), "alice", "deploy", { env: "staging" });
    expect(asked.result?.resultType).toBe("input_required");
    const payload = decodeRequestState(asked.result!.requestState);
    expect(payload).toMatchObject({ kind: "approval", tool: "deploy", v: 1 });
    expect(typeof payload.nonce).toBe("string");

    const approved = await callTool(
      server(2),
      "alice",
      "deploy",
      { env: "staging" },
      {
        inputResponses: { "dev.eve/approval": { action: "accept", content: { approved: true } } },
        requestState: asked.result!.requestState,
      },
    );
    expect(approved.result).toMatchObject({ structuredContent: { deployed: "staging" } });
  });

  it("refuses a forged requestState and a valid one replayed by another principal or forwarder", async () => {
    const answer = { "dev.eve/approval": { action: "accept", content: { approved: true } } };
    const meta = { "dev.eve/tool-session": "replay-thread" };
    const asked = await callTool(server(1), "alice", "deploy", { env: "prod" }, { meta });
    const requestState = asked.result!.requestState as string;
    const invalid = {
      code: -32_602,
      data: { reason: "invalid_request_state" },
      message: "Invalid or expired requestState",
    };

    const [prefix, body, mac] = requestState.split(".");
    const decoded = JSON.parse(Buffer.from(body!, "base64url").toString("utf8")) as Json;
    const forgedBody = Buffer.from(
      JSON.stringify({ ...decoded, p: { ...decoded.p, sid: "ts_forged" } }),
    ).toString("base64url");
    const forged = await callTool(
      server(2),
      "alice",
      "deploy",
      { env: "prod" },
      { inputResponses: answer, meta, requestState: `${prefix}.${forgedBody}.${mac}` },
    );
    expect(forged.error).toEqual(invalid);

    const otherUser = await callTool(
      server(2),
      "bob",
      "deploy",
      { env: "prod" },
      { inputResponses: answer, meta, requestState },
    );
    expect(otherUser.error).toEqual(invalid);

    const viaForwarder = await callTool(
      server(2),
      "router",
      "deploy",
      { env: "prod" },
      {
        forwardedPrincipal: {
          current: {
            attributes: {},
            authenticator: "scenario",
            principalId: "alice",
            principalType: "user",
          },
        },
        inputResponses: answer,
        meta,
        requestState,
      },
    );
    expect(viaForwarder.error).toEqual(invalid);

    // The honest retry still works after the refusals.
    const honest = await callTool(
      server(2),
      "alice",
      "deploy",
      { env: "prod" },
      { inputResponses: answer, meta, requestState },
    );
    expect(honest.result).toMatchObject({ structuredContent: { deployed: "prod" } });
  });

  it("acknowledges subscriptions/listen and then closes the stream", async () => {
    const response = await mcpFetch(server(1), "alice", "subscriptions/listen", {
      notifications: { toolsListChanged: true },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    // `text()` resolving at all proves the server ended the stream.
    const text = await response.text();
    const events = text
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice("data: ".length)) as Json);
    expect(events).toEqual([
      expect.objectContaining({
        method: "notifications/subscriptions/acknowledged",
        params: expect.objectContaining({ notifications: { toolsListChanged: true } }),
      }),
    ]);
  });
});

function server(which: 1 | 2): RunningServer {
  const running = which === 1 ? first : second;
  if (running === undefined) throw new Error("Scenario servers did not start.");
  return running;
}

interface CallOptions {
  readonly forwardedPrincipal?: unknown;
  readonly inputResponses?: Json;
  readonly meta?: Json;
  readonly requestState?: unknown;
}

async function callTool(
  target: RunningServer,
  principal: string,
  name: string,
  args: Json,
  options: CallOptions = {},
): Promise<{ readonly error?: Json; readonly result?: Json }> {
  const params: Json = { arguments: args, name };
  if (options.inputResponses !== undefined) params.inputResponses = options.inputResponses;
  if (options.requestState !== undefined) params.requestState = options.requestState;
  return await rpc(target, principal, "tools/call", params, options);
}

async function rpc(
  target: RunningServer,
  principal: string,
  method: string,
  params: Json,
  options: CallOptions = {},
): Promise<{ readonly error?: Json; readonly result?: Json }> {
  const response = await mcpFetch(target, principal, method, params, options);
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`MCP HTTP ${response.status}: ${body}\n${target.output()}`);
  }
  if (!response.headers.get("content-type")?.includes("text/event-stream")) {
    return JSON.parse(body) as Json;
  }
  const data = body.split("\n").find((line) => line.startsWith("data: "));
  if (data === undefined) throw new Error("MCP response did not contain an SSE data event.");
  return JSON.parse(data.slice("data: ".length)) as Json;
}

async function mcpFetch(
  target: RunningServer,
  principal: string,
  method: string,
  params: Json,
  options: CallOptions = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
    "mcp-method": method,
    "mcp-protocol-version": MCP_PROTOCOL_VERSION,
    "x-test-principal": principal,
  };
  if (typeof params.name === "string") headers["mcp-name"] = params.name;
  if (options.forwardedPrincipal !== undefined) {
    headers["eve-forwarded-principal"] = Buffer.from(
      JSON.stringify(options.forwardedPrincipal),
    ).toString("base64url");
  }
  return await fetch(`${target.url}/eve/v1/mcp`, {
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
          "io.modelcontextprotocol/protocolVersion": MCP_PROTOCOL_VERSION,
        },
      },
    }),
    headers,
    method: "POST",
    signal: AbortSignal.timeout(OPERATION_TIMEOUT_MS),
  });
}

function decodeRequestState(state: unknown): Json {
  if (typeof state !== "string") throw new Error("requestState was not a string.");
  const body = state.split(".")[1]!;
  return (JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Json).p as Json;
}

async function freePort(): Promise<number> {
  const probe = createServer().listen(0, "127.0.0.1");
  await once(probe, "listening");
  const address = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  if (address === null || typeof address === "string") throw new Error("No port.");
  return address.port;
}

async function startServer(appRoot: string, flag: string): Promise<RunningServer> {
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
        SCENARIO_SIGNED_IN_FLAG: flag,
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
    if (child.exitCode !== null) throw new Error(`Server exited early:\n${output}`);
    try {
      // Any HTTP answer means the listener is up; 401 is expected here.
      await fetch(`${url}/eve/v1/mcp`, { method: "GET", signal: AbortSignal.timeout(1000) });
      return { output: () => output, stop, url };
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  await stop();
  throw new Error(`Timed out waiting for the server:\n${output}`);
}
