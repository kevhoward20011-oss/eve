import { jsonSchema } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Approval, ApprovalPolicy } from "#approval/definition.js";
import type { InvokeToolOptions } from "#channel/invoke-tool.js";
import type { SessionAuthContext } from "#channel/types.js";
import { ConnectionAuthorizationRequiredError } from "#connections/errors.js";
import { shutdownActiveSandboxHandles } from "#execution/sandbox/active-handles.js";
import { createToolExecuteWithAuth } from "#execution/tool-auth.js";
import {
  invokeToolInSession,
  type ToolSessionManifest,
  type ToolSessionRuntime,
} from "#execution/tool-session/invoke.js";
import {
  sweepToolSessionSandboxes,
  TOOL_SESSION_SANDBOX_EXPIRY_MS,
  ToolSessionSandboxPersistenceError,
} from "#execution/tool-session/sandbox.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import { mockSandbox, type MockSandbox } from "#internal/testing/mocks/mock-sandbox.js";
import { defineState } from "#public/definitions/state.js";
import { defineSandbox } from "#public/definitions/sandbox.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import type { RuntimeSandboxRegistry } from "#runtime/sandbox/registry.js";
import type { AuthorizationDefinition } from "#shared/connection-types.js";
import {
  defineSandboxProvider,
  type SandboxProviderHandle,
  type SandboxProviderImplementation,
} from "#shared/sandbox-provider.js";
import {
  SandboxNameConflictError,
  type SandboxProviderNamedSessions,
  withNamedSandboxSessions,
} from "#execution/sandbox/named-sessions.js";
import type { ToolContext } from "#tools/definition.js";
import { defineJsonSchema } from "#tools/schema.js";

vi.mock("#runtime/sandbox/prepared-artifacts.js", () => ({
  loadSandboxPreparedArtifact: vi.fn(async () => ({ snapshotId: "template-1" })),
}));

afterEach(() => shutdownActiveSandboxHandles());

const alice = principal("alice");
const bob = principal("bob");
const gateway = principal("gateway", "service");

function principal(id: string, type = "user"): SessionAuthContext {
  return { attributes: {}, authenticator: "test", principalId: id, principalType: type };
}

// ---------------------------------------------------------------------------
// In-memory provider with named sandboxes and a non-atomic get-then-create.
// ---------------------------------------------------------------------------

interface StoredSandbox {
  deleted?: boolean;
  lastUsedAt: number;
  readonly mock: MockSandbox;
  running: boolean;
  readonly tag: string;
}

