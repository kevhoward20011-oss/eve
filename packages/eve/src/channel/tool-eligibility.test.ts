import { describe, expect, it } from "vitest";

import { compiledToolOwner, isInvocableCompiledTool } from "#channel/tool-eligibility.js";
import type { AgentSourceOwner } from "#compiler/source-graph.js";
import { compileFromMemory } from "#internal/testing/compile-from-memory.js";
import type { CompiledToolBehavior } from "#tools/behavior.js";

describe("isInvocableCompiledTool over a compiled registry", () => {
  it("excludes framework tools and keeps application tools", async () => {
    const { manifest } = await compileFromMemory({
      model: "openai/gpt-5.4",
      tools: [{ name: "lookup" }, { execute: async () => "ok", name: "weather" }],
    });
    const invocable = Object.fromEntries(
      manifest.tools.map((tool) => [tool.name, isInvocableCompiledTool(manifest, tool)]),
    );

    expect(invocable).toMatchObject({
      agent: false,
      bash: false,
      load_skill: false,
      lookup: true,
      read_file: false,
      weather: true,
      web_fetch: false,
      web_search: false,
      write_file: false,
    });
    for (const tool of manifest.tools) {
      if (compiledToolOwner(manifest, tool).kind === "framework") {
        expect(invocable[tool.name], tool.name).toBe(false);
      }
    }
  });

  it("keeps an application tool that overrides a framework tool name", async () => {
    const { manifest } = await compileFromMemory({
      model: "openai/gpt-5.4",
      tools: [{ name: "bash" }],
    });
    const bash = manifest.tools.find((tool) => tool.name === "bash");

    expect(bash).toBeDefined();
    expect(compiledToolOwner(manifest, bash!)).toEqual({ kind: "application" });
    expect(isInvocableCompiledTool(manifest, bash!)).toBe(true);
  });

  it("throws for a tool with no source binding", () => {
    expect(() =>
      isInvocableCompiledTool(
        { bindings: {} },
        { hasExecute: true, name: "orphan", sourceId: "missing" },
      ),
    ).toThrow('Compiled tool "orphan" has no source binding.');
  });
});

describe("isInvocableCompiledTool", () => {
  const application: AgentSourceOwner = { kind: "application" };
  const framework: AgentSourceOwner = { feature: "eve:defaults", kind: "framework" };
  const extension: AgentSourceOwner = {
    kind: "extension",
    mountId: "/extensions/tools",
    namespace: "tools",
    packageName: "@acme/tools",
  };
  const withHandling = (handling: CompiledToolBehavior["handling"]): CompiledToolBehavior => ({
    availability: [],
    handling,
  });

  it.each([
    ["execute present", { hasExecute: true }, application, true],
    ["execute absent", { hasExecute: false }, application, false],
    [
      "behavior without handling",
      { behavior: { availability: [] }, hasExecute: true },
      application,
      true,
    ],
    [
      "dispatch handling",
      { behavior: withHandling({ action: "self-agent", kind: "dispatch" }), hasExecute: true },
      application,
      false,
    ],
    [
      "workflow-tool handling",
      {
        behavior: withHandling({ entryPoint: "execute", kind: "workflow-tool", workflowId: "w" }),
        hasExecute: true,
      },
      application,
      false,
    ],
    [
      "provider-tool handling",
      { behavior: withHandling({ kind: "provider-tool", provider: "exa" }), hasExecute: true },
      application,
      false,
    ],
    ["framework tool with execute", { hasExecute: true }, framework, false],
    ["extension tool with execute", { hasExecute: true }, extension, true],
  ] as const)("%s", (_label, tool, owner, expected) => {
    expect(
      isInvocableCompiledTool(
        { bindings: { "source:tool": { owner } } },
        { ...tool, name: "t", sourceId: "source:tool" },
      ),
    ).toBe(expected);
  });
});
