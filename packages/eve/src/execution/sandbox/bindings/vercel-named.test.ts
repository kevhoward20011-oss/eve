import { describe, expect, it, vi } from "vitest";

import { createVercelSandbox } from "#execution/sandbox/bindings/vercel.js";
import {
  getNamedSandboxSessions,
  SandboxNameConflictError,
} from "#execution/sandbox/named-sessions.js";

// Keep the credential fallback from reading a developer's Vercel CLI auth.
vi.mock("#compiled/@vercel/oidc/index.js", () => ({
  getVercelOidcToken: vi.fn(async () => {
    throw new Error("No ambient Vercel OIDC token in unit tests.");
  }),
}));

const tag = { key: "eve", value: "tool-session" };
const address = { name: "eve-ts-abc", tag };

function mockSandbox(name: string, status = "running") {
  return {
    name,
    runCommand: vi.fn(async () => ({
      exitCode: 0,
      stderr: vi.fn(async () => ""),
      stdout: vi.fn(async () => ""),
    })),
    status,
    tags: {},
    update: vi.fn(async () => undefined),
  };
}

function setup(sandboxModule: object) {
  const implementation = createVercelSandbox({
    createOptions: { teamId: "team", projectId: "project", token: "token" },
    createSandbox: async ({ createOptions, sandboxModule: module }) =>
      await (module as any).Sandbox.create(createOptions),
    loadDeleteSandboxModule: async () => sandboxModule as never,
    loadSandboxModule: async () => sandboxModule as never,
  });
  const named = getNamedSandboxSessions(implementation as never);
  if (named === undefined) throw new Error("expected named sessions");
  const context = {
    host: {},
    log: { debug() {}, error() {}, info() {}, warn() {} },
    session: { id: "ts_abc" },
    storagePath: "/tmp/unused",
  } as never;
  return { context, named };
}

