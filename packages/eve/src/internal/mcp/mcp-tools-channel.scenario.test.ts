import { execFile, spawn, type ChildProcessByStdio } from "node:child_process";
import { once } from "node:events";
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
  auth: (request) => {
    const principalId = request.headers.get("x-test-principal");
    if (principalId === null) return null;
    return {
      attributes: {},
      authenticator: "scenario",
      principalId,
      principalType: "user",
    };
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
    // One at a time: both share the app's local workflow world, and two
    // processes initializing it at once can read its version file half-written.
    first = await startServer(app.appRoot);
    second = await startServer(app.appRoot);
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await Promise.all([first?.stop(), second?.stop()]);
    await app?.cleanup();
  }, 60_000);

  it("retries an approval on the other instance, which holds only the same env secret", async () => {
    // Keyed calls resume the key's session; unkeyed ones a one-off session.
    for (const meta of [{ "dev.eve/tool-session": "approval-thread" }, undefined]) {
      const label = meta === undefined ? "one-off" : "keyed";
      const asked = await callTool(server(1), "alice", "deploy", { env: label }, { meta });
      expect(asked.result?.resultType, label).toBe("input_required");

      const approved = await callTool(
        server(2),
        "alice",
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

async function freePort(): Promise<number> {
  const probe = createServer().listen(0, "127.0.0.1");
  await once(probe, "listening");
  const address = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  if (address === null || typeof address === "string") throw new Error("No port.");
  return address.port;
}

async function startServer(appRoot: string): Promise<RunningServer> {
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
