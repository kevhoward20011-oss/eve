import { jsonSchema } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Approval, ApprovalPolicy } from "#approval/definition.js";
import type { InvokeToolOptions } from "#channel/invoke-tool.js";
import type { SessionAuthContext } from "#channel/types.js";
import { shutdownActiveSandboxHandles } from "#execution/sandbox/active-handles.js";
import {
  SandboxNameConflictError,
  withNamedSandboxSessions,
} from "#execution/sandbox/named-sessions.js";
import { createToolExecuteWithAuth } from "#execution/tool-auth.js";
import {
  invokeToolInSession,
  type ToolSessionManifest,
  type ToolSessionRuntime,
} from "#execution/tool-session/invoke.js";
import {
  sweepToolSessionSandboxes,
  TOOL_SESSION_SANDBOX_EXPIRY_MS,
} from "#execution/tool-session/sandbox.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import { mockSandbox, type MockSandbox } from "#internal/testing/mocks/mock-sandbox.js";
import { defineSandbox } from "#public/definitions/sandbox.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import type { RuntimeSandboxRegistry } from "#runtime/sandbox/registry.js";
import { defineSandboxProvider } from "#shared/sandbox-provider.js";
import type { ToolContext } from "#tools/definition.js";
import { defineJsonSchema } from "#tools/schema.js";

vi.mock("#runtime/sandbox/prepared-artifacts.js", () => ({
  loadSandboxPreparedArtifact: vi.fn(async () => ({ snapshotId: "template-1" })),
}));

afterEach(() => shutdownActiveSandboxHandles());

const principal = (id: string): SessionAuthContext => ({
  attributes: {},
  authenticator: "test",
  principalId: id,
  principalType: "user",
});
const alice = principal("alice");
const bob = principal("bob");

interface StoredSandbox {
  lastUsedAt: number;
  readonly mock: MockSandbox;
  running: boolean;
}

/**
 * Named sandboxes whose create is atomic but whose find-then-create is not,
 * and whose conditional delete honors the condition the sweep passes.
 */
function createNamedProvider() {
  const store = new Map<string, StoredSandbox>();
  const conflicts: string[] = [];
  let now = 1_000;
  let findBarrier: { count: number; release: () => void; wait: Promise<void> } | undefined;
  let onList: (() => Promise<void>) | undefined;
  let beforeDelete: (() => Promise<void>) | undefined;
  let finds = 0;

  const handle = (name: string, stored: StoredSandbox) => ({
    sandbox: stored.mock.session,
    async onRuntimeShutdown() {},
    async onSessionDelete() {
      store.delete(name);
    },
    async onSessionStop() {
      stored.running = false;
    },
  });
  const unsupported = async (): Promise<never> => {
    throw new Error("tool sessions use named sandboxes");
  };
  const environment = defineSandboxProvider({
    name: "memory-named",
    environment: () =>
      withNamedSandboxSessions(
        { prepare: async () => null, resume: unsupported, start: unsupported },
        {
          async create(context, _options, _artifact, { name }) {
            if (store.has(name)) {
              conflicts.push(name);
              throw new SandboxNameConflictError(name);
            }
            const stored = {
              lastUsedAt: now,
              mock: mockSandbox({ id: context.session.id }),
              running: true,
            };
            store.set(name, stored);
            return handle(name, stored);
          },
          async delete(_context, { name }, condition) {
            const stored = store.get(name);
            if (stored === undefined) return false;
            if (
              condition !== undefined &&
              (stored.running || stored.lastUsedAt >= condition.idleBefore || condition.inUse?.())
            ) {
              return false;
            }
            const pause = beforeDelete;
            beforeDelete = undefined;
            await pause?.();
            store.delete(name);
            return true;
          },
          async find(_context, _artifact, { name }) {
            finds += 1;
            const barrier = findBarrier;
            if (barrier !== undefined && --barrier.count === 0) barrier.release();
            await barrier?.wait;
            const stored = store.get(name);
            if (stored === undefined) return null;
            const running = stored.running;
            stored.running = true;
            stored.lastUsedAt = now;
            return { handle: handle(name, stored), running };
          },
          async list() {
            const summaries = [...store].map(([name, { lastUsedAt, running }]) => ({
              lastUsedAt,
              name,
              running,
            }));
            const run = onList;
            onList = undefined;
            await run?.();
            return summaries;
          },
        },
      ),
  }).environment();
  const registry: RuntimeSandboxRegistry = {
    sandbox: {
      definition: {
        environment,
        kind: "independent",
        logicalPath: "sandbox.ts",
        revisionHash: "hash",
        selector: defineSandbox(async () => await environment.open()),
        sourceId: "sandbox",
        sourceKind: "module",
      },
      workspaceResourceRoot: { logicalPath: "", rootEntries: [] },
    },
  };
  return {
    conflicts,
    registry,
    store,
    get finds() {
      return finds;
    },
    /** Holds every `find` until `count` of them are in flight. */
    holdFinds(count: number) {
      const { promise, resolve } = Promise.withResolvers<void>();
      findBarrier = { count, release: resolve, wait: promise };
    },
    /** Holds the next delete after its idle check until `release()`. */
    pauseNextDelete() {
      const reached = Promise.withResolvers<void>();
      const released = Promise.withResolvers<void>();
      beforeDelete = async () => {
        reached.resolve();
        await released.promise;
      };
      return { reached: reached.promise, release: released.resolve };
    },
    /** Runs `fn` after the sweep lists sandboxes and before it deletes any. */
    afterList(fn: () => Promise<void>) {
      onList = fn;
    },
    /** Moves past the expiry and lets the provider stop every sandbox. */
    expireAll() {
      now += TOOL_SESSION_SANDBOX_EXPIRY_MS + 1;
      for (const stored of store.values()) stored.running = false;
    },
    sweep() {
      return sweepToolSessionSandboxes({
        compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
        now,
        registry,
      });
    },
  };
}

