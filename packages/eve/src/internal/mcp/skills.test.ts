import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { AgentDescription } from "#channel/agent-description.js";
import { MAX_SKILL_FILE_BYTES, SkillReadError } from "#channel/skill-files.js";
import {
  createMcpSkillsFeature,
  MCP_SKILLS_CACHE_HINT,
  MCP_SKILLS_EXTENSION,
  type McpSkillSource,
  parseSkillUri,
} from "#internal/mcp/skills.js";
import { parseFrontmatter } from "#internal/helpers/gray-matter.js";
import { createMcpStreamableHttpServer } from "#internal/mcp/streamable-http-server.js";

const PROTOCOL_VERSION = "2026-07-28";

const TRIAGE_SKILL_MD = `---
name: usage-triage
description: Triage a usage spike.
license: Apache-2.0
metadata:
  version: "2.1.0"
allowed-tools: query_usage
x-custom:
  - 1
  - true
---
# Usage triage

Read references/runbook.md.
`;

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d, 0x0a, 0x1a]);

interface FakeSkill {
  readonly description: string;
  readonly files: Readonly<Record<string, string | Uint8Array>>;
}

/** A describe/readSkill pair over in-memory files, with readSkill's contract. */
function fakeSource(skills: Readonly<Record<string, FakeSkill>>): McpSkillSource & {
  readonly reads: string[];
} {
  const reads: string[] = [];
  return {
    reads,
    async describe(): Promise<AgentDescription> {
      return {
        name: "fixture",
        tools: [],
        skills: Object.entries(skills).map(([name, skill]) => ({
          name,
          description: skill.description,
          files: Object.keys(skill.files).sort(),
        })),
      };
    },
    async readSkill(skill, path = "SKILL.md") {
      reads.push(`${skill}:${path}`);
      const entry = skills[skill];
      if (entry === undefined) throw new SkillReadError("unknown-skill", skill);
      if (path.split("/").some((segment) => segment === ".." || segment === "")) {
        throw new SkillReadError("invalid-path", path);
      }
      const resolved =
        path.toLowerCase() === "skill.md"
          ? Object.keys(entry.files).find((file) => file.toLowerCase() === "skill.md")
          : path;
      const content = resolved === undefined ? undefined : entry.files[resolved];
      if (content === undefined) throw new SkillReadError("unknown-file", path);
      const size =
        typeof content === "string" ? new TextEncoder().encode(content).byteLength : content.length;
      if (size > MAX_SKILL_FILE_BYTES) throw new SkillReadError("too-large", path);
      return content;
    },
  };
}

const fixtureSkills: Readonly<Record<string, FakeSkill>> = {
  "usage-triage": {
    description: "Triage a usage spike.",
    files: {
      "SKILL.md": TRIAGE_SKILL_MD,
      "assets/chart.png": PNG_BYTES,
      "references/runbook.md": "# Runbook\n",
      "references/deep/notes.txt": "notes\n",
      "references/huge.md": "x".repeat(MAX_SKILL_FILE_BYTES + 1),
    },
  },
  // A flat or module skill: eve materializes SKILL.md without frontmatter.
  flat: {
    description: "A flat skill.",
    files: { "SKILL.md": "Do the flat thing.\n" },
  },
  // A package authored as skill.md whose frontmatter has no name.
  "lower-case": {
    description: "Lower-case entry.",
    files: { "skill.md": "---\ndescription: Lower-case entry.\nlicense: MIT\n---\nBody\n" },
  },
  // Entry file over the cap: the skill is not served at all.
  oversize: {
    description: "Too big.",
    files: {
      "SKILL.md": `---\nname: oversize\ndescription: x\n---\n${"y".repeat(MAX_SKILL_FILE_BYTES)}`,
    },
  },
};

