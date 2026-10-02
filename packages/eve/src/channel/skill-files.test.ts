import nodePath from "node:path";

import { describe, expect, it } from "vitest";

import {
  createCompiledSkillFileSource,
  isStrictlyContainedPath,
  MAX_SKILL_FILE_BYTES,
  readSkillFile,
  type SkillFileSource,
} from "#channel/skill-files.js";

function memorySource(content: string, reportedSize = content.length): SkillFileSource {
  return {
    async listFiles() {
      return ["SKILL.md"];
    },
    async fileSize() {
      return reportedSize;
    },
    async readFile() {
      return new TextEncoder().encode(content);
    },
  };
}

const read = (source: SkillFileSource, path?: string) =>
  readSkillFile({ path, skill: "s", skills: ["s"], source });

describe("readSkillFile", () => {
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
    await expect(read(memorySource("x"), path)).rejects.toMatchObject({ code: "invalid-path" });
  });

  // An index entry with no storage key is how `eve build` records an oversized file.
  const bundledOversized = createCompiledSkillFileSource({
    compiledArtifactsSource: { kind: "bundled" },
    openStorage: async () => ({
      getItemRaw: async () =>
        JSON.stringify({
          version: 1,
          skills: [["s", [["SKILL.md", MAX_SKILL_FILE_BYTES + 1, null, null]]]],
        }),
    }),
    workspaceResourceRoot: { logicalPath: "workspace-resources/__root__", rootEntries: [] },
  });
  it.each([
    ["a file at the cap", memorySource("a".repeat(MAX_SKILL_FILE_BYTES)), undefined],
    ["a file over the cap", memorySource("a".repeat(MAX_SKILL_FILE_BYTES + 1)), "too-large"],
    [
      "a file that grew after the size check",
      memorySource("a".repeat(MAX_SKILL_FILE_BYTES + 1), 1),
      "too-large",
    ],
    ["a bundled file indexed by size only", bundledOversized, "too-large"],
  ] as const)("enforces the 512 KiB cap on %s", async (_label, source, code) => {
    if (code === undefined) {
      await expect(read(source)).resolves.toHaveLength(MAX_SKILL_FILE_BYTES);
    } else {
      await expect(read(source)).rejects.toMatchObject({
        code,
        message: expect.stringContaining("524288-byte limit"),
      });
    }
  });
});

describe("isStrictlyContainedPath", () => {
  const posixRoot = "/app/skills/triage";
  const winRoot = "C:\\app\\skills\\triage";
  it.each([
    [posixRoot, `${posixRoot}/SKILL.md`, true, nodePath.posix],
    [posixRoot, `${posixRoot}/refs/..notes.md`, true, nodePath.posix],
    [posixRoot, posixRoot, false, nodePath.posix],
    [posixRoot, "/app/skills/triage-evil/SKILL.md", false, nodePath.posix],
    [posixRoot, "/etc/passwd", false, nodePath.posix],
    [winRoot, `${winRoot}\\refs\\notes.md`, true, nodePath.win32],
    [winRoot, "c:\\APP\\skills\\triage\\x.md", true, nodePath.win32],
    [winRoot, winRoot, false, nodePath.win32],
    [winRoot, "C:\\app\\skills\\triage-evil\\SKILL.md", false, nodePath.win32],
    [winRoot, "D:\\app\\skills\\triage\\x.md", false, nodePath.win32],
  ])("%s contains %s: %s", (root, candidate, contained, path) => {
    expect(isStrictlyContainedPath(root, candidate, path)).toBe(contained);
  });
});
