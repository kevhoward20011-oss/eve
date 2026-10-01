import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createCompiledSkillFileSource,
  createDiskSkillFileSource,
  readSkillFile,
} from "#channel/skill-files.js";

describe("createDiskSkillFileSource", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "eve-skill-files-"));
    await mkdir(join(root, "skills", "research", "references", "deep"), { recursive: true });
    await writeFile(join(root, "skills", "research", "SKILL.md"), "# Research\n");
    await writeFile(join(root, "skills", "research", "references", "deep", "api.md"), "nested\n");
    await writeFile(join(root, "secret.txt"), "outside\n");
    await mkdir(join(root, "outside"));
    await writeFile(join(root, "outside", "leak.md"), "leak\n");
    await symlink(join(root, "secret.txt"), join(root, "skills", "research", "linked.txt"));
    await symlink(join(root, "outside"), join(root, "skills", "research", "references", "linked"));
    await symlink(join(root, "skills", "research"), join(root, "skills", "linked"));
  });

  afterEach(async () => {
    await rm(root, { force: true, recursive: true });
  });

  it("lists regular files sorted, skipping symlinks, and reads them", async () => {
    const source = createDiskSkillFileSource(join(root, "skills"));
    const read = (path?: string) =>
      readSkillFile({ path, skill: "research", skills: ["research"], source });

    await expect(source.listFiles("research")).resolves.toEqual([
      "SKILL.md",
      "references/deep/api.md",
    ]);
    await expect(source.listFiles("absent")).resolves.toEqual([]);
    await expect(read()).resolves.toBe("# Research\n");
    await expect(read("references/deep/api.md")).resolves.toBe("nested\n");
  });

  // The source itself refuses each one, even when a caller skips the listing gate.
  it.each([
    ["a symlinked file", "research", "linked.txt"],
    ["a file under a symlinked directory", "research", "references/linked/leak.md"],
    ["a symlinked skill root", "linked", "SKILL.md"],
  ])("never serves %s", async (_label, skill, path) => {
    const source = createDiskSkillFileSource(join(root, "skills"));

    expect(await source.listFiles(skill)).not.toContain(path);
    await expect(source.readFile(skill, path)).rejects.toMatchObject({ code: "unknown-file" });
    await expect(source.fileSize(skill, path)).rejects.toMatchObject({ code: "unknown-file" });
    await expect(readSkillFile({ path, skill, skills: [skill], source })).rejects.toMatchObject({
      code: "unknown-file",
    });
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
});