const objectSchema = defineJsonSchema({
  additionalProperties: false,
  properties: { path: { type: "string" }, text: { type: "string" } },
  type: "object",
});

function tool(
  name: string,
  execute: (input: any, ctx: ToolContext) => unknown,
  extra: Partial<HarnessToolDefinition> = {},
): HarnessToolDefinition {
  return {
    description: name,
    execute: createToolExecuteWithAuth({ execute, scope: name }),
    inputSchema: objectSchema,
    name,
    ...extra,
  };
}

function runtimeWith(
  tools: readonly HarnessToolDefinition[],
  registry: RuntimeSandboxRegistry = createNamedProvider().registry,
): ToolSessionRuntime {
  // Framework and handled tools are refused on a real compiled registry in
  // route-invoke-tool.integration; this stand-in lists application tools only.
  const manifest: ToolSessionManifest = {
    bindings: Object.fromEntries(
      tools.map(({ name }) => [`source:${name}`, { owner: { kind: "application" } }]),
    ),
    tools: tools.map(({ name }) => ({ hasExecute: true, name, sourceId: `source:${name}` })),
  };
  return {
    callbackBaseUrl: "https://agent.example",
    compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
    manifest,
    nodeId: "__root__",
    sandboxRegistry: registry,
    tools: new Map(tools.map((definition) => [definition.name, definition])),
  };
}

function call(
  runtime: ToolSessionRuntime,
  name: string,
  input: unknown,
  options: Partial<InvokeToolOptions> = {},
) {
  return invokeToolInSession(runtime, name, input, {
    auth: alice,
    key: "conversation-1",
    ...options,
  });
}

