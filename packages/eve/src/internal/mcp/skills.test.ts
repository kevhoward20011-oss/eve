import { describe, expect, it } from "vitest";

import type { AgentDescription } from "#channel/agent-description.js";
import { MAX_SKILL_FILE_BYTES, SkillReadError } from "#channel/skill-files.js";
import { createMcpSkillsFeature } from "#internal/mcp/skills.js";
import { parseFrontmatter } from "#internal/helpers/gray-matter.js";
import { createMcpStreamableHttpServer } from "#internal/mcp/streamable-http-server.js";

type Files = Readonly<Record<string, string | Uint8Array>>;

const PROTOCOL = "2026-07-28";

function handler(skills: Readonly<Record<string, Files>>) {
  const describe = async (): Promise<AgentDescription> => ({
    name: "fixture",
    tools: [],
    skills: Object.entries(skills).map(([name, files]) => {
      return { name, description: "Catalog description.", files: Object.keys(files).sort() };
    }),
  });
  const readSkill = async (skill: string, path = "SKILL.md") => {
    const content = skills[skill]?.[path];
    if (content === undefined) throw new SkillReadError("unknown-file", path);
    if (content.length > MAX_SKILL_FILE_BYTES) throw new SkillReadError("too-large", path);
    return content;
  };
  const features = [createMcpSkillsFeature({ describe, readSkill })];
  const mcp = createMcpStreamableHttpServer({
    authenticate: async () => null,
    features,
    name: "eve-skills-test",
    version: "0.0.0",
  });
  return async (method: string, params: Record<string, unknown> = {}) => {
    const _meta = {
      "io.modelcontextprotocol/clientCapabilities": {},
      "io.modelcontextprotocol/clientInfo": { name: "skills-test", version: "0.0.0" },
      "io.modelcontextprotocol/protocolVersion": PROTOCOL,
    };
    const request = new Request("https://agent.example/eve/v1/mcp", {
      body: JSON.stringify({ id: 1, jsonrpc: "2.0", method, params: { ...params, _meta } }),
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "mcp-method": method,
        "mcp-protocol-version": PROTOCOL,
        ...(method === "resources/read" && { "mcp-name": String(params.uri) }),
      },
      method: "POST",
    });
    return (await (await mcp(request)).json()) as { result?: Record<string, any>; error?: object };
  };
}

/** Which of `names` each surface serves: skills/list, resources/list, get, read, directory. */
async function surfaces(call: ReturnType<typeof handler>, names: readonly string[]) {
  const listed = (await call("skills/list")).result?.skills.map((s: { uri: string }) => s.uri);
  const resources = (await call("resources/list")).result?.resources.map(
    (r: { uri: string }) => r.uri,
  );
  const served: Record<string, boolean[]> = {};
  for (const name of names) {
    const root = `skill://${encodeURIComponent(name)}`;
    const entry = `${root}/SKILL.md`;
    served[name] = [
      listed.includes(entry),
      resources.includes(entry),
      (await call("skills/get", { uri: entry })).result !== undefined,
      (await call("resources/read", { uri: entry })).result !== undefined,
      (await call("resources/read", { uri: `${root}/notes.md` })).result !== undefined,
      (await call("resources/directory/read", { uri: root })).result !== undefined,
    ];
  }
  return served;
}

const doc = (name: string, description: string) => ({
  "SKILL.md": `---\nname: ${JSON.stringify(name)}\ndescription: ${JSON.stringify(description)}\n---\nBody\n`,
  "notes.md": "notes\n",
});
const max = "a".repeat(64);
const every = Array(6).fill(true);
const none = Array(6).fill(false);