function createNamedProvider(options: { readonly named?: boolean } = {}) {
  const store = new Map<string, StoredSandbox>();
  const events: string[] = [];
  let findBarrier: { count: number; release: () => void; wait: Promise<void> } | undefined;
  let now = 1_000;

  // A handle stops working once stopped, like a provider session that ended.
  const handle = (name: string, stored: StoredSandbox): SandboxProviderHandle => {
    let stopped = false;
    const session = new Proxy(stored.mock.session, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          if (stopped) throw new Error(`stale handle for ${name}`);
          if (stored.deleted === true) throw new Error(`sandbox ${name} was deleted`);
          return value.apply(target, args);
        };
      },
    });
    return {
      sandbox: session,
      async onRuntimeShutdown() {
        events.push(`shutdown:${name}`);
      },
      async onSessionDelete() {
        events.push(`delete:${name}`);
        stored.deleted = true;
        store.delete(name);
      },
      async onSessionStop() {
        events.push(`stop:${name}`);
        stopped = true;
        stored.running = false;
      },
    };
  };
  const started: string[] = [];
  let onList: (() => Promise<void>) | undefined;
  // Runs between a delete's idle check and the deletion, like a provider's
  // later lookups and requests; nothing re-checks after it.
  let beforeDelete: (() => Promise<void>) | undefined;

  const provider = defineSandboxProvider({
    name: "memory-named",
    environment: () => {
      const implementation: SandboxProviderImplementation<undefined, null, null> = {
        async prepare() {
          return null;
        },
        async resume() {
          throw new Error("tool sessions never resume from persisted state");
        },
        // Like Docker: the sandbox derives from the session id, and a start with
        // an id that already has one reuses it.
        async start(context) {
          started.push(context.session.id);
          const name = `unnamed:${context.session.id}`;
          let stored = store.get(name);
          if (stored === undefined) {
            stored = {
              lastUsedAt: now,
              mock: mockSandbox({ id: context.session.id }),
              running: true,
              tag: "",
            };
            store.set(name, stored);
          }
          return { handle: handle(name, stored), state: null };
        },
      };
      const named: SandboxProviderNamedSessions<undefined, null> | undefined =
        options.named === false
          ? undefined
          : {
              async create(context, _options, _artifact, { name, tag }) {
                // The name check and insert are atomic; the caller's find before it is not.
                if (store.has(name)) {
                  events.push(`conflict:${name}`);
                  throw new SandboxNameConflictError(name);
                }
                const stored: StoredSandbox = {
                  lastUsedAt: now,
                  mock: mockSandbox({ id: context.session.id }),
                  running: true,
                  tag: `${tag.key}:${tag.value}`,
                };
                store.set(name, stored);
                events.push(`create:${name}`);
                return handle(name, stored);
              },
              async delete(_context, { name }, condition) {
                const stored = store.get(name);
                if (stored === undefined) return false;
                if (
                  condition !== undefined &&
                  (stored.running ||
                    stored.lastUsedAt >= condition.idleBefore ||
                    condition.inUse?.() === true)
                ) {
                  events.push(`kept:${name}`);
                  return false;
                }
                const pause = beforeDelete;
                beforeDelete = undefined;
                await pause?.();
                events.push(`swept:${name}`);
                stored.deleted = true;
                store.delete(name);
                return true;
              },
              async find(_context, _artifact, { name }) {
                events.push(`find:${name}`);
                const barrier = findBarrier;
                if (barrier !== undefined) {
                  barrier.count -= 1;
                  if (barrier.count === 0) barrier.release();
                  await barrier.wait;
                }
                const stored = store.get(name);
                if (stored === undefined) return null;
                const running = stored.running;
                stored.running = true;
                stored.lastUsedAt = now;
                return { handle: handle(name, stored), running };
              },
              async list(_context, tag) {
                const summaries = [...store.entries()]
                  .filter(([, stored]) => stored.tag === `${tag.key}:${tag.value}`)
                  .map(([name, stored]) => ({
                    lastUsedAt: stored.lastUsedAt,
                    name,
                    running: stored.running,
                  }));
                // Whatever runs here happens after the listing and before any delete.
                await onList?.();
                return summaries;
              },
            };
      return named === undefined ? implementation : withNamedSandboxSessions(implementation, named);
    },
  });
  const environment = provider.environment();
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
    events,
    registry,
    started,
    store,
    /** Holds every `find` until `count` of them are in flight, once. */
    holdFinds(count: number) {
      let release!: () => void;
      const wait = new Promise<void>((resolve) => {
        release = resolve;
      });
      findBarrier = {
        count,
        release: () => {
          findBarrier = undefined;
          release();
        },
        wait,
      };
    },
    advance(ms: number) {
      now += ms;
    },
    /** Holds the next delete after its idle check until `release()`. */
    pauseNextDelete() {
      let reached!: () => void;
      let release!: () => void;
      const reachedPromise = new Promise<void>((resolve) => {
        reached = resolve;
      });
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      beforeDelete = async () => {
        reached();
        await released;
      };
      return { reached: reachedPromise, release };
    },
    /** Runs `fn` once, after the sweep lists sandboxes and before it deletes any. */
    afterList(fn: () => Promise<void>) {
      onList = async () => {
        onList = undefined;
        await fn();
      };
    },
    /** Simulates the provider stopping idle sandboxes. */
    stopAll() {
      for (const stored of store.values()) stored.running = false;
    },
    get now() {
      return now;
    },
  };
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

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
  // A stand-in compiled manifest of application tools; framework and handled
  // tools are refused on a real compiled registry in route-invoke-tool.integration.
  const manifest: ToolSessionManifest = {
    bindings: Object.fromEntries(
      tools.map((definition) => [`source:${definition.name}`, { owner: { kind: "application" } }]),
    ),
    tools: tools.map((definition) => ({
      hasExecute: definition.execute !== undefined,
      name: definition.name,
      sourceId: `source:${definition.name}`,
    })),
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

// ---------------------------------------------------------------------------

describe("invokeTool: context", () => {
  it("runs the tool with a stand-in turn, the caller, and the tool session id", async () => {
    const seen: ToolContext[] = [];
    const runtime = runtimeWith([
      tool("whoami", (_input, ctx) => {
        seen.push(ctx);
        return "ok";
      }),
    ]);

    const result = await call(runtime, "whoami", {}, { callId: "call-7" });

    expect(result).toEqual({
      modelOutput: { type: "text", value: "ok" },
      output: "ok",
      status: "completed",
    });
    const ctx = seen[0]!;
    expect(ctx.session.id).toMatch(/^ts_[0-9a-f]{64}$/);
    expect(ctx.session.turn).toEqual({ id: "call-7", sequence: 0 });
    expect(ctx.session.parent).toBeUndefined();
    expect(ctx.session.auth).toEqual({ current: alice, initiator: alice });
    expect(ctx.callId).toBe("call-7");
  });

  it("uses the asserted initiator when present", async () => {
    const seen: ToolContext[] = [];
    const runtime = runtimeWith([tool("whoami", (_input, ctx) => void seen.push(ctx))]);

    await call(runtime, "whoami", {}, { initiator: bob });

    expect(seen[0]!.session.auth).toEqual({ current: alice, initiator: bob });
  });

  it("derives a different session for another user or forwarder with the same key", async () => {
    const ids: string[] = [];
    const runtime = runtimeWith([tool("whoami", (_input, ctx) => void ids.push(ctx.session.id))]);

    await call(runtime, "whoami", {});
    await call(runtime, "whoami", {});
    await call(runtime, "whoami", {}, { auth: bob });
    await call(runtime, "whoami", {}, { forwarder: gateway });
    await call(runtime, "whoami", {}, { key: "conversation-2" });

    expect(ids[0]).toBe(ids[1]);
    expect(new Set(ids).size).toBe(4);
  });

  it("mints a fresh one-off session per call unless the nonce is passed back", async () => {
    const ids: string[] = [];
    const runtime = runtimeWith([tool("whoami", (_input, ctx) => void ids.push(ctx.session.id))]);

    await call(runtime, "whoami", {}, { key: undefined });
    await call(runtime, "whoami", {}, { key: undefined });
    await call(runtime, "whoami", {}, { key: undefined, oneOffNonce: "n1" });
    await call(runtime, "whoami", {}, { key: undefined, oneOffNonce: "n1" });

    expect(new Set(ids).size).toBe(3);
    expect(ids[2]).toBe(ids[3]);
  });

  // Length limits are owned by id.test; these rows cover which option is validated.
  it.each([
    ["an empty key", { key: "" }, "tool session key"],
    ["an empty one-off nonce", { key: undefined, oneOffNonce: "" }, "one-off nonce"],
    [
      "an oversized one-off nonce",
      { key: undefined, oneOffNonce: "n".repeat(513) },
      "one-off nonce",
    ],
    ["a nonce beside a key, which is ignored", { key: "k", oneOffNonce: "" }, undefined],
  ] as const)("validates %s before running the tool", async (_label, options, refused) => {
    const execute = vi.fn();
    const runtime = runtimeWith([tool("t", execute)]);

    const result = await call(runtime, "t", {}, options);

    if (refused === undefined) {
      expect(result.status).toBe("completed");
      expect(execute).toHaveBeenCalledTimes(1);
      return;
    }
    expect(result).toMatchObject({
      message: expect.stringContaining(`The ${refused} must`),
      status: "invalid-input",
    });
    expect(execute).not.toHaveBeenCalled();
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

  it("fails clearly for a missing tool and one without an execute", async () => {
    const runtime = runtimeWith([
      { description: "no execute", inputSchema: objectSchema, name: "plain" },
    ]);

    expect(await call(runtime, "nope", {})).toMatchObject({
      message: 'The agent has no tool named "nope".',
      status: "failed",
    });
    expect(await call(runtime, "plain", {})).toMatchObject({
      message:
        'Tool "plain" cannot be invoked outside a conversation: it has no server-side execute.',
      status: "failed",
    });
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

  it("gives defineState its initial value and refuses updates, naming the tool", async () => {
    const counter = defineState("tool-session-test.counter", () => ({ count: 3 }));
    const runtime = runtimeWith([
      tool("read", () => counter.get()),
      tool("write", () => counter.update((value) => ({ count: value.count + 1 }))),
    ]);

    expect(await call(runtime, "read", {})).toMatchObject({
      output: { count: 3 },
      status: "completed",
    });
    const result = await call(runtime, "write", {});
    expect(result.status).toBe("failed");
    expect(result.status === "failed" && result.message).toContain(
      'Tool "write" cannot update state',
    );
  });

  it("runs two calls in the same session in parallel", async () => {
    let inFlight = 0;
    let peak = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runtime = runtimeWith([
      tool("slow", async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        if (inFlight === 2) release();
        await gate;
        inFlight -= 1;
        return "done";
      }),
    ]);

    const results = await Promise.all([call(runtime, "slow", {}), call(runtime, "slow", {})]);

    expect(peak).toBe(2);
    expect(results.map((result) => result.status)).toEqual(["completed", "completed"]);
  });
});

describe("invokeTool: approval", () => {
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

  it.each([
    [
      "asks without an answer, even for a callId seen before",
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

    const approved = await call(
      runtime,
      "deploy",
      {},
      { approval: { approved: true }, callId: "c1" },
    );
    expect(approved.status).toBe("completed");
    const retry = await call(runtime, "deploy", {}, { callId: "c1" });
    expect(retry.status).toBe("approval-required");
    expect(execute).toHaveBeenCalledTimes(1);
  });
});

function interactive(resume?: { verifier: string }): AuthorizationDefinition {
  return {
    async completeAuthorization() {
      return { token: "fresh" };
    },
    displayName: "Linear",
    async getToken() {
      throw new ConnectionAuthorizationRequiredError("linear");
    },
    principalType: "user",
    async startAuthorization() {
      return resume === undefined
        ? { challenge: { url: "https://idp.example/authorize" } }
        : { challenge: { url: "https://idp.example/authorize" }, resume };
    },
  };
}

describe("invokeTool: sign-in", () => {
  it("fails a strategy that returns resume state, naming the connection", async () => {
    const runtime = runtimeWith([
      tool("issues", async (_input, ctx) => {
        await ctx.getToken(interactive({ verifier: "pkce" }), { authKey: "linear" });
        return "never";
      }),
    ]);

    const result = await call(runtime, "issues", {});

    expect(result.status).toBe("failed");
    expect(result.status === "failed" && result.message).toMatch(
      /^Connection "[^"]+" cannot sign in/,
    );
    expect(result.status === "failed" && result.message).toContain("resume");
  });
});

const writeTool = tool("write", async (input: { path: string; text: string }, ctx) => {
  const sandbox = await ctx.getSandbox();
  await sandbox.writeTextFile({ content: input.text, path: input.path });
  return "written";
});
const readTool = tool("read", async (input: { path: string }, ctx) => {
  const sandbox = await ctx.getSandbox();
  return await sandbox.readTextFile({ path: input.path });
});

describe("invokeTool: sandbox", () => {
  it("opens no sandbox when the tool never asks for one", async () => {
    const provider = createNamedProvider();
    const runtime = runtimeWith([tool("pure", () => "x")], provider.registry);

    const result = await call(runtime, "pure", {});

    expect(result.sandbox).toBeUndefined();
    expect(provider.events).toEqual([]);
  });

  it("creates, reuses, then resumes one sandbox with a file surviving", async () => {
    const provider = createNamedProvider();
    const runtime = runtimeWith([writeTool, readTool], provider.registry);

    const created = await call(runtime, "write", { path: "/workspace/notes.txt", text: "hello" });
    expect(created.sandbox?.state).toBe("created");
    expect(created.sandbox?.ms).toEqual(expect.any(Number));

    const reused = await call(runtime, "read", { path: "/workspace/notes.txt" });
    expect(reused).toMatchObject({ output: "hello", sandbox: { state: "reused" } });

    provider.stopAll();
    const resumed = await call(runtime, "read", { path: "/workspace/notes.txt" });
    expect(resumed).toMatchObject({ output: "hello", sandbox: { state: "resumed" } });

    expect(provider.store.size).toBe(1);
    const [entry] = [...provider.store.values()];
    expect(entry!.tag).toBe("eve:tool-session");
  });

  it("gives another user's same key its own sandbox", async () => {
    const provider = createNamedProvider();
    const runtime = runtimeWith([writeTool, readTool], provider.registry);

    await call(runtime, "write", { path: "/workspace/a.txt", text: "alice's" });
    const bobs = await call(runtime, "read", { path: "/workspace/a.txt" }, { auth: bob });

    expect(bobs).toMatchObject({ output: null, sandbox: { state: "created" } });
    expect(provider.store.size).toBe(2);
  });

  it("converges concurrent first calls on one sandbox through the conflict retry", async () => {
    const provider = createNamedProvider();
    const runtime = runtimeWith([writeTool], provider.registry);
    provider.holdFinds(2);

    const results = await Promise.all([
      call(runtime, "write", { path: "/workspace/a.txt", text: "one" }),
      call(runtime, "write", { path: "/workspace/b.txt", text: "two" }),
    ]);

    expect(results.map((result) => result.status)).toEqual(["completed", "completed"]);
    expect(results.map((result) => result.sandbox?.state).sort()).toEqual(["created", "reused"]);
    expect(provider.store.size).toBe(1);
    expect(provider.events.filter((event) => event.startsWith("conflict:"))).toHaveLength(1);
    const [entry] = [...provider.store.values()];
    expect([...entry!.mock.files.keys()].sort()).toEqual(["/workspace/a.txt", "/workspace/b.txt"]);
  });

  it.each([
    [
      "deletes a one-off sandbox when the call completes",
      "write",
      undefined,
      { status: "completed" },
      0,
    ],
    [
      "deletes a one-off sandbox on approval-required",
      "guarded",
      undefined,
      { callId: "c1", oneOffNonce: expect.any(String), status: "approval-required" },
      0,
    ],
    [
      "deletes a one-off sandbox on authorization-required, returning the challenge",
      "signin",
      undefined,
      {
        callId: "c1",
        challenges: [{ challenge: { url: "https://idp.example/authorize" } }],
        oneOffNonce: expect.any(String),
        status: "authorization-required",
      },
      0,
    ],
    ["keeps a keyed sandbox after the call", "write", "conversation-1", { status: "completed" }, 1],
  ] as const)("%s", async (_label, name, key, expected, kept) => {
    const provider = createNamedProvider();
    const runtime = runtimeWith(
      [
        writeTool,
        tool(
          "guarded",
          async (_input, ctx) => {
            await ctx.getSandbox();
            return "x";
          },
          {
            // The policy opens the sandbox before deciding, so the call holds one to release.
            approval: async (ctx) => {
              await ctx.getSandbox();
              return "user-approval" as const;
            },
          },
        ),
        tool("signin", async (_input, ctx) => {
          await ctx.getSandbox();
          await ctx.getToken(interactive(), { authKey: "linear" });
        }),
      ],
      provider.registry,
    );

    const result = await call(
      runtime,
      name,
      { path: "/workspace/a.txt", text: "x" },
      { callId: "c1", key },
    );

    expect(result).toMatchObject({ ...expected, sandbox: { state: "created" } });
    expect(provider.store.size).toBe(kept);
  });

  it("refuses a keyed sandbox on a provider without named lookup, with a named error", async () => {
    const provider = createNamedProvider({ named: false });
    const runtime = runtimeWith([writeTool, tool("pure", () => "x")], provider.registry);

    const result = await call(runtime, "write", { path: "/workspace/a.txt", text: "x" });

    expect(result.status).toBe("failed");
    expect(result.status === "failed" && result.message).toBe(
      new ToolSessionSandboxPersistenceError("memory-named").message,
    );
    expect(provider.started).toEqual([]);
    // A keyed tool that never opens the sandbox is unaffected.
    expect((await call(runtime, "pure", {})).status).toBe("completed");
  });

  it.each([
    ["named", true],
    ["fallback", false],
  ] as const)(
    "gives concurrent one-off %s calls with one nonce their own sandboxes, so one ending deletes only its own",
    async (_kind, named) => {
      const provider = createNamedProvider({ named });
      let releaseSecond!: () => void;
      const secondMayFinish = new Promise<void>((resolve) => {
        releaseSecond = resolve;
      });
      let firstOpened!: () => void;
      const opened = new Promise<void>((resolve) => {
        firstOpened = resolve;
      });
      const runtime = runtimeWith(
        [
          tool("quick", async (_input, ctx) => {
            await (await ctx.getSandbox()).writeTextFile({ content: "1", path: "/workspace/q" });
            return "quick";
          }),
          tool("slow", async (_input, ctx) => {
            const sandbox = await ctx.getSandbox();
            await sandbox.writeTextFile({ content: "2", path: "/workspace/s" });
            firstOpened();
            await secondMayFinish;
            // Still usable after the other call ended and deleted its sandbox.
            return await sandbox.readTextFile({ path: "/workspace/s" });
          }),
        ],
        provider.registry,
      );

      // The same nonce derives the same tool session id for both calls.
      const slow = call(runtime, "slow", {}, { key: undefined, oneOffNonce: "nonce-1" });
      await opened;
      const quick = await call(runtime, "quick", {}, { key: undefined, oneOffNonce: "nonce-1" });
      releaseSecond();

      expect(quick).toMatchObject({ sandbox: { state: "created" }, status: "completed" });
      // The slower call's sandbox survived the faster call's release.
      expect(await slow).toMatchObject({ output: "2", status: "completed" });
      const creates = named
        ? provider.events.filter((event) => event.startsWith("create:"))
        : provider.started;
      expect(new Set(creates).size).toBe(2);
      expect(provider.events.filter((event) => event.startsWith("delete:"))).toHaveLength(2);
      expect(provider.store.size).toBe(0);
    },
  );

  it("tracks each one-off fallback sandbox for shutdown under its own identity", async () => {
    const provider = createNamedProvider({ named: false });
    let olderOpened!: () => void;
    const opened = new Promise<void>((resolve) => {
      olderOpened = resolve;
    });
    let finishOlder!: () => void;
    const olderMayFinish = new Promise<void>((resolve) => {
      finishOlder = resolve;
    });
    const runtime = runtimeWith(
      [
        tool("older", async (_input, ctx) => {
          await ctx.getSandbox();
          olderOpened();
          await olderMayFinish;
          return "older";
        }),
        writeTool,
      ],
      provider.registry,
    );

    const older = call(runtime, "older", {}, { key: undefined, oneOffNonce: "nonce-1" });
    await opened;
    // A newer call for the same logical session opens, finishes, and deletes its sandbox.
    await call(
      runtime,
      "write",
      { path: "/workspace/n", text: "n" },
      { key: undefined, oneOffNonce: "nonce-1" },
    );
    await shutdownActiveSandboxHandles();
    finishOlder();
    await older;

    const olderName = `unnamed:${provider.started[0]}`;
    expect(provider.events.filter((event) => event.startsWith("shutdown:"))).toEqual([
      `shutdown:${olderName}`,
    ]);
  });

  it("reopens the sandbox after stop(): get, stop, get, execute", async () => {
    const provider = createNamedProvider();
    const runtime = runtimeWith(
      [
        tool("cycle", async (_input, ctx) => {
          const first = await ctx.getSandbox();
          await first.writeTextFile({ content: "kept", path: "/workspace/k.txt" });
          await first.stop();
          const second = await ctx.getSandbox();
          return {
            fresh: second !== first,
            text: await second.readTextFile({ path: "/workspace/k.txt" }),
          };
        }),
      ],
      provider.registry,
    );

    const keyed = await call(runtime, "cycle", {});
    expect(keyed).toMatchObject({
      output: { fresh: true, text: "kept" },
      sandbox: { state: "created" },
      status: "completed",
    });
    expect(provider.store.size).toBe(1);

    const oneOff = await call(runtime, "cycle", {}, { key: undefined });
    expect(oneOff).toMatchObject({ output: { fresh: true, text: "kept" }, status: "completed" });
    expect(provider.store.size).toBe(1);
  });

  it("still deletes a one-off sandbox the tool stopped, without reopening it", async () => {
    const provider = createNamedProvider();
    const runtime = runtimeWith(
      [
        tool("stopper", async (_input, ctx) => {
          await (await ctx.getSandbox()).stop();
          return "stopped";
        }),
      ],
      provider.registry,
    );

    const result = await call(runtime, "stopper", {}, { key: undefined });

    expect(result.status).toBe("completed");
    expect(provider.store.size).toBe(0);
    expect(provider.events.filter((event) => event.startsWith("find:"))).toHaveLength(1);
  });

  it("drops a deleted one-off sandbox from shutdown tracking", async () => {
    const provider = createNamedProvider();
    const runtime = runtimeWith([writeTool], provider.registry);

    await call(runtime, "write", { path: "/workspace/a.txt", text: "x" }, { key: undefined });
    await call(runtime, "write", { path: "/workspace/a.txt", text: "x" }, { key: "kept" });
    await shutdownActiveSandboxHandles();

    const shutdowns = provider.events.filter((event) => event.startsWith("shutdown:"));
    // Only the keyed sandbox is still tracked; the deleted one-off is not retained.
    expect(shutdowns).toEqual([`shutdown:${[...provider.store.keys()][0]}`]);
  });
});

describe("sweepToolSessionSandboxes", () => {
  it("deletes tagged sandboxes unused past the expiry and keeps the rest", async () => {
    const provider = createNamedProvider();
    const runtime = runtimeWith(
      [tool("open", async (_input, ctx) => void (await ctx.getSandbox()))],
      provider.registry,
    );

    await call(runtime, "open", {}, { key: "old" });
    provider.advance(TOOL_SESSION_SANDBOX_EXPIRY_MS + 1);
    await call(runtime, "open", {}, { key: "fresh" });
    provider.stopAll();

    const result = await sweepToolSessionSandboxes({
      compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
      now: provider.now,
      registry: provider.registry,
    });

    expect(result.deleted).toHaveLength(1);
    expect(result.failed).toEqual([]);
    expect(provider.store.size).toBe(1);
  });

  it("keeps a sandbox a call resumed between the listing and the delete", async () => {
    const provider = createNamedProvider();
    const runtime = runtimeWith([writeTool, readTool], provider.registry);
    await call(runtime, "write", { path: "/workspace/a.txt", text: "still here" });
    provider.advance(TOOL_SESSION_SANDBOX_EXPIRY_MS + 1);
    provider.stopAll();
    // The listing sees an expired, stopped sandbox; then a call resumes it and the provider stops it again.
    provider.afterList(async () => {
      await call(runtime, "read", { path: "/workspace/a.txt" });
      provider.stopAll();
    });

    const result = await sweepToolSessionSandboxes({
      compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
      now: provider.now,
      registry: provider.registry,
    });

    expect(result.deleted).toEqual([]);
    expect(provider.events.some((event) => event.startsWith("kept:"))).toBe(true);
    expect(await call(runtime, "read", { path: "/workspace/a.txt" })).toMatchObject({
      output: "still here",
      sandbox: { state: "resumed" },
    });
  });

  it("makes a call that arrives mid-delete wait, then open a fresh sandbox instead of the one being deleted", async () => {
    const provider = createNamedProvider();
    const runtime = runtimeWith([writeTool, readTool], provider.registry);
    await call(runtime, "write", { path: "/workspace/a.txt", text: "old" });
    provider.advance(TOOL_SESSION_SANDBOX_EXPIRY_MS + 1);
    provider.stopAll();
    const paused = provider.pauseNextDelete();

    const sweep = sweepToolSessionSandboxes({
      compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
      now: provider.now,
      registry: provider.registry,
    });
    await paused.reached;
    // The sweep has checked the sandbox and is mid-delete; a call for it arrives now.
    const finds = provider.events.filter((event) => event.startsWith("find:")).length;
    const arriving = call(runtime, "write", { path: "/workspace/b.txt", text: "new" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(provider.events.filter((event) => event.startsWith("find:"))).toHaveLength(finds);
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
    let opened!: () => void;
    const isOpen = new Promise<void>((resolve) => {
      opened = resolve;
    });
    let finish!: () => void;
    const mayFinish = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const runtime = runtimeWith(
      [
        writeTool,
        tool("hold", async (_input, ctx) => {
          const sandbox = await ctx.getSandbox();
          opened();
          await mayFinish;
          return await sandbox.readTextFile({ path: "/workspace/a.txt" });
        }),
      ],
      provider.registry,
    );
    await call(runtime, "write", { path: "/workspace/a.txt", text: "held" });
    provider.advance(TOOL_SESSION_SANDBOX_EXPIRY_MS + 1);
    const held = call(runtime, "hold", {});
    await isOpen;
    // Make the provider's own record look expired, so only the lease protects it.
    for (const stored of provider.store.values()) {
      stored.running = false;
      stored.lastUsedAt = 0;
    }

    const result = await sweepToolSessionSandboxes({
      compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
      now: provider.now,
      registry: provider.registry,
    });
    finish();

    expect(result.deleted).toEqual([]);
    expect(await held).toMatchObject({ output: "held", status: "completed" });
    expect(provider.store.size).toBe(1);
  });

  it("reports providers that cannot list by tag", async () => {
    const provider = createNamedProvider({ named: false });

    const result = await sweepToolSessionSandboxes({
      compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
      registry: provider.registry,
    });

    expect(result.skipped).toContain('"memory-named"');
  });
});
