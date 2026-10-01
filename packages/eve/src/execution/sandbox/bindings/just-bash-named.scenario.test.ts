import { describe, expect, it } from "vitest";

import { createJustBashSandboxProvider } from "#execution/sandbox/bindings/just-bash.js";
import {
  getNamedSandboxSessions,
  SandboxNameConflictError,
} from "#execution/sandbox/named-sessions.js";
import { createSandboxProviderHost } from "#execution/sandbox/provider-host.js";
import { createSandboxProviderHarness } from "#internal/testing/sandbox-provider-harness.js";
import { useTemporaryDirectories } from "#internal/testing/use-temporary-app-roots.js";

const createScratchDirectory = useTemporaryDirectories();
const tag = { key: "eve", value: "tool-session" };

async function setup() {
  const appRoot = await createScratchDirectory("eve-just-bash-named-");
  const implementation = createJustBashSandboxProvider();
  const artifact = await createSandboxProviderHarness(implementation, undefined).prepare({
    appRoot,
  });
  const named = getNamedSandboxSessions(implementation as never)!;
  const storage = { host: createSandboxProviderHost(appRoot), storagePath: appRoot };
  const context = {
    ...storage,
    session: {
      auth: { current: null, initiator: null },
      id: "ts_test",
      turn: { id: "call-1", sequence: 0 },
    },
  };
  return { artifact, context, named, storage };
}

describe("just-bash named sandbox sessions", () => {
  it("creates once, finds with files intact, lists, and deletes", async () => {
    const { artifact, context, named, storage } = await setup();
    const address = { name: "eve-ts-one", tag };

    expect(await named.find(context, artifact, address)).toBeNull();
    const created = await named.create(context, undefined, artifact, address);
    await created.sandbox.writeTextFile({ content: "kept", path: "notes.txt" });
    await expect(named.create(context, undefined, artifact, address)).rejects.toBeInstanceOf(
      SandboxNameConflictError,
    );

    const found = await named.find(context, artifact, address);
    expect(found?.running).toBe(false);
    expect(await found!.handle.sandbox.readTextFile({ path: "notes.txt" })).toBe("kept");

    const listed = await named.list(storage, tag);
    expect(listed).toEqual([
      { lastUsedAt: expect.any(Number), name: "eve-ts-one", running: false },
    ]);
    expect(await named.list(storage, { key: "eve", value: "other" })).toEqual([]);

    // A conditional delete keeps a sandbox used since the cutoff, or one a call holds.
    const lastUsedAt = listed[0]!.lastUsedAt;
    expect(await named.delete(storage, address, { idleBefore: lastUsedAt })).toBe(false);
    expect(
      await named.delete(storage, address, { idleBefore: lastUsedAt + 1, inUse: () => true }),
    ).toBe(false);
    expect(await named.delete(storage, address, { idleBefore: lastUsedAt + 1 })).toBe(true);
    expect(await named.find(context, artifact, address)).toBeNull();
    expect(await named.delete(storage, address)).toBe(false);
  });
});
