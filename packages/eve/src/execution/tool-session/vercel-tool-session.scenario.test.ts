import { randomBytes } from "node:crypto";

import { afterAll, describe, expect, it, vi } from "vitest";

import type { SessionAuthContext } from "#channel/types.js";
import { shutdownActiveSandboxHandles } from "#execution/sandbox/active-handles.js";
import { getNamedSandboxSessions } from "#execution/sandbox/named-sessions.js";
import { createSandboxProviderHost } from "#execution/sandbox/provider-host.js";
import { createToolExecuteWithAuth } from "#execution/tool-auth.js";
import { invokeToolInSession, type ToolSessionRuntime } from "#execution/tool-session/invoke.js";
import {
  TOOL_SESSION_SANDBOX_TAG,
  toolSessionSandboxName,
} from "#execution/tool-session/sandbox.js";
import { deriveToolSessionId } from "#execution/tool-session/id.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import { defineSandbox } from "#public/definitions/sandbox.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import type { RuntimeSandboxRegistry } from "#runtime/sandbox/registry.js";
import { VercelSandbox } from "#sandbox/providers/vercel.js";
import { getSandboxEnvironmentRuntime } from "#shared/sandbox-environment.js";
import type { ToolContext } from "#tools/definition.js";
import { defineJsonSchema } from "#tools/schema.js";

/*
 * Real Vercel Sandbox lifecycle for tool sessions. Opt in with
 * EVE_VERCEL_SANDBOX_SCENARIO=1 and Vercel credentials (VERCEL_OIDC_TOKEN, or
 * VERCEL_TOKEN with VERCEL_TEAM_ID and VERCEL_PROJECT_ID). It creates one
 * sandbox and deletes it at the end.
 */
const live =
  process.env.EVE_VERCEL_SANDBOX_SCENARIO === "1" &&
  (process.env.VERCEL_OIDC_TOKEN !== undefined || process.env.VERCEL_TOKEN !== undefined);

// The base image, with no prepared snapshot.
vi.mock("#runtime/sandbox/prepared-artifacts.js", () => ({
  loadSandboxPreparedArtifact: vi.fn(async () => ({})),
}));

const caller: SessionAuthContext = {
  attributes: {},
  authenticator: "scenario",
  principalId: "vercel-tool-session-scenario",
  principalType: "user",
};
const key = `scenario-${randomBytes(6).toString("hex")}`;
const schema = defineJsonSchema({
  additionalProperties: false,
  properties: { path: { type: "string" }, text: { type: "string" } },
  type: "object",
});

function tool(
  name: string,
  execute: (input: any, ctx: ToolContext) => unknown,
): HarnessToolDefinition {
  return {
    description: name,
    execute: createToolExecuteWithAuth({ execute, scope: name }),
    inputSchema: schema,
    name,
  };
}

const environment = VercelSandbox.environment({ timeout: 5 * 60_000 } as never);
const registry: RuntimeSandboxRegistry = {
  sandbox: {
    definition: {
      environment,
      kind: "independent",
      logicalPath: "sandbox.ts",
      revisionHash: "scenario",
      selector: defineSandbox(async () => await environment.open()),
      sourceId: "sandbox",
      sourceKind: "module",
    },
    workspaceResourceRoot: { logicalPath: "", rootEntries: [] },
  },
};
const tools = [
  tool("pure", () => "no sandbox"),
  tool("write", async (input: { path: string; text: string }, ctx) => {
    await (await ctx.getSandbox()).writeTextFile({ content: input.text, path: input.path });
    return "written";
  }),
  tool("read", async (input: { path: string }, ctx) => {
    return await (await ctx.getSandbox()).readTextFile({ path: input.path });
  }),
  tool("stop", async (_input, ctx) => {
    await (await ctx.getSandbox()).stop();
    return "stopped";
  }),
];
const runtime: ToolSessionRuntime = {
  callbackBaseUrl: "https://agent.example",
  compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
  manifest: {
    bindings: Object.fromEntries(
      tools.map((definition) => [`source:${definition.name}`, { owner: { kind: "application" } }]),
    ),
    tools: tools.map((definition) => ({
      hasExecute: true,
      name: definition.name,
      sourceId: `source:${definition.name}`,
    })),
  },
  nodeId: "__root__",
  sandboxRegistry: registry,
  tools: new Map(tools.map((definition) => [definition.name, definition])),
};

function call(name: string, input: unknown) {
  return invokeToolInSession(runtime, name, input, { auth: caller, key });
}

afterAll(async () => {
  if (!live) return;
  await shutdownActiveSandboxHandles();
  const provider = getSandboxEnvironmentRuntime(environment);
  const named = getNamedSandboxSessions(provider.implementation)!;
  const name = toolSessionSandboxName({
    artifact: {},
    providerName: provider.providerName,
    sessionId: deriveToolSessionId({ current: caller, key: { kind: "key", value: key } }),
  });
  await named.delete(
    { host: createSandboxProviderHost(process.cwd()), storagePath: process.cwd() },
    { name, tag: TOOL_SESSION_SANDBOX_TAG },
  );
}, 120_000);

describe.runIf(live)("tool sessions on Vercel Sandbox", () => {
  it("opens no sandbox when no tool asks for one", async () => {
    const result = await call("pure", {});
    expect(result).toMatchObject({ output: "no sandbox", status: "completed" });
    expect(result.sandbox).toBeUndefined();
  });

  it("converges concurrent first calls on one sandbox", async () => {
    const results = await Promise.all([
      call("write", { path: "/vercel/sandbox/a.txt", text: "one" }),
      call("write", { path: "/vercel/sandbox/b.txt", text: "two" }),
    ]);
    expect(results.map((result) => result.status)).toEqual(["completed", "completed"]);
    expect(results.map((result) => result.sandbox?.state).sort()).toEqual(["created", "reused"]);
    expect(await call("read", { path: "/vercel/sandbox/b.txt" })).toMatchObject({ output: "two" });
  }, 300_000);

  it("reuses the running sandbox, then resumes it after a stop with the file intact", async () => {
    expect(await call("read", { path: "/vercel/sandbox/a.txt" })).toMatchObject({
      output: "one",
      sandbox: { state: "reused" },
    });
    expect(await call("stop", {})).toMatchObject({ status: "completed" });
    expect(await call("read", { path: "/vercel/sandbox/a.txt" })).toMatchObject({
      output: "one",
      sandbox: { state: "resumed" },
    });
  }, 300_000);
});
