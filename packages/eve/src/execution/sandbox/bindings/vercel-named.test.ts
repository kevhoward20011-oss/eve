import { expect, it, vi } from "vitest";

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

const status = (code: number, message: string, json?: object) =>
  Object.assign(new Error(message), { json, response: { status: code } });

it.each([
  ["maps a 409 to a name conflict", Object.assign(new Error("Conflict"), { status: 409 }), true],
  [
    "maps the API's 400 for a taken name to a name conflict",
    status(400, "Status code 400 is not ok", {
      error: {
        code: "bad_request",
        message:
          "A sandbox with the name 'eve-ts-abc' already exists for this project. Use GET /sandboxes/:name to resume it or delete it first.",
      },
    }),
    true,
  ],
  ["keeps another 400 as is", status(400, "Status code 400 is not ok: invalid runtime"), false],
])("%s on create", async (_label, error, conflict) => {
  const Sandbox = { create: vi.fn().mockRejectedValue(error), get: vi.fn(async () => null) };
  const sandboxModule = { Sandbox } as never;
  const named = getNamedSandboxSessions(
    createVercelSandbox({
      createOptions: { teamId: "team", projectId: "project", token: "token" },
      createSandbox: async ({ createOptions }) => await Sandbox.create(createOptions),
      loadDeleteSandboxModule: async () => sandboxModule,
      loadSandboxModule: async () => sandboxModule,
    }) as never,
  )!;
  const context = { host: {}, session: { id: "ts_abc" }, storagePath: "/tmp/unused" } as never;
  const address = { name: "eve-ts-abc", tag: { key: "eve", value: "tool-session" } };

  const rejection = named.create(context, undefined, { snapshotId: "snap" }, address);

  if (conflict) await expect(rejection).rejects.toBeInstanceOf(SandboxNameConflictError);
  else await expect(rejection).rejects.not.toBeInstanceOf(SandboxNameConflictError);
});