function handler(source: McpSkillSource = fakeSource(fixtureSkills)) {
  const mcp = createMcpStreamableHttpServer({
    name: "eve-skills-test",
    version: "0.0.0",
    authenticate: async () => null,
    features: [createMcpSkillsFeature(source)],
  });
  let id = 0;
  return async (method: string, params: Record<string, unknown> = {}) => {
    id += 1;
    const headers: Record<string, string> = {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "mcp-method": method,
      "mcp-protocol-version": PROTOCOL_VERSION,
    };
    // SEP-2243: resources/read mirrors params.uri in Mcp-Name.
    if (method === "resources/read") headers["mcp-name"] = String(params.uri);
    const response = await mcp(
      new Request("https://agent.example/eve/v1/mcp", {
        body: JSON.stringify({
          id,
          jsonrpc: "2.0",
          method,
          params: {
            ...params,
            _meta: {
              "io.modelcontextprotocol/clientCapabilities": {},
              "io.modelcontextprotocol/clientInfo": { name: "skills-test", version: "0.0.0" },
              "io.modelcontextprotocol/protocolVersion": PROTOCOL_VERSION,
            },
          },
        }),
        headers,
        method: "POST",
      }),
    );
    const body = (await response.json()) as {
      readonly result?: Record<string, unknown>;
      readonly error?: { readonly code: number; readonly message: string; readonly data?: unknown };
    };
    return body;
  };
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value === null || typeof value !== "object") return value;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    Object.defineProperty(sorted, key, {
      enumerable: true,
      value: sortKeys((value as Record<string, unknown>)[key]),
    });
  }
  return sorted;
}

