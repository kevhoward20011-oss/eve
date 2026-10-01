import { describe, expect, it } from "vitest";

import { createAgentDescriptionRouteArgs } from "#channel/agent-description.js";
import type { SessionAuthContext } from "#channel/types.js";
import { invokeToolInSession } from "#execution/tool-session/invoke.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import { loadToolSessionRuntime } from "#internal/nitro/routes/route-invoke-tool.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { defineTool } from "#tools/definition.js";

const alice: SessionAuthContext = {
  attributes: {},
  authenticator: "test",
  principalId: "alice",
  principalType: "user",
};

const NOT_INVOCABLE = "cannot be invoked outside a conversation";

describe("describe().invocable and invokeTool agree", () => {
  it("refuses exactly the tools describe() marks non-invocable, on a real compiled registry", async () => {
    const runtime = await createTestRuntime({
      agent: { name: "invocable-parity" },
      modules: [
        {
          loadNamespace: async () => ({
            default: defineTool({
              description: "Report the weather.",
              execute: () => "sunny",
              inputSchema: {},
            }),
          }),
          logicalPath: "tools/weather.ts",
        },
      ],
    });

    await runtime.run(async () => {
      const compiledArtifactsSource = createBundledRuntimeCompiledArtifactsSource();
      const description = await createAgentDescriptionRouteArgs(
        () => compiledArtifactsSource,
      ).describe();
      const toolRuntime = await loadToolSessionRuntime({
        callbackBaseUrl: "https://agent.example",
        compiledArtifactsSource,
      });

      const names = description.tools.map((tool) => tool.name);
      expect(names).toEqual(
        expect.arrayContaining(["bash", "read_file", "web_fetch", "weather", "write_file"]),
      );

      const refused: Record<string, boolean> = {};
      for (const tool of description.tools) {
        const result = await invokeToolInSession(toolRuntime, tool.name, {}, { auth: alice });
        refused[tool.name] = result.status === "failed" && result.message.includes(NOT_INVOCABLE);
        expect(refused[tool.name], tool.name).toBe(!tool.invocable);
      }
      expect(refused).toMatchObject({
        bash: true,
        read_file: true,
        weather: false,
        web_fetch: true,
        write_file: true,
      });
    });
  });
});