describe("invokeTool approval", () => {
  const requestPolicies: Record<"ask" | "deny" | "pass", ApprovalPolicy> = {
    ask: () => "user-approval",
    deny: () => ({ reason: "Read-only mode.", type: "denied" }),
    pass: () => "not-applicable",
  };
  const aliceOnly = ({ response }: { response: { principal: SessionAuthContext } }) =>
    response.principal.principalId === "alice"
      ? ({ status: "allowed" } as const)
      : ({ reason: "Only alice may answer.", status: "rejected" } as const);
  const declined = { reason: "The person declined this call.", status: "denied" } as const;
  const rejected = { reason: "Only alice may answer.", status: "denied" } as const;
  const completed = { status: "completed" } as const;

  // [label, request policy, has response policy, approved, responder, expected]
  it.each([
    [
      "asks without an answer",
      "ask",
      false,
      undefined,
      alice,
      { callId: "c1", status: "approval-required" },
    ],
    ["runs on an approval", "ask", false, true, alice, completed],
    ["denies a decline", "ask", false, false, alice, declined],
    ["denies a responder the response policy rejects", "ask", true, true, bob, rejected],
    ["runs when the response policy allows the responder", "ask", true, true, alice, completed],
    [
      "checks a supplied answer even when the request policy passes",
      "pass",
      true,
      true,
      bob,
      rejected,
    ],
    ["honors a decline even when the request policy passes", "pass", false, false, alice, declined],
    ["runs a pass-through without an answer", "pass", false, undefined, alice, completed],
    [
      "lets a request-policy denial win over an approval",
      "deny",
      true,
      true,
      alice,
      { reason: "Read-only mode.", status: "denied" },
    ],
  ] as const)("%s", async (_label, policy, checksResponder, approved, responder, expected) => {
    const execute = vi.fn(() => "deployed");
    const response = vi.fn(aliceOnly);
    const approval: Approval = checksResponder
      ? { request: requestPolicies[policy], response }
      : requestPolicies[policy];
    const runtime = runtimeWith([tool("deploy", execute, { approval })]);

    const result = await call(
      runtime,
      "deploy",
      {},
      {
        approval: approved === undefined ? undefined : { approved },
        auth: responder,
        callId: "c1",
      },
    );

    if (expected.status === "completed") expect(result).toMatchObject(expected);
    else expect(result).toEqual(expected);
    expect(execute).toHaveBeenCalledTimes(expected.status === "completed" ? 1 : 0);
    if (!checksResponder || policy === "deny") {
      expect(response).not.toHaveBeenCalled();
      return;
    }
    expect(response).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({ principal: responder, toolName: "deploy" }),
        response: { decision: approved ? "approve" : "cancel", principal: responder },
      }),
    );
  });

  it("does not carry an approval over to the next call with the same callId", async () => {
    const execute = vi.fn(() => "deployed");
    const runtime = runtimeWith([tool("deploy", execute, { approval: requestPolicies.ask })]);

    await call(runtime, "deploy", {}, { approval: { approved: true }, callId: "c1" });
    expect(await call(runtime, "deploy", {}, { callId: "c1" })).toMatchObject({
      status: "approval-required",
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });
});

const writeTool = tool("write", async (input: { path: string; text: string }, ctx) => {
  await (await ctx.getSandbox()).writeTextFile({ content: input.text, path: input.path });
  return "written";
});
const readTool = tool("read", async (input: { path: string }, ctx) => {
  return await (await ctx.getSandbox()).readTextFile({ path: input.path });
});