function sha256(content: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

describe("MCP skills (SEP-2640)", () => {
  it("declares the extension with directoryRead and the resources capability", async () => {
    const call = handler();
    const { result } = await call("server/discover");
    expect(result?.capabilities).toMatchObject({
      extensions: { [MCP_SKILLS_EXTENSION]: { directoryRead: true } },
      resources: { listChanged: true, subscribe: true },
    });
  });

  it("lists every served skill, sorted, with verbatim frontmatter, digests, sizes, and cache fields", async () => {
    const call = handler();
    const { result, error } = await call("skills/list");
    expect(error).toBeUndefined();
    expect(result?.ttlMs).toBe(MCP_SKILLS_CACHE_HINT.ttlMs);
    expect(result?.cacheScope).toBe(MCP_SKILLS_CACHE_HINT.cacheScope);
    const skills = result?.skills as { uri: string; frontmatter: unknown; resources: unknown }[];
    expect(skills.map((skill) => skill.uri)).toEqual([
      "skill://flat/SKILL.md",
      "skill://lower-case/SKILL.md",
      "skill://usage-triage/SKILL.md",
    ]);
    const triage = skills[2];
    expect(triage?.frontmatter).toEqual({
      name: "usage-triage",
      description: "Triage a usage spike.",
      license: "Apache-2.0",
      metadata: { version: "2.1.0" },
      "allowed-tools": "query_usage",
      "x-custom": [1, true],
    });
    // Complete, sorted, oversize supporting file left out.
    expect(triage?.resources).toEqual([
      {
        uri: "skill://usage-triage/SKILL.md",
        digest: sha256(TRIAGE_SKILL_MD),
        size: new TextEncoder().encode(TRIAGE_SKILL_MD).byteLength,
      },
      { uri: "skill://usage-triage/assets/chart.png", digest: sha256(PNG_BYTES), size: 8 },
      {
        uri: "skill://usage-triage/references/deep/notes.txt",
        digest: sha256("notes\n"),
        size: 6,
      },
      {
        uri: "skill://usage-triage/references/runbook.md",
        digest: sha256("# Runbook\n"),
        size: 10,
      },
    ]);
  });

  it("gives frontmatter-less and nameless entries frontmatter that matches the served SKILL.md", async () => {
    const call = handler();
    const { result } = await call("skills/get", { uri: "skill://flat/SKILL.md" });
    const skill = result?.skill as {
      frontmatter: unknown;
      resources: { digest: string; size: number }[];
    };
    expect(skill.frontmatter).toEqual({ name: "flat", description: "A flat skill." });

    const read = await call("resources/read", { uri: "skill://flat/SKILL.md" });
    const [contents] = (read.result?.contents ?? []) as { text: string; mimeType: string }[];
    expect(contents?.mimeType).toBe("text/markdown");
    expect(contents?.text).toMatch(/^---\n/);
    expect(contents?.text).toContain("Do the flat thing.\n");
    expect(sha256(contents?.text ?? "")).toBe(skill.resources[0]?.digest);

    const lower = await call("skills/get", { uri: "skill://lower-case/SKILL.md" });
    expect((lower.result?.skill as { frontmatter: unknown } | undefined)?.frontmatter).toEqual({
      name: "lower-case",
      description: "Lower-case entry.",
      license: "MIT",
    });
  });

  it("gets one skill and answers -32602 for anything that is not a served skill", async () => {
    const call = handler();
    const { result } = await call("skills/get", { uri: "skill://usage-triage/SKILL.md" });
    expect((result?.skill as { uri: string } | undefined)?.uri).toBe(
      "skill://usage-triage/SKILL.md",
    );
    expect(result?.ttlMs).toBeUndefined();

    for (const uri of [
      "skill://missing/SKILL.md",
      "skill://oversize/SKILL.md",
      "skill://usage-triage/references/runbook.md",
      "skill://usage-triage",
      "file:///etc/passwd",
    ]) {
      const { error } = await call("skills/get", { uri });
      expect(error?.code, uri).toBe(-32602);
    }
  });

  it("reads text as text and binary as base64 blob", async () => {
    const call = handler();
    const text = await call("resources/read", {
      uri: "skill://usage-triage/references/runbook.md",
    });
    expect(text.result?.contents).toEqual([
      {
        uri: "skill://usage-triage/references/runbook.md",
        mimeType: "text/markdown",
        text: "# Runbook\n",
      },
    ]);
    expect(text.result?.ttlMs).toBe(MCP_SKILLS_CACHE_HINT.ttlMs);
    expect(text.result?.cacheScope).toBe("private");

    const entry = await call("resources/read", { uri: "skill://usage-triage/SKILL.md" });
    expect((entry.result?.contents as { text: string }[] | undefined)?.[0]?.text).toBe(
      TRIAGE_SKILL_MD,
    );

    const binary = await call("resources/read", { uri: "skill://usage-triage/assets/chart.png" });
    expect(binary.result?.contents).toEqual([
      {
        uri: "skill://usage-triage/assets/chart.png",
        mimeType: "image/png",
        blob: Buffer.from(PNG_BYTES).toString("base64"),
      },
    ]);
  });

  it("refuses traversal, malformed URIs, and files over the cap", async () => {
    const source = fakeSource(fixtureSkills);
    const call = handler(source);
    for (const uri of [
      "skill://usage-triage/../flat/SKILL.md",
      "skill://usage-triage/references/../SKILL.md",
      "skill://usage-triage/references/%2E%2E/SKILL.md",
      "skill://usage-triage/references%2Frunbook.md",
      "skill://usage-triage/references%5Crunbook.md",
      "skill://usage-triage//SKILL.md",
      "skill://usage-triage/SKILL.md/",
      "skill://usage-triage/SKILL.md?x=1",
      "skill://usage-triage/SKILL.md#top",
      "skill://usage-triage/%E0%A4%A",
      "skill://usage-triage/skill.md",
      "skill://usage-triage/references",
      "skill://usage-triage/references/huge.md",
      "skill://oversize/SKILL.md",
      "skill://../SKILL.md",
      "skill:///SKILL.md",
    ]) {
      const { error } = await call("resources/read", { uri });
      expect(error?.code, uri).toBe(-32602);
    }
    // Rejected URIs never reach readSkill with a traversing path.
    expect(source.reads.some((read) => read.includes(".."))).toBe(false);
  });

  it("reads directories: root, subdirectory, nested; refuses files and unknown paths", async () => {
    const call = handler();
    const root = await call("resources/directory/read", { uri: "skill://usage-triage" });
    expect(root.result?.resources).toEqual([
      { uri: "skill://usage-triage/SKILL.md", name: "SKILL.md", mimeType: "text/markdown" },
      { uri: "skill://usage-triage/assets", name: "assets", mimeType: "inode/directory" },
      { uri: "skill://usage-triage/references", name: "references", mimeType: "inode/directory" },
    ]);

    const references = await call("resources/directory/read", {
      uri: "skill://usage-triage/references",
    });
    expect(references.result?.resources).toEqual([
      { uri: "skill://usage-triage/references/deep", name: "deep", mimeType: "inode/directory" },
      {
        uri: "skill://usage-triage/references/runbook.md",
        name: "runbook.md",
        mimeType: "text/markdown",
      },
    ]);

    const deep = await call("resources/directory/read", {
      uri: "skill://usage-triage/references/deep",
    });
    expect(deep.result?.resources).toEqual([
      {
        uri: "skill://usage-triage/references/deep/notes.txt",
        name: "notes.txt",
        mimeType: "text/plain",
      },
    ]);

    for (const uri of [
      "skill://usage-triage/SKILL.md",
      "skill://usage-triage/missing",
      "skill://usage-triage/references/",
      "skill://missing",
      "skill://oversize",
    ]) {
      const { error } = await call("resources/directory/read", { uri });
      expect(error?.code, uri).toBe(-32602);
    }
  });

  it("lists each served skill's SKILL.md in resources/list and no templates", async () => {
    const call = handler();
    const { result } = await call("resources/list");
    expect(result?.ttlMs).toBe(MCP_SKILLS_CACHE_HINT.ttlMs);
    expect(result?.resources).toEqual([
      expect.objectContaining({
        uri: "skill://flat/SKILL.md",
        name: "flat",
        description: "A flat skill.",
        mimeType: "text/markdown",
      }),
      expect.objectContaining({ uri: "skill://lower-case/SKILL.md", name: "lower-case" }),
      expect.objectContaining({
        uri: "skill://usage-triage/SKILL.md",
        name: "usage-triage",
        description: "Triage a usage spike.",
        size: new TextEncoder().encode(TRIAGE_SKILL_MD).byteLength,
      }),
    ]);
    const templates = await call("resources/templates/list");
    expect(templates.result?.resourceTemplates).toEqual([]);
  });

  it("rejects cursors, since lists are never paginated", async () => {
    const call = handler();
    const { error } = await call("skills/list", { cursor: "abc" });
    expect(error?.code).toBe(-32602);
  });

  it("serves the 2025 stateless fallback, where resources/subscribe accepts only served files", async () => {
    const mcp = createMcpStreamableHttpServer({
      name: "eve-skills-test",
      version: "0.0.0",
      authenticate: async () => null,
      features: [createMcpSkillsFeature(fakeSource(fixtureSkills))],
    });
    const legacy = async (method: string, params: Record<string, unknown>) => {
      const response = await mcp(
        new Request("https://agent.example/eve/v1/mcp", {
          body: JSON.stringify({ id: 1, jsonrpc: "2.0", method, params }),
          headers: {
            accept: "application/json, text/event-stream",
            "content-type": "application/json",
            "mcp-protocol-version": "2025-11-25",
          },
          method: "POST",
        }),
      );
      const data = (await response.text()).split("\n").find((line) => line.startsWith("data: "));
      return JSON.parse(data?.slice("data: ".length) ?? "{}") as {
        readonly result?: Record<string, unknown>;
        readonly error?: { readonly code: number };
      };
    };

    const initialized = await legacy("initialize", {
      capabilities: {},
      clientInfo: { name: "skills-test", version: "0.0.0" },
      protocolVersion: "2025-11-25",
    });
    expect(initialized.result?.capabilities).toMatchObject({
      extensions: { [MCP_SKILLS_EXTENSION]: { directoryRead: true } },
      resources: { listChanged: true, subscribe: true },
    });
    const subscribed = await legacy("resources/subscribe", { uri: "skill://flat/SKILL.md" });
    expect(subscribed).toMatchObject({ result: {} });
    for (const uri of [
      "skill://nope/SKILL.md",
      "skill://oversize/SKILL.md",
      "skill://usage-triage/references/huge.md",
      "https://example.com/x",
    ]) {
      expect((await legacy("resources/subscribe", { uri })).error?.code, uri).toBe(-32602);
    }
    const unsubscribed = await legacy("resources/unsubscribe", { uri: "skill://flat/SKILL.md" });
    expect(unsubscribed).toMatchObject({ result: {} });
    const listed = await legacy("skills/list", {});
    expect((listed.result?.skills as unknown[] | undefined)?.length).toBe(3);
    const read = await legacy("resources/read", { uri: "skill://usage-triage/../flat/SKILL.md" });
    expect(read.error?.code).toBe(-32602);
  });

  it("applies one eligibility rule on every surface: aggregate overflow and invalid entry documents", async () => {
    // 33 files at the per-file cap: each is servable, together they pass 16 MiB.
    const bulk: Record<string, string> = {
      "SKILL.md": "---\nname: bulky\ndescription: Too much in total.\n---\nBody\n",
    };
    for (let index = 0; index < 33; index += 1) {
      bulk[`data/part-${String(index).padStart(2, "0")}.txt`] = "z".repeat(MAX_SKILL_FILE_BYTES);
    }
    const source = fakeSource({
      ...fixtureSkills,
      bulky: { description: "Too much in total.", files: bulk },
      broken: {
        description: "Unparseable frontmatter.",
        files: {
          "SKILL.md": "---\nname: broken\ndescription: [unclosed\n---\nBody\n",
          "notes.md": "notes\n",
        },
      },
      binary: { description: "Binary entry.", files: { "SKILL.md": PNG_BYTES } },
    });
    const call = handler(source);
    const absent = ["bulky", "broken", "binary"];

    const listed = (await call("skills/list")).result?.skills as Array<{
      uri: string;
      resources: Array<{ uri: string; digest: string; size: number }>;
    }>;
    const resources = (await call("resources/list")).result?.resources as Array<{ uri: string }>;
    // Both lists name the same skills.
    expect(resources.map((entry) => entry.uri)).toEqual(listed.map((entry) => entry.uri));
    for (const name of absent) {
      const entry = `skill://${name}/SKILL.md`;
      expect(
        listed.some((skill) => skill.uri === entry),
        name,
      ).toBe(false);
      expect((await call("skills/get", { uri: entry })).error?.code, name).toBe(-32602);
      expect((await call("resources/read", { uri: entry })).error?.code, name).toBe(-32602);
      expect(
        (await call("resources/directory/read", { uri: `skill://${name}` })).error?.code,
        name,
      ).toBe(-32602);
    }
    for (const uri of ["skill://bulky/data/part-00.txt", "skill://broken/notes.md"]) {
      expect((await call("resources/read", { uri })).error?.code, uri).toBe(-32602);
    }

    // Every listed resource reads, at the digest and size skills/list reports.
    for (const skill of listed) {
      for (const resource of skill.resources) {
        const read = await call("resources/read", { uri: resource.uri });
        const [contents] = read.result?.contents as Array<{ text?: string; blob?: string }>;
        const bytes =
          contents?.text === undefined
            ? Buffer.from(contents?.blob ?? "", "base64")
            : Buffer.from(contents.text, "utf8");
        expect(sha256(bytes), resource.uri).toBe(resource.digest);
        expect(bytes.byteLength, resource.uri).toBe(resource.size);
      }
    }
  });

  it("keeps __proto__ and other prototype-named frontmatter keys, matching the served document", async () => {
    const authored =
      "---\nname: protoish\ndescription: Keeps odd keys.\n__proto__:\n  polluted: true\nconstructor: kept\nmetadata:\n  __proto__: nested\n---\nBody\n";
    const rewritten = "---\n__proto__: top\ndescription: Needs a name.\n---\nBody\n";
    const call = handler(
      fakeSource({
        protoish: { description: "Keeps odd keys.", files: { "SKILL.md": authored } },
        renamed: { description: "Needs a name.", files: { "SKILL.md": rewritten } },
      }),
    );
    const listed = (await call("skills/list")).result?.skills as Array<{
      uri: string;
      frontmatter: Record<string, unknown>;
    }>;
    const protoish = listed.find((skill) => skill.uri === "skill://protoish/SKILL.md")!;
    expect(Object.hasOwn(protoish.frontmatter, "__proto__")).toBe(true);
    expect(protoish.frontmatter.__proto__).toEqual({ polluted: true });
    expect(protoish.frontmatter.constructor).toBe("kept");
    expect(
      Object.hasOwn(protoish.frontmatter.metadata as Record<string, unknown>, "__proto__"),
    ).toBe(true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();

    const renamed = listed.find((skill) => skill.uri === "skill://renamed/SKILL.md")!;
    expect(Object.hasOwn(renamed.frontmatter, "__proto__")).toBe(true);
    expect(renamed.frontmatter).toMatchObject({ description: "Needs a name.", name: "renamed" });

    // The listing's frontmatter is exactly the served document's.
    for (const skill of [protoish, renamed]) {
      const read = await call("resources/read", { uri: skill.uri });
      const [contents] = read.result?.contents as Array<{ text: string }>;
      const served = parseFrontmatter(contents!.text).data as Record<string, unknown>;
      expect(JSON.stringify(sortKeys(skill.frontmatter))).toBe(JSON.stringify(sortKeys(served)));
      expect(Object.hasOwn(served, "__proto__")).toBe(true);
    }
  });

  it("acknowledges at most 100 resource subscriptions, and only served skill files", async () => {
    const mcp = createMcpStreamableHttpServer({
      name: "eve-skills-test",
      version: "0.0.0",
      authenticate: async () => null,
      features: [createMcpSkillsFeature(fakeSource(fixtureSkills))],
      listen: "ack-then-close",
    });
    const listen = async (notifications: Record<string, unknown>) => {
      const response = await mcp(
        new Request("https://agent.example/eve/v1/mcp", {
          body: JSON.stringify({
            id: 7,
            jsonrpc: "2.0",
            method: "subscriptions/listen",
            params: {
              notifications,
              _meta: {
                "io.modelcontextprotocol/clientCapabilities": {},
                "io.modelcontextprotocol/clientInfo": { name: "skills-test", version: "0.0.0" },
                "io.modelcontextprotocol/protocolVersion": PROTOCOL_VERSION,
              },
            },
          }),
          headers: {
            accept: "application/json, text/event-stream",
            "content-type": "application/json",
            "mcp-method": "subscriptions/listen",
            "mcp-protocol-version": PROTOCOL_VERSION,
          },
          method: "POST",
        }),
      );
      const text = await response.text();
      const events = text
        .split("\n")
        .filter((line) => line.startsWith("data: "))
        .map((line) => JSON.parse(line.slice(6)) as Record<string, any>);
      return events.length === 0 ? [JSON.parse(text) as Record<string, any>] : events;
    };

    const served = "skill://usage-triage/references/runbook.md";
    const [ack] = await listen({
      resourceSubscriptions: [
        served,
        "skill://usage-triage/SKILL.md",
        served,
        "skill://usage-triage/references/huge.md",
        "skill://usage-triage/missing.md",
        "skill://oversize/SKILL.md",
        "skill://nope/SKILL.md",
        "skill://usage-triage",
        "skill://usage-triage/references",
        "https://example.com/x",
        "skill://usage-triage/../flat/SKILL.md",
      ],
      resourcesListChanged: true,
    });
    expect(ack).toMatchObject({
      method: "notifications/subscriptions/acknowledged",
      params: {
        notifications: {
          resourceSubscriptions: [served, "skill://usage-triage/SKILL.md"],
          resourcesListChanged: true,
        },
      },
    });

    // Nothing readable: the filter is acknowledged without resourceSubscriptions.
    const [none] = await listen({ resourceSubscriptions: ["skill://nope/SKILL.md"] });
    expect(none?.method).toBe("notifications/subscriptions/acknowledged");
    expect(none?.params.notifications).toEqual({});

    // Exactly 100 URIs is accepted; 101 is refused before anything is read.
    const hundred = Array.from({ length: 100 }, (_, index) =>
      index === 0 ? served : `skill://usage-triage/missing-${index}.md`,
    );
    const [atLimit] = await listen({ resourceSubscriptions: hundred });
    expect(atLimit?.params.notifications.resourceSubscriptions).toEqual([served]);
    const [overLimit] = await listen({
      resourceSubscriptions: [...hundred, "skill://usage-triage/one-more.md"],
    });
    expect(overLimit).toMatchObject({ error: { code: -32602 }, id: 7 });
    expect(overLimit?.method).toBeUndefined();
  });

  it("serves only skills whose served frontmatter meets the Agent Skills name and description rules", async () => {
    const authored = (name: string, description: string) => ({
      description: "Catalog description.",
      files: {
        "SKILL.md": `---\nname: ${JSON.stringify(name)}\ndescription: ${JSON.stringify(description)}\n---\nBody\n`,
        "notes.md": "notes\n",
      },
    });
    // No frontmatter: eve synthesizes name and description from the catalog.
    const synthesized = (description: string) => ({
      description,
      files: { "SKILL.md": "Body\n", "notes.md": "notes\n" },
    });
    const max = "a".repeat(64);
    const servedSkills: Record<string, FakeSkill> = {
      a: authored("a", "x"),
      "a1-b2": authored("a1-b2", "Fine."),
      [max]: authored(max, "d".repeat(1024)),
      "multi-byte": authored("multi-byte", "é".repeat(1024)),
      "synth-ok": synthesized("s".repeat(1024)),
      "synth-min": synthesized("y"),
    };
    const refused: Record<string, FakeSkill> = {
      Hello_World: authored("Hello_World", "Mixed case and underscore."),
      "Upper-case": authored("Upper-case", "Capitals."),
      [`${max}a`]: authored(`${max}a`, "Name too long."),
      "-leading": authored("-leading", "Leading hyphen."),
      "trailing-": authored("trailing-", "Trailing hyphen."),
      "double--hyphen": authored("double--hyphen", "Consecutive hyphens."),
      "empty-desc": authored("empty-desc", ""),
      "blank-desc": authored("blank-desc", "   "),
      "long-desc": authored("long-desc", "d".repeat(1025)),
      "synth-empty": synthesized(""),
      "synth-long": synthesized("s".repeat(1025)),
      Synth_Bad: synthesized("A synthesized document for a bad name."),
    };
    const call = handler(fakeSource({ ...servedSkills, ...refused }));

    const listed = ((await call("skills/list")).result?.skills as Array<{ uri: string }>).map(
      (skill) => skill.uri,
    );
    const resources = (
      (await call("resources/list")).result?.resources as Array<{ uri: string }>
    ).map((entry) => entry.uri);
    const expected = Object.keys(servedSkills)
      .sort()
      .map((name) => `skill://${name}/SKILL.md`);
    expect(listed).toEqual(expected);
    expect(resources).toEqual(expected);
    for (const name of Object.keys(servedSkills)) {
      const uri = `skill://${name}/SKILL.md`;
      expect((await call("skills/get", { uri })).result, name).toBeDefined();
      expect((await call("resources/read", { uri })).result, name).toBeDefined();
    }
    for (const name of Object.keys(refused)) {
      const root = `skill://${encodeURIComponent(name)}`;
      expect((await call("skills/get", { uri: `${root}/SKILL.md` })).error?.code, name).toBe(
        -32602,
      );
      for (const uri of [`${root}/SKILL.md`, `${root}/notes.md`]) {
        expect((await call("resources/read", { uri })).error?.code, uri).toBe(-32602);
      }
      expect((await call("resources/directory/read", { uri: root })).error?.code, name).toBe(
        -32602,
      );
    }
  });

  it("parses skill URIs strictly", () => {
    expect(parseSkillUri("skill://a")).toEqual({ skill: "a" });
    expect(parseSkillUri("skill://a/b%20c/d.md")).toEqual({ skill: "a", path: "b c/d.md" });
    expect(parseSkillUri("skill://a/b/../c")).toBeUndefined();
    expect(parseSkillUri("skill://a/./c")).toBeUndefined();
    expect(parseSkillUri("skill://a/b%2fc")).toBeUndefined();
    expect(parseSkillUri("skill://a/b%00")).toBeUndefined();
    expect(parseSkillUri("skill://a/b c")).toBeUndefined();
    expect(parseSkillUri("skills://a")).toBeUndefined();
    expect(parseSkillUri("skill://")).toBeUndefined();
  });
});