describe("MCP skills (SEP-2640)", () => {
  it("serves a skill on every surface or none, by the Agent Skills frontmatter rules", async () => {
    // Without frontmatter, eve synthesizes name and description from the catalog.
    const served: Record<string, Files> = {
      a: doc("a", "x"),
      "a1-b2": doc("a1-b2", "Fine."),
      [max]: doc(max, "d".repeat(1024)),
      "multi-byte": doc("multi-byte", "é".repeat(1024)),
      synthesized: { "SKILL.md": "Body\n", "notes.md": "notes\n" },
    };
    const refused: Record<string, Files> = {
      Hello_World: doc("Hello_World", "Underscore."),
      "Upper-case": doc("Upper-case", "Capitals."),
      [`${max}a`]: doc(`${max}a`, "Name too long."),
      "-leading": doc("-leading", "Leading hyphen."),
      "double--hyphen": doc("double--hyphen", "Consecutive hyphens."),
      "blank-desc": doc("blank-desc", "   "),
      "long-desc": doc("long-desc", "d".repeat(1025)),
      Synth_Bad: { "SKILL.md": "Body\n", "notes.md": "notes\n" },
      broken: { "SKILL.md": "---\nname: broken\ndescription: [unclosed\n---\n", "notes.md": "n" },
      binary: { "SKILL.md": new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00]), "notes.md": "n" },
      oversize: {
        "SKILL.md": `---\nname: oversize\ndescription: x\n---\n${"y".repeat(MAX_SKILL_FILE_BYTES)}`,
        "notes.md": "n",
      },
    };
    const call = handler({ ...served, ...refused });
    const result = await surfaces(call, [...Object.keys(served), ...Object.keys(refused)]);
    for (const name of Object.keys(served)) expect(result[name], name).toEqual(every);
    for (const name of Object.keys(refused)) expect(result[name], name).toEqual(none);
  });

  it("drops a skill whose servable files together pass 16 MiB, and lists files under the cap only", async () => {
    // 33 files at the per-file cap: each is servable, together they pass 16 MiB.
    const bulky: Record<string, string> = { ...doc("bulky", "Too much."), "notes.md": "n" };
    for (let index = 0; index < 33; index += 1) {
      bulky[`data/part-${index}.txt`] = "z".repeat(MAX_SKILL_FILE_BYTES);
    }
    const call = handler({
      bulky,
      fine: { ...doc("fine", "Fine."), "huge.md": "x".repeat(MAX_SKILL_FILE_BYTES + 1) },
    });
    expect(await surfaces(call, ["bulky", "fine"])).toEqual({ bulky: none, fine: every });
    const [fine] = (await call("skills/list")).result!.skills;
    expect(fine.resources.map((r: { uri: string }) => r.uri)).toEqual([
      "skill://fine/SKILL.md",
      "skill://fine/notes.md",
    ]);
  });

  it("keeps __proto__ and other prototype-named frontmatter keys, matching the served document", async () => {
    const call = handler({
      protoish: {
        "SKILL.md":
          "---\nname: protoish\ndescription: Odd keys.\n__proto__:\n  polluted: true\nconstructor: kept\nmetadata:\n  __proto__: nested\n---\nBody\n",
      },
      renamed: { "SKILL.md": "---\n__proto__: top\ndescription: Needs a name.\n---\nBody\n" },
    });
    const listed: { uri: string; frontmatter: Record<string, any> }[] = (await call("skills/list"))
      .result?.skills;
    const [{ frontmatter: protoish }, { frontmatter: renamed }] = listed as [any, any];
    expect(Object.hasOwn(protoish, "__proto__")).toBe(true);
    expect([protoish.__proto__, protoish.constructor]).toEqual([{ polluted: true }, "kept"]);
    expect(Object.hasOwn(protoish.metadata, "__proto__")).toBe(true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.hasOwn(renamed, "__proto__")).toBe(true);
    expect(renamed).toMatchObject({ description: "Needs a name.", name: "renamed" });

    for (const skill of listed) {
      const read = await call("resources/read", { uri: skill.uri });
      const served = parseFrontmatter(read.result?.contents[0].text).data;
      expect(Object.hasOwn(served, "__proto__"), skill.uri).toBe(true);
      expect(JSON.stringify(served), skill.uri).toBe(JSON.stringify(skill.frontmatter));
    }
  });
});
