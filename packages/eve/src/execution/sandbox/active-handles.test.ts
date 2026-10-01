import { afterEach, describe, expect, it, vi } from "vitest";

import {
  shutdownActiveSandboxHandles,
  trackActiveSandboxHandle,
  untrackActiveSandboxHandle,
} from "#execution/sandbox/active-handles.js";

afterEach(async () => {
  await shutdownActiveSandboxHandles();
});

describe("shutdownActiveSandboxHandles", () => {
  it("shuts down every tracked handle and clears the registry", async () => {
    const first = { onRuntimeShutdown: vi.fn(async () => {}) };
    const second = { onRuntimeShutdown: vi.fn(async () => {}) };
    trackActiveSandboxHandle({ providerName: "docker", handle: first, sessionId: "session-1" });
    trackActiveSandboxHandle({ providerName: "docker", handle: second, sessionId: "session-2" });

    await shutdownActiveSandboxHandles();
    await shutdownActiveSandboxHandles();

    expect(first.onRuntimeShutdown).toHaveBeenCalledTimes(1);
    expect(second.onRuntimeShutdown).toHaveBeenCalledTimes(1);
  });

  it("replaces the tracked handle when the same session is reopened", async () => {
    const stale = { onRuntimeShutdown: vi.fn(async () => {}) };
    const fresh = { onRuntimeShutdown: vi.fn(async () => {}) };
    trackActiveSandboxHandle({ providerName: "docker", handle: stale, sessionId: "session-1" });
    trackActiveSandboxHandle({ providerName: "docker", handle: fresh, sessionId: "session-1" });

    await shutdownActiveSandboxHandles();

    expect(stale.onRuntimeShutdown).not.toHaveBeenCalled();
    expect(fresh.onRuntimeShutdown).toHaveBeenCalledTimes(1);
  });

  it("tracks the same session key on different providers separately", async () => {
    const docker = { onRuntimeShutdown: vi.fn(async () => {}) };
    const vercel = { onRuntimeShutdown: vi.fn(async () => {}) };
    trackActiveSandboxHandle({ providerName: "docker", handle: docker, sessionId: "session-1" });
    trackActiveSandboxHandle({ providerName: "vercel", handle: vercel, sessionId: "session-1" });

    await shutdownActiveSandboxHandles();

    expect(docker.onRuntimeShutdown).toHaveBeenCalledTimes(1);
    expect(vercel.onRuntimeShutdown).toHaveBeenCalledTimes(1);
  });

  it("logs a failed shutdown and still shuts down the remaining handles", async () => {
    const failing = {
      onRuntimeShutdown: vi.fn(async () => {
        throw new Error("provider unreachable");
      }),
    };
    const healthy = { onRuntimeShutdown: vi.fn(async () => {}) };
    trackActiveSandboxHandle({ providerName: "docker", handle: failing, sessionId: "session-1" });
    trackActiveSandboxHandle({ providerName: "docker", handle: healthy, sessionId: "session-2" });
    const log = vi.fn();

    await expect(shutdownActiveSandboxHandles({ log })).resolves.toBeUndefined();

    expect(healthy.onRuntimeShutdown).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("provider unreachable"));
  });

  it("untracks a deleted handle but keeps one that replaced it", async () => {
    const deleted = { onRuntimeShutdown: vi.fn(async () => {}) };
    const replaced = { onRuntimeShutdown: vi.fn(async () => {}) };
    const current = { onRuntimeShutdown: vi.fn(async () => {}) };
    trackActiveSandboxHandle({ providerName: "docker", handle: deleted, sessionId: "session-1" });
    untrackActiveSandboxHandle({ providerName: "docker", handle: deleted, sessionId: "session-1" });
    trackActiveSandboxHandle({ providerName: "docker", handle: replaced, sessionId: "session-2" });
    trackActiveSandboxHandle({ providerName: "docker", handle: current, sessionId: "session-2" });
    // The older handle for session-2 is gone already; untracking it must not drop the newer one.
    untrackActiveSandboxHandle({
      providerName: "docker",
      handle: replaced,
      sessionId: "session-2",
    });

    await shutdownActiveSandboxHandles();

    expect(deleted.onRuntimeShutdown).not.toHaveBeenCalled();
    expect(replaced.onRuntimeShutdown).not.toHaveBeenCalled();
    expect(current.onRuntimeShutdown).toHaveBeenCalledTimes(1);
  });
});
