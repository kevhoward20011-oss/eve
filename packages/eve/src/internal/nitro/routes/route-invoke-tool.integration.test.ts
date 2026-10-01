import { describe, expect, it, vi } from "vitest";

import type { SessionAuthContext } from "#channel/types.js";
import { invokeToolInSession } from "#execution/tool-session/invoke.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import { loadToolSessionRuntime } from "#internal/nitro/routes/route-invoke-tool.js";
import { defineDynamic } from "#dynamic/definition.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { defineTool } from "#tools/definition.js";

const alice: SessionAuthContext = {
  attributes: {},
  authenticator: "test",
  principalId: "alice",
  principalType: "user",
};

describe("route invokeTool", () => {
  it("runs static tools from the compiled bundle and never runs dynamic resolvers", async () => {
    const resolver = vi.fn(() =>
      defineTool({
        description: "Only exists after a resolver runs.",
        execute: () => "dynamic",
        inputSchema: {},
      }),
    );
    const runtime = await createTestRuntime({
      agent: { name: "route-invoke-tool-static-only" },
      modules: [
        {
          loadNamespace: async () => ({
            default: defineTool({
              description: "Echo a greeting.",
              execute: () => "hello",
              inputSchema: {},
            }),
          }),
          logicalPath: "tools/greet.ts",
        },
        {
          loadNamespace: async () => ({
            default: defineDynamic({ events: { "session.started": resolver } }),
          }),
          logicalPath: "tools/late.ts",
        },
      ],
    });

    await runtime.run(async () => {
      const toolRuntime = await loadToolSessionRuntime({
        callbackBaseUrl: "https://agent.example",
        compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
      });
      const options = { auth: alice, key: "k" };

      expect(await invokeToolInSession(toolRuntime, "greet", {}, options)).toMatchObject({
        output: "hello",
        status: "completed",
      });
      expect(await invokeToolInSession(toolRuntime, "late", {}, options)).toMatchObject({
        message: 'The agent has no tool named "late".',
        status: "failed",
      });
    });
    expect(resolver).not.toHaveBeenCalled();
  });
});
