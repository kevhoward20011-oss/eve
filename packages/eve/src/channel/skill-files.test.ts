import { createHash } from "node:crypto";
import nodePath from "node:path";

import { describe, expect, it } from "vitest";

import {
  createCompiledSkillFileSource,
  isStrictlyContainedPath,
  MAX_SKILL_FILE_BYTES,
  readSkillFile,
  SkillReadError,
  type SkillFileSource,
} from "#channel/skill-files.js";

function memorySource(
  tree: Readonly<Record<string, Readonly<Record<string, Uint8Array | string>>>>,
  options: { readonly reportedSize?: number } = {},
): SkillFileSource {
  const bytes = (skill: string, path: string) => {
    const content = tree[skill]?.[path];
    if (content === undefined) throw new Error(`missing ${skill}/${path}`);
    return typeof content === "string" ? new TextEncoder().encode(content) : content;
  };
  return {
    async listFiles(skill) {
      return Object.keys(tree[skill] ?? {}).sort();
    },
    async fileSize(skill, path) {
      return options.reportedSize ?? bytes(skill, path).byteLength;
    },
    async readFile(skill, path) {
      return bytes(skill, path);
    },
  };
}

const source = memorySource({
  research: {
    "SKILL.md": "# Research\n",
    "references/deep/api.md": "nested\n",
    "assets/logo.png": new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]),
  },
});
const skills = ["research"];

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function indexEntry(path: string, bytes: Uint8Array) {
  return [path, bytes.byteLength, `${sha256(bytes)}.bin`, sha256(bytes)];
}

async function readError(promise: Promise<unknown>): Promise<SkillReadError> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(SkillReadError);
  return error as SkillReadError;
}

describe("readSkillFile", () => {
  it("reads SKILL.md by default", async () => {
    await expect(readSkillFile({ skill: "research", skills, source })).resolves.toBe(
      "# Research\n",
    );
  });

  it("reads a nested file", async () => {
    await expect(
      readSkillFile({ path: "references/deep/api.md", skill: "research", skills, source }),
    ).resolves.toBe("nested\n");
  });

  it("returns bytes for files that are not UTF-8 text", async () => {
    const content = await readSkillFile({
      path: "assets/logo.png",
      skill: "research",
      skills,
      source,
    });
    expect(content).toBeInstanceOf(Uint8Array);
    expect([...(content as Uint8Array)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);
  });

  it.each([
    "../other/SKILL.md",
    "./SKILL.md",
    "/etc/passwd",
    "C:/Windows/win.ini",
    "references\\api.md",
    "references//api.md",
    "SKILL.md\0.png",
    "",
  ])("rejects the path %j", async (path) => {
    const error = await readError(readSkillFile({ path, skill: "research", skills, source }));
    expect(error.code).toBe("invalid-path");
  });

  it("rejects unknown skills and files", async () => {
    expect((await readError(readSkillFile({ skill: "missing", skills, source }))).message).toBe(
      'Unknown skill "missing".',
    );
    expect(
      (await readError(readSkillFile({ path: "nope.md", skill: "research", skills, source })))
        .message,
    ).toBe('Skill "research" has no file "nope.md".');
  });

  it("rejects skills the source has files for but the manifest does not list", async () => {
    const error = await readError(readSkillFile({ skill: "research", skills: [], source }));
    expect(error.code).toBe("unknown-skill");
  });

  it("enforces the 512 KiB cap", async () => {
    const atCap = memorySource({ big: { "SKILL.md": "a".repeat(MAX_SKILL_FILE_BYTES) } });
    await expect(
      readSkillFile({ skill: "big", skills: ["big"], source: atCap }),
    ).resolves.toHaveLength(MAX_SKILL_FILE_BYTES);

    const overCap = memorySource({ big: { "SKILL.md": "a".repeat(MAX_SKILL_FILE_BYTES + 1) } });
    const error = await readError(
      readSkillFile({ skill: "big", skills: ["big"], source: overCap }),
    );
    expect(error.code).toBe("too-large");
    expect(error.message).toContain("524288-byte limit");
  });

  it("enforces the cap when the file grows after the size check", async () => {
    const grown = memorySource(
      { big: { "SKILL.md": "a".repeat(MAX_SKILL_FILE_BYTES + 1) } },
      { reportedSize: 1 },
    );
    const error = await readError(readSkillFile({ skill: "big", skills: ["big"], source: grown }));
    expect(error.code).toBe("too-large");
  });
});

describe("isStrictlyContainedPath", () => {
  it("accepts descendants and rejects the root, parents, siblings, and escapes on POSIX", () => {
    const { posix } = nodePath;
    const root = "/app/.eve/compile/skills/triage";
    expect(isStrictlyContainedPath(root, `${root}/SKILL.md`, posix)).toBe(true);
    expect(isStrictlyContainedPath(root, `${root}/refs/..notes.md`, posix)).toBe(true);
    expect(isStrictlyContainedPath(root, root, posix)).toBe(false);
    expect(
      isStrictlyContainedPath(root, "/app/.eve/compile/skills/triage-evil/SKILL.md", posix),
    ).toBe(false);
    expect(isStrictlyContainedPath(root, "/app/.eve/compile/skills/other/SKILL.md", posix)).toBe(
      false,
    );
    expect(isStrictlyContainedPath(root, "/etc/passwd", posix)).toBe(false);
  });

  it("accepts backslash descendants and rejects escapes and other drives on Windows", () => {
    const { win32 } = nodePath;
    const root = "C:\\app\\.eve\\compile\\skills\\triage";
    expect(isStrictlyContainedPath(root, `${root}\\SKILL.md`, win32)).toBe(true);
    expect(isStrictlyContainedPath(root, `${root}\\refs\\notes.md`, win32)).toBe(true);
    expect(
      isStrictlyContainedPath(root, "c:\\APP\\.eve\\compile\\skills\\triage\\x.md", win32),
    ).toBe(true);
    expect(isStrictlyContainedPath(root, root, win32)).toBe(false);
    expect(
      isStrictlyContainedPath(root, "C:\\app\\.eve\\compile\\skills\\triage-evil\\SKILL.md", win32),
    ).toBe(false);
    expect(isStrictlyContainedPath(root, "C:\\Windows\\win.ini", win32)).toBe(false);
    expect(
      isStrictlyContainedPath(root, "D:\\app\\.eve\\compile\\skills\\triage\\x.md", win32),
    ).toBe(false);
  });
});

describe("createCompiledSkillFileSource for bundled deployments", () => {
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
