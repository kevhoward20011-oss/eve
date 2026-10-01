import { describe, expect, it } from "vitest";

import { describeCompiledAgent } from "#channel/agent-description.js";
import type { SkillFileSource } from "#channel/skill-files.js";
import { compileFromMemory } from "#internal/testing/compile-from-memory.js";

const files: SkillFileSource = {
  async listFiles(skill) {
    return skill === "alpha" ? ["SKILL.md", "references/api.md"] : ["SKILL.md"];
  },
  async fileSize() {
    throw new Error("describe must not read skill files");
  },
  async readFile() {
    throw new Error("describe must not read skill files");
  },
};

async function compileDescribedAgent() {
  const { manifest } = await compileFromMemory({
    agent: { description: "Answers weather questions.", model: "openai/gpt-5.4" },
    model: "openai/gpt-5.4",
    name: "described-agent",
    skills: [
      { description: "Zulu skill.", name: "zulu" },
      { description: "Alpha skill.", name: "alpha" },
    ],
    tools: [
      {
        approval: () => true,
        execute: async () => "ok",
        inputSchema: { properties: { city: { type: "string" } }, type: "object" },
        name: "weather",
        outputSchema: { type: "string" },
      },
      { name: "lookup" },
    ],
  });
  return manifest;
}

describe("describeCompiledAgent", () => {
  it("carries only the caller-facing fields", async () => {
    const description = await describeCompiledAgent(await compileDescribedAgent(), files);

    expect(Object.keys(description).sort()).toEqual(["description", "name", "skills", "tools"]);
    expect(description.name).toBe("described-agent");
    expect(description.description).toBe("Answers weather questions.");
    for (const tool of description.tools) {
      expect(Object.keys(tool).sort()).toEqual(
        tool.outputSchema === undefined
          ? ["approval", "description", "inputSchema", "invocable", "name"]
          : ["approval", "description", "inputSchema", "invocable", "name", "outputSchema"],
      );
    }
    for (const skill of description.skills) {
      expect(Object.keys(skill).sort()).toEqual(["description", "files", "name"]);
    }
    expect(JSON.stringify(description)).not.toMatch(
      /appRoot|agentRoot|logicalPath|sourceId|owner|\/virtual\/eve-memory-app/,
    );
  });

  it("describes tools and skills sorted by name", async () => {
    const description = await describeCompiledAgent(await compileDescribedAgent(), files);
    const toolNames = description.tools.map((tool) => tool.name);

    expect(toolNames).toEqual([...toolNames].sort());
    expect(toolNames).toEqual(expect.arrayContaining(["load_skill", "lookup", "weather"]));
    expect(description.skills).toEqual([
      { description: "Alpha skill.", files: ["SKILL.md", "references/api.md"], name: "alpha" },
      { description: "Zulu skill.", files: ["SKILL.md"], name: "zulu" },
    ]);
  });

  it("projects approval, schemas, and invocability from the compiled registry", async () => {
    const description = await describeCompiledAgent(await compileDescribedAgent(), files);
    const byName = new Map(description.tools.map((tool) => [tool.name, tool]));

    expect(byName.get("weather")).toEqual({
      approval: true,
      description: expect.any(String),
      inputSchema: { properties: { city: { type: "string" } }, type: "object" },
      invocable: true,
      name: "weather",
      outputSchema: { type: "string" },
    });
    expect(byName.get("lookup")).toMatchObject({ approval: false });
    for (const name of [
      "agent",
      "bash",
      "load_skill",
      "read_file",
      "web_fetch",
      "web_search",
      "write_file",
    ]) {
      expect(byName.get(name)).toMatchObject({ invocable: false });
    }
  });
});
