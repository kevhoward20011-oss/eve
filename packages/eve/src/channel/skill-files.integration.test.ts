import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createCompiledSkillFileSource,
  createDiskSkillFileSource,
  readSkillFile,
} from "#channel/skill-files.js";

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function indexEntry(path: string, bytes: Uint8Array) {
  return [path, bytes.byteLength, `${sha256(bytes)}.bin`, sha256(bytes)];
}

describe("createDiskSkillFileSource", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "eve-skill-files-"));
    await mkdir(join(root, "skills", "research", "references", "deep"), { recursive: true });
    await writeFile(join(root, "skills", "research", "SKILL.md"), "# Research\n");
    await writeFile(join(root, "skills", "research", "references", "deep", "api.md"), "nested\n");
    await writeFile(join(root, "secret.txt"), "outside\n");
    await symlink(join(root, "secret.txt"), join(root, "skills", "research", "linked.txt"));
  });

  afterEach(async () => {
    await rm(root, { force: true, recursive: true });
  });

  it("lists regular files sorted and skips symlinks", async () => {
    const source = createDiskSkillFileSource(join(root, "skills"));

    await expect(source.listFiles("research")).resolves.toEqual([
      "SKILL.md",
      "references/deep/api.md",
    ]);
    await expect(source.listFiles("absent")).resolves.toEqual([]);
  });

  it("reads SKILL.md and nested files, never a symlink target", async () => {
    const source = createDiskSkillFileSource(join(root, "skills"));
    const read = (path?: string) =>
      readSkillFile({ path, skill: "research", skills: ["research"], source });

    await expect(read()).resolves.toBe("# Research\n");
    await expect(read("references/deep/api.md")).resolves.toBe("nested\n");
    await expect(read("linked.txt")).rejects.toMatchObject({ code: "unknown-file" });
  });

  it("reads a case-variant entry file by default and by its canonical name", async () => {
    await mkdir(join(root, "skills", "lower"), { recursive: true });
    await writeFile(join(root, "skills", "lower", "skill.MD"), "# Lower\n");
    const source = createDiskSkillFileSource(join(root, "skills"));
    const read = (path?: string) =>
      readSkillFile({ path, skill: "lower", skills: ["lower"], source });

    await expect(source.listFiles("lower")).resolves.toEqual(["skill.MD"]);
    await expect(read()).resolves.toBe("# Lower\n");
    await expect(read("SKILL.md")).resolves.toBe("# Lower\n");
    await expect(read("skill.MD")).resolves.toBe("# Lower\n");
  });

  it("rejects a symlinked skill root", async () => {
    await symlink(join(root, "skills", "research"), join(root, "skills", "linked"));
    const source = createDiskSkillFileSource(join(root, "skills"));

    await expect(source.listFiles("linked")).resolves.toEqual([]);
    await expect(source.readFile("linked", "SKILL.md")).rejects.toMatchObject({
      code: "unknown-file",
    });
    await expect(source.fileSize("linked", "SKILL.md")).rejects.toMatchObject({
      code: "unknown-file",
    });
    await expect(
      readSkillFile({ skill: "linked", skills: ["linked"], source }),
    ).rejects.toMatchObject({ code: "unknown-file" });
  });

  it("rejects symlinked directories anywhere under the skill root", async () => {
    await mkdir(join(root, "outside"), { recursive: true });
    await writeFile(join(root, "outside", "leak.md"), "leak\n");
    await symlink(join(root, "outside"), join(root, "skills", "research", "references", "linked"));
    const source = createDiskSkillFileSource(join(root, "skills"));

    await expect(source.listFiles("research")).resolves.toEqual([
      "SKILL.md",
      "references/deep/api.md",
    ]);
    // The source itself refuses, even when a caller skips the listing gate.
    await expect(source.readFile("research", "references/linked/leak.md")).rejects.toMatchObject({
      code: "unknown-file",
    });
    await expect(source.fileSize("research", "references/linked/leak.md")).rejects.toMatchObject({
      code: "unknown-file",
    });
    await expect(source.readFile("research", "linked.txt")).rejects.toMatchObject({
      code: "unknown-file",
    });
  });

  it("serves files when the skills root itself sits behind a symlinked ancestor", async () => {
    await symlink(join(root, "skills"), join(root, "skills-alias"));
    const source = createDiskSkillFileSource(join(root, "skills-alias"));

    await expect(source.readFile("research", "SKILL.md")).resolves.toEqual(
      new TextEncoder().encode("# Research\n"),
    );
  });

  it("resolves the compiled resource tree under the app's compile directory", async () => {
    const appRoot = join(root, "app");
    const skillRoot = join(appRoot, ".eve", "compile", "workspace-resources", "__root__", "skills");
    await mkdir(join(skillRoot, "research"), { recursive: true });
    await writeFile(join(skillRoot, "research", "SKILL.md"), "# Compiled\n");

    const source = createCompiledSkillFileSource({
      compiledArtifactsSource: { appRoot, kind: "disk" },
      workspaceResourceRoot: {
        logicalPath: "workspace-resources/__root__",
        rootEntries: ["skills"],
      },
    });

    await expect(source.listFiles("research")).resolves.toEqual(["SKILL.md"]);
  });

  it("reads bundled deployments from Nitro server assets through the build index", async () => {
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0x80]);
    const markdown = new TextEncoder().encode("# Bundled\n");
    const empty = new Uint8Array(0);
    const tamperedIndexed = new TextEncoder().encode("a");
    const items = new Map<string, unknown>([
      [
        "eve-skill-index:skills.json",
        JSON.stringify({
          version: 1,
          skills: [
            [
              "research",
              [
                indexEntry("SKILL.md", markdown),
                indexEntry("assets/logo.png", png),
                indexEntry("empty.md", empty),
                ["huge.bin", 600 * 1024, null, null],
                indexEntry("tampered.md", tamperedIndexed),
                indexEntry("text-typed.md", markdown),
              ],
            ],
          ],
        }),
      ],
      // `eve build` stages every file as `<sha256>.bin`, which Nitro inlines as bytes.
      [`eve-skills:${sha256(markdown)}.bin`, markdown],
      [`eve-skills:${sha256(png)}.bin`, png],
      [`eve-skills:${sha256(empty)}.bin`, empty],
      [`eve-skills:${sha256(tamperedIndexed)}.bin`, new TextEncoder().encode("b")],
    ]);
    const opened: string[] = [];
    const source = createCompiledSkillFileSource({
      compiledArtifactsSource: { kind: "bundled" },
      openStorage: async (base) => {
        opened.push(base);
        return { getItemRaw: async (key) => items.get(`${base}:${key}`) ?? null };
      },
      workspaceResourceRoot: { logicalPath: "workspace-resources/__root__", rootEntries: [] },
    });
    const read = (path?: string) =>
      readSkillFile({ path, skill: "research", skills: ["research"], source });

    await expect(source.listFiles("research")).resolves.toEqual([
      "SKILL.md",
      "assets/logo.png",
      "empty.md",
      "huge.bin",
      "tampered.md",
      "text-typed.md",
    ]);
    await expect(source.listFiles("__proto__")).resolves.toEqual([]);
    await expect(read()).resolves.toBe("# Bundled\n");
    await expect(read("empty.md")).resolves.toBe("");
    await expect(read("assets/logo.png")).resolves.toEqual(png);
    await expect(read("huge.bin")).rejects.toMatchObject({ code: "too-large" });
    await expect(read("tampered.md")).rejects.toMatchObject({ code: "unavailable" });
    // A string is what Nitro returns for a text-typed asset name; a byte-exact
    // build never produces one.
    items.set(`eve-skills:${sha256(markdown)}.bin`, "# Bundled\n");
    await expect(read("text-typed.md")).rejects.toMatchObject({ code: "unavailable" });
    await expect(read("missing.md")).rejects.toMatchObject({ code: "unknown-file" });
    expect(new Set(opened)).toEqual(new Set(["eve-skill-index", "eve-skills"]));
  });

  it("reports bundled deployments without a build index as unavailable", async () => {
    const source = createCompiledSkillFileSource({
      compiledArtifactsSource: { kind: "bundled" },
      openStorage: async () => ({ getItemRaw: async () => null }),
      workspaceResourceRoot: { logicalPath: "workspace-resources/__root__", rootEntries: [] },
    });
    await expect(source.listFiles("research")).rejects.toMatchObject({ code: "unavailable" });
  });
});