describe("Vercel named sandbox sessions", () => {
  it("creates with the tool-session tag and never gets first", async () => {
    const created = mockSandbox(address.name);
    const Sandbox = { create: vi.fn(async () => created), get: vi.fn(async () => null) };
    const { context, named } = setup({ Sandbox });

    await named.create(context, undefined, { snapshotId: "snap" }, address);

    expect(Sandbox.get).not.toHaveBeenCalled();
    expect(Sandbox.create).toHaveBeenCalledWith(
      expect.objectContaining({
        name: address.name,
        tags: expect.objectContaining({ eve: "tool-session", sessionId: "ts_abc" }),
      }),
    );
  });

  it("maps a 409 on create to SandboxNameConflictError", async () => {
    const conflict = Object.assign(new Error("Conflict"), { status: 409 });
    const Sandbox = {
      create: vi.fn(async () => {
        throw conflict;
      }),
      get: vi.fn(async () => null),
    };
    const { context, named } = setup({ Sandbox });

    await expect(
      named.create(context, undefined, { snapshotId: "snap" }, address),
    ).rejects.toBeInstanceOf(SandboxNameConflictError);
  });

  it("maps the API's 400 for a taken name to SandboxNameConflictError, but not other 400s", async () => {
    const taken = Object.assign(new Error("Status code 400 is not ok"), {
      json: {
        error: {
          code: "bad_request",
          message:
            "A sandbox with the name 'eve-ts-abc' already exists for this project. Use GET /sandboxes/:name to resume it or delete it first.",
        },
      },
      response: { status: 400 },
    });
    const invalid = Object.assign(new Error("Status code 400 is not ok: invalid runtime"), {
      response: { status: 400 },
    });
    const Sandbox = {
      create: vi.fn().mockRejectedValueOnce(taken).mockRejectedValueOnce(invalid),
      get: vi.fn(async () => null),
    };
    const { context, named } = setup({ Sandbox });

    await expect(
      named.create(context, undefined, { snapshotId: "snap" }, address),
    ).rejects.toBeInstanceOf(SandboxNameConflictError);
    await expect(
      named.create(context, undefined, { snapshotId: "snap" }, address),
    ).rejects.not.toBeInstanceOf(SandboxNameConflictError);
  });

  it("finds by name and reports whether it was already running", async () => {
    const stopped = mockSandbox(address.name, "stopped");
    const Sandbox = { create: vi.fn(), get: vi.fn(async () => stopped) };
    const { context, named } = setup({ Sandbox });

    const found = await named.find(context, { snapshotId: "snap" }, address);

    expect(found?.running).toBe(false);
    expect(Sandbox.get).toHaveBeenCalledWith(expect.objectContaining({ name: address.name }));
    expect(stopped.runCommand).toHaveBeenCalled();
  });

  it("lists by tag with the latest use time", async () => {
    const list = vi.fn(async () =>
      (async function* () {
        yield { name: "a", status: "stopped", statusUpdatedAt: 50, updatedAt: 20 };
        yield { name: "b", status: "running", updatedAt: 30 };
      })(),
    );
    const { context, named } = setup({ Sandbox: { list } });

    const summaries = await named.list(context, tag);

    expect(list).toHaveBeenCalledWith(expect.objectContaining({ tags: { eve: "tool-session" } }));
    expect(summaries).toEqual([
      { lastUsedAt: 50, name: "a", running: false },
      { lastUsedAt: 30, name: "b", running: true },
    ]);
  });

  it("re-reads before a conditional delete and keeps a sandbox used or resumed since", async () => {
    const recent = Object.assign(mockSandbox(address.name, "stopped"), {
      statusUpdatedAt: new Date(500),
      updatedAt: new Date(100),
    });
    const resumed = Object.assign(mockSandbox(address.name, "running"), {
      updatedAt: new Date(10),
    });
    const idle = Object.assign(mockSandbox(address.name, "stopped"), {
      delete: vi.fn(async () => undefined),
      updatedAt: new Date(10),
    });
    const Sandbox = {
      get: vi
        .fn()
        .mockResolvedValueOnce(recent)
        .mockResolvedValueOnce(resumed)
        .mockResolvedValue(idle),
    };
    const { context, named } = setup({ Sandbox });

    expect(await named.delete(context, address, { idleBefore: 200 })).toBe(false);
    expect(await named.delete(context, address, { idleBefore: 200 })).toBe(false);
    expect(await named.delete(context, address, { idleBefore: 200, inUse: () => true })).toBe(
      false,
    );
    expect(idle.delete).not.toHaveBeenCalled();
    expect(await named.delete(context, address, { idleBefore: 200 })).toBe(true);
    expect(idle.delete).toHaveBeenCalled();
  });

  it("re-checks at the final lookup, after the first check, before the delete request", async () => {
    const idle = () =>
      Object.assign(mockSandbox(address.name, "stopped"), {
        delete: vi.fn(async () => undefined),
        stop: vi.fn(async () => undefined),
        updatedAt: new Date(10),
      });
    // Passes the first check, then a call resumes it before the final lookup.
    const first = idle();
    const resumed = Object.assign(idle(), { status: "running" });
    // Passes the first check, then a call takes its lease before the final lookup.
    const second = idle();
    const finalIdle = idle();
    const Sandbox = {
      get: vi
        .fn()
        .mockResolvedValueOnce(first)
        .mockResolvedValueOnce(resumed)
        .mockResolvedValueOnce(second)
        .mockResolvedValueOnce(finalIdle),
    };
    const { context, named } = setup({ Sandbox });

    expect(await named.delete(context, address, { idleBefore: 200 })).toBe(false);
    let leased = false;
    const inUse = vi.fn(() => {
      const answer = leased;
      leased = true;
      return answer;
    });
    expect(await named.delete(context, address, { idleBefore: 200, inUse })).toBe(false);

    expect(inUse).toHaveBeenCalledTimes(2);
    for (const sandbox of [first, resumed, second, finalIdle]) {
      expect(sandbox.delete).not.toHaveBeenCalled();
      expect(sandbox.stop).not.toHaveBeenCalled();
    }
  });
});
