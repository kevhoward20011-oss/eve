import { expect, it } from "vitest";

import { createAgentDescriptionRouteArgs } from "#channel/agent-description.js";
import { invokeToolInSession } from "#execution/tool-session/invoke.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import { loadToolSessionRuntime } from "#internal/nitro/routes/route-invoke-tool.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { defineTool } from "#tools/definition.js";

const appTool = (logicalPath: string, output: string) => ({
  loadNamespace: async () => ({
    default: defineTool({ description: output, execute: () => output, inputSchema: {} }),
  }),
  logicalPath,
});

it("refuses exactly the tools describe() marks non-invocable on a compiled registry", async () => {
  const runtime = await createTestRuntime({
    agent: { name: "invocable-parity" },
    // An application tool that takes a framework tool's name is the application's.
    modules: [appTool("tools/weather.ts", "sunny"), appTool("tools/bash.ts", "app bash")],
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
    const auth = {
      attributes: {},
      authenticator: "test",
      principalId: "alice",
      principalType: "user",
    };

    const refused: Record<string, boolean> = {};
    for (const tool of description.tools) {
      const result = await invokeToolInSession(toolRuntime, tool.name, {}, { auth });
      refused[tool.name] =
        result.status === "failed" &&
        result.message.includes("cannot be invoked outside a conversation");
      expect(refused[tool.name], tool.name).toBe(!tool.invocable);
    }
    expect(refused).toMatchObject({
      bash: false,
      read_file: true,
      weather: false,
      web_fetch: true,
      write_file: true,
    });
  });
});
