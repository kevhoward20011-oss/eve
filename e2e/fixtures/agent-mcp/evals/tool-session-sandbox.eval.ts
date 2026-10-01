import { defineEval } from "eve/evals";
import { equals, satisfies } from "eve/evals/expect";

import { mcpRequest } from "./mcp-client";

/**
 * The second call finds the sandbox the first created: `reused` while it is
 * still running, `resumed` when the provider stopped it in between. Vercel
 * Sandbox can report either; just-bash (local and Postgres runs) stays
 * running.
 */
const REOPENED = ["reused", "resumed"];

export default defineEval({
  description:
    "Two MCP tool calls with the same tool-session key share one sandbox: the second reads what the first wrote.",
  timeoutMs: 240_000,

  async test(t) {
    const meta = { "dev.eve/tool-session": `alice-front-desk-${crypto.randomUUID()}` };
    const text = `Feed Biscuit at 18:00 (${crypto.randomUUID()}).`;

    const wrote = await mcpRequest(
      t.target,
      "alice",
      "tools/call",
      { arguments: { text }, name: "write_note" },
      meta,
    );
    await t.require(wrote.result?.structuredContent, equals({ written: text }));
    await t.require(wrote.result?._meta?.["dev.eve/sandbox"]?.state, equals("created"));

    const read = await mcpRequest(
      t.target,
      "alice",
      "tools/call",
      { arguments: {}, name: "read_note" },
      meta,
    );
    await t.require(read.result?.structuredContent, equals({ text }));
    await t.require(
      read.result?._meta?.["dev.eve/sandbox"]?.state,
      satisfies((state: unknown) => REOPENED.includes(state as string), "reused or resumed"),
    );
  },
});
