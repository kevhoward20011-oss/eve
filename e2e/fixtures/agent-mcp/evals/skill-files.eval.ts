import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { defineEval } from "eve/evals";
import { equals } from "eve/evals/expect";

import { mcpRequest } from "./mcp-client";

const SKILL = "kennel-handbook";

/**
 * Files a bundler or asset store would alter if it handled them by name: an
 * empty file, text that starts with `base64:`, Markdown that is not valid
 * UTF-8, and a PNG.
 */
const FILES = [
  "references/empty.md",
  "references/b64.txt",
  "references/latin1.md",
  "assets/logo.png",
];

export default defineEval({
  description:
    "MCP resources/read serves the deployed bundle's skill files byte for byte, whatever their encoding.",

  async test(t) {
    for (const path of FILES) {
      // `eve eval` runs with the fixture as cwd, so this is the authored file.
      const authored = await readFile(join(process.cwd(), "agent/skills", SKILL, path));
      const uri = `skill://${SKILL}/${path}`;
      const read = await mcpRequest(t.target, "alice", "resources/read", { uri });
      const [content] = (read.result?.contents ?? []) as {
        readonly blob?: string;
        readonly text?: string;
      }[];
      const served =
        content?.blob !== undefined
          ? Buffer.from(content.blob, "base64")
          : Buffer.from(content?.text ?? "\u0000missing", "utf8");
      await t.require(
        { path, bytes: served.toString("hex") },
        equals({ path, bytes: authored.toString("hex") }),
      );
    }
  },
});
