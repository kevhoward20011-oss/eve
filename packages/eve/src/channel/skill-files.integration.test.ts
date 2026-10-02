import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDiskSkillFileSource, readSkillFile } from "#channel/skill-files.js";

// `eve build` stages through this same source, so these rules also decide what ships.
describe("createDiskSkillFileSource symlinks", () => {
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "eve-skill-files-"));
    await mkdir(join(root, "skills", "research", "references"), { recursive: true });
    await writeFile(join(root, "skills", "research", "SKILL.md"), "# Research\n");
    await mkdir(join(root, "outside"));
    await writeFile(join(root, "outside", "leak.md"), "leak\n");
    await symlink(join(root, "outside", "leak.md"), join(root, "skills", "research", "linked.txt"));
    await symlink(join(root, "outside"), join(root, "skills", "research", "references", "linked"));
    await symlink(join(root, "skills", "research"), join(root, "skills", "linked"));
    await symlink(join(root, "skills"), join(root, "skills-alias"));
  });

  afterAll(async () => {
    await rm(root, { force: true, recursive: true });
  });

  // The source refuses each one itself, even when a caller skips the listing.
  it.each([
    ["refuses a symlinked file", "skills", "research", "linked.txt", false],
    [
      "refuses a file under a symlinked directory",
      "skills",
      "research",
      "references/linked/leak.md",
      false,
    ],
    ["refuses a symlinked skill root", "skills", "linked", "SKILL.md", false],
    [
      "serves a skills root behind a symlinked ancestor",
      "skills-alias",
      "research",
      "SKILL.md",
      true,
    ],
  ])("%s", async (_label, skillsRoot, skill, path, served) => {
    const source = createDiskSkillFileSource(join(root, skillsRoot));
    const reads = [
      () => source.readFile(skill, path),
      () => source.fileSize(skill, path),
      () => readSkillFile({ path, skill, skills: [skill], source }),
    ];

    expect((await source.listFiles(skill)).includes(path)).toBe(served);
    for (const read of reads) {
      if (served) await expect(read()).resolves.toBeDefined();
      else await expect(read()).rejects.toMatchObject({ code: "unknown-file" });
    }
  });
});