describe("tool-session sandbox races", () => {
  it("converges concurrent first calls on one sandbox through the conflict retry", async () => {
    const provider = createNamedProvider();
    const runtime = runtimeWith([writeTool], provider.registry);
    provider.holdFinds(2);

    const results = await Promise.all([
      call(runtime, "write", { path: "/workspace/a.txt", text: "one" }),
      call(runtime, "write", { path: "/workspace/b.txt", text: "two" }),
    ]);

    expect(results.map((result) => result.sandbox?.state).sort()).toEqual(["created", "reused"]);
    expect(provider.conflicts).toHaveLength(1);
    const [entry] = [...provider.store.values()];
    expect(provider.store.size).toBe(1);
    expect([...entry!.mock.files.keys()].sort()).toEqual(["/workspace/a.txt", "/workspace/b.txt"]);
  });

  it("keeps a sandbox a call resumed between the sweep's listing and its delete", async () => {
    const provider = createNamedProvider();
    const runtime = runtimeWith([writeTool, readTool], provider.registry);
    await call(runtime, "write", { path: "/workspace/a.txt", text: "still here" });
    provider.expireAll();
    provider.afterList(async () => {
      await call(runtime, "read", { path: "/workspace/a.txt" });
      provider.expireAll();
    });

    expect((await provider.sweep()).deleted).toEqual([]);
    expect(await call(runtime, "read", { path: "/workspace/a.txt" })).toMatchObject({
      output: "still here",
      sandbox: { state: "resumed" },
    });
  });

  it("makes a call that arrives mid-delete wait, then create a fresh sandbox", async () => {
    const provider = createNamedProvider();
    const runtime = runtimeWith([writeTool, readTool], provider.registry);
    await call(runtime, "write", { path: "/workspace/a.txt", text: "old" });
    provider.expireAll();
    const paused = provider.pauseNextDelete();

    const sweep = provider.sweep();
    await paused.reached;
    const findsBefore = provider.finds;
    const arriving = call(runtime, "write", { path: "/workspace/b.txt", text: "new" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(provider.finds).toBe(findsBefore);
    paused.release();

    const [result, written] = await Promise.all([sweep, arriving]);
    expect(result.deleted).toHaveLength(1);
    expect(written).toMatchObject({ sandbox: { state: "created" }, status: "completed" });
    expect(await call(runtime, "read", { path: "/workspace/b.txt" })).toMatchObject({
      output: "new",
      sandbox: { state: "reused" },
    });
  });

  it("keeps a sandbox a call in this process holds, even when the provider record looks idle", async () => {
    const provider = createNamedProvider();
    const opened = Promise.withResolvers<void>();
    const mayFinish = Promise.withResolvers<void>();
    const hold = tool("hold", async (_input, ctx) => {
      const sandbox = await ctx.getSandbox();
      opened.resolve();
      await mayFinish.promise;
      return await sandbox.readTextFile({ path: "/workspace/a.txt" });
    });
    const runtime = runtimeWith([writeTool, hold], provider.registry);
    await call(runtime, "write", { path: "/workspace/a.txt", text: "held" });
    const held = call(runtime, "hold", {});
    await opened.promise;
    // The provider record now looks idle, so only the in-process lease keeps it.
    provider.expireAll();

    const result = await provider.sweep();
    mayFinish.resolve();

    expect(result.deleted).toEqual([]);
    expect(await held).toMatchObject({ output: "held", status: "completed" });
  });

  it("returns a throwing validator's error as generic with its error id, but schema failures verbatim", async () => {
    const execute = vi.fn();
    const runtime = runtimeWith([
      tool("throws", execute, {
        inputSchema: jsonSchema(
          { type: "object" },
          {
            validate: () => {
              throw new Error("vault lookup failed: token=sk_live_secret at 10.1.2.3");
            },
          },
        ),
      }),
      tool("rejects", execute, {
        inputSchema: jsonSchema(
          { type: "object" },
          { validate: () => ({ error: new Error("path: expected a string"), success: false }) },
        ),
      }),
    ]);

    const threw = await call(runtime, "throws", {});
    expect(threw.status).toBe("failed");
    if (threw.status !== "failed") return;
    expect(threw.errorId).toBeTruthy();
    expect(threw.message).toBe(
      `Tool "throws" failed: input validation failed. The error is logged with id ${threw.errorId}.`,
    );
    expect(JSON.stringify(threw)).not.toMatch(/sk_live_secret|10\.1\.2\.3|vault/);

    expect(await call(runtime, "rejects", {})).toEqual({
      message: 'Invalid input for tool "rejects": path: expected a string',
      status: "invalid-input",
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("returns an unexpected error as a generic message with the error id it logged", async () => {
    const runtime = runtimeWith([
      tool("boom", () => {
        throw new Error("connect ECONNREFUSED 10.0.0.7:5432 password=hunter2");
      }),
    ]);

    const result = await call(runtime, "boom", {});

    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.errorId).toBeTruthy();
    expect(result.message).toBe(
      `Tool "boom" failed: tool execution failed. The error is logged with id ${result.errorId}.`,
    );
    expect(result.message).not.toContain("hunter2");
    expect(result.message).not.toContain("10.0.0.7");
  });
});
