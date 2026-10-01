import { access, mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { useScenarioApp } from "#internal/testing/scenario-app.js";
import { buildApplication } from "./build-application.js";
import { startProductionServer } from "./start-production-server.js";

/**
 * Files Nitro would alter if it inlined them under their own names: a PNG
 * (NUL and non-UTF-8 bytes), an empty text file (dropped by Nitro's
 * `r.default || r`), text starting with `base64:` (decoded by unstorage), and
 * a text-typed file that is not valid UTF-8.
 */
const BYTE_EXACT_FILES: Record<string, Buffer> = {
  "assets/logo.png": Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    "base64",
  ),
  "references/empty.md": Buffer.alloc(0),
  "references/b64.txt": Buffer.from("base64:SGVsbG8="),
  "references/latin1.md": Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]),
};

describe("skill files in production server assets", () => {
  const scenarioApp = useScenarioApp();

  it("bundles the skills tree as Nitro server assets that readSkill() serves byte for byte", async () => {
    const { appRoot } = await scenarioApp({
      name: "skill-server-assets",
      installDependencies: true,
      files: {
        "agent/agent.ts": 'export default { model: "openai/gpt-5.4" };',
        "agent/instructions.md": "You are a precise assistant.",
        "agent/skills/research/SKILL.md":
          "---\nname: research\ndescription: Research carefully.\n---\n\n# Research\n",
        "agent/skills/research/references/deep/api.md": "nested api\n",
        "agent/skills/lower/skill.MD":
          "---\nname: lower\ndescription: Lower-case entry.\n---\n\n# Lower\n",
        "agent/channels/probe.ts": [
          'import { defineChannel, GET } from "eve/channels";',
          "export default defineChannel({",
          "  routes: [",
          '    GET("/probe", async (_request, { describe, readSkill }) =>',
          "      Response.json({",
          "        skills: (await describe()).skills,",
          '        research: await readSkill("research"),',
          '        nested: await readSkill("research", "references/deep/api.md"),',
          '        lower: await readSkill("lower", "SKILL.md"),',
          "      }),",
          "    ),",
          '    GET("/file", async (request, { readSkill }) => {',
          '      const path = new URL(request.url).searchParams.get("path") ?? "";',
          '      const value = await readSkill("research", path);',
          "      return new Response(",
          '        typeof value === "string" ? new TextEncoder().encode(value) : value,',
          '        { headers: { "x-kind": typeof value === "string" ? "string" : "bytes" } },',
          "      );",
          "    }),",
          "  ],",
          "});",
        ].join("\n"),
      },
    });
    const skillRoot = join(appRoot, "agent/skills/research");
    await mkdir(join(skillRoot, "assets"), { recursive: true });
    for (const [path, bytes] of Object.entries(BYTE_EXACT_FILES)) {
      await writeFile(join(skillRoot, path), bytes);
    }

    await buildApplication(appRoot, { skipSandboxPrewarm: true });
    // The server function carries no plain copy of the tree: Nitro inlines
    // each file as a lazily imported chunk.
    const serverFiles = (
      await readdir(join(appRoot, ".output", "server"), { recursive: true })
    ).map(String);
    expect(serverFiles.filter((path) => /\.(png|md|MD)$/.test(path))).toEqual([]);
    expect(serverFiles.filter((path) => path.endsWith(".bin.mjs"))).toHaveLength(7);
    await expect(access(join(appRoot, ".output", "server", "_eve-skills"))).rejects.toMatchObject({
      code: "ENOENT",
    });

    const server = await startProductionServer(appRoot, { host: "127.0.0.1", port: 0 });
    try {
      const response = await fetch(new URL("/probe", server.url));
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        lower: "---\nname: lower\ndescription: Lower-case entry.\n---\n\n# Lower\n",
        nested: "nested api\n",
        research: "---\nname: research\ndescription: Research carefully.\n---\n\n# Research\n",
        skills: [
          { description: "Lower-case entry.", files: ["skill.MD"], name: "lower" },
          {
            description: "Research carefully.",
            files: [
              "SKILL.md",
              "assets/logo.png",
              "references/b64.txt",
              "references/deep/api.md",
              "references/empty.md",
              "references/latin1.md",
            ],
            name: "research",
          },
        ],
      });
      for (const [path, bytes] of Object.entries(BYTE_EXACT_FILES)) {
        const file = await fetch(new URL(`/file?path=${encodeURIComponent(path)}`, server.url));
        expect({ path, status: file.status }).toEqual({ path, status: 200 });
        expect(Buffer.from(await file.arrayBuffer()).equals(bytes), path).toBe(true);
      }
      const logo = await fetch(new URL("/file?path=assets/logo.png", server.url));
      expect(logo.headers.get("x-kind")).toBe("bytes");
    } finally {
      await server.close();
    }
  });
});
