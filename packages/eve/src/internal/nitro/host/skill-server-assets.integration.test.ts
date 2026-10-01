import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MAX_SKILL_FILE_BYTES } from "#channel/skill-files.js";
import { prepareSkillServerAssets } from "./skill-server-assets.js";

const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

describe("prepareSkillServerAssets", () => {
  let root: string;
  let skillsRoot: string;
  let stagingDirectory: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "eve-skill-server-assets-"));
    skillsRoot = join(root, "skills");
    stagingDirectory = join(root, "staging");
    await mkdir(join(skillsRoot, "research", "references"), { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { force: true, recursive: true });
  });

  it("stages every shipped file as a content-addressed .bin asset and indexes its real path", async () => {
    const files: Record<string, Buffer> = {
      "SKILL.md": Buffer.from("# Research\n"),
      "references/x.md": Buffer.from("x\n"),
      "references/copy.md": Buffer.from("x\n"),
      "empty.md": Buffer.alloc(0),
      "b64.txt": Buffer.from("base64:SGVsbG8="),
      "latin1.md": Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]),
      "logo.png": Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff]),
      ".hidden": Buffer.from("dot\n"),
      "what?.md": Buffer.from("q\n"),
      "references:x.md": Buffer.from("colon\n"),
    };
    for (const [path, bytes] of Object.entries(files)) {
      await writeFile(join(skillsRoot, "research", path), bytes);
    }
    await writeFile(
      join(skillsRoot, "research", "huge.bin"),
      Buffer.alloc(MAX_SKILL_FILE_BYTES + 1),
    );
    await writeFile(join(root, "secret.txt"), "outside\n");
    await symlink(join(root, "secret.txt"), join(skillsRoot, "research", "linked.txt"));
    await symlink(root, join(skillsRoot, "research", "linked-dir"));
    await mkdir(join(skillsRoot, "unlisted"));
    await writeFile(join(skillsRoot, "unlisted", "SKILL.md"), "# Unlisted\n");
    // A previous build's staged files must not leak into this one.
    await mkdir(join(stagingDirectory, "files"), { recursive: true });
    await writeFile(join(stagingDirectory, "files", "stale.bin"), "stale");

    const serverAssets = await prepareSkillServerAssets({
      stagingDirectory,
      skills: ["research"],
      skillsRoot,
    });

    expect(serverAssets).toEqual([
      { baseName: "eve-skill-index", dir: join(stagingDirectory, "index") },
      { baseName: "eve-skills", dir: join(stagingDirectory, "files") },
    ]);
    const index = JSON.parse(
      await readFile(join(stagingDirectory, "index", "skills.json"), "utf8"),
    ) as { skills: [string, [string, number, string | null, string | null][]][] };
    const entries = index.skills[0]?.[1] ?? [];
    expect(index.skills.map(([skill]) => skill)).toEqual(["research"]);
    expect(entries.map(([path]) => path)).toEqual(
      [...Object.keys(files), "huge.bin"].sort((left, right) =>
        left < right ? -1 : left > right ? 1 : 0,
      ),
    );
    expect(entries.find(([path]) => path === "huge.bin")).toEqual([
      "huge.bin",
      MAX_SKILL_FILE_BYTES + 1,
      null,
      null,
    ]);
    for (const [path, bytes] of Object.entries(files)) {
      const sha256 = digest(bytes);
      expect(entries.find(([indexed]) => indexed === path)).toEqual([
        path,
        bytes.byteLength,
        `${sha256}.bin`,
        sha256,
      ]);
      const staged = await readFile(join(stagingDirectory, "files", `${sha256}.bin`));
      expect(staged.equals(bytes)).toBe(true);
    }
    // Identical files share one asset; nothing else is staged.
    expect((await readdir(join(stagingDirectory, "files"))).sort()).toEqual(
      [...new Set(Object.values(files).map((bytes) => `${digest(bytes)}.bin`))].sort(),
    );
  });
});
