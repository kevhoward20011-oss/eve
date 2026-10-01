import { describe, expect, it, vi } from "vitest";

import { createAgentDescriptionRouteArgs } from "#channel/agent-description.js";
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

const NOT_INVOCABLE = "cannot be invoked outside a conversation";

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

  it("refuses exactly the tools describe() marks non-invocable", async () => {
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
