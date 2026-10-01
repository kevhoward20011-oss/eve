import { defineEval } from "eve/evals";

import { requireMockModel } from "./mcp-client";

/** The channel's own tools first, then every authored tool; nothing the framework adds. */
const PUBLISHED = [
  "agent_cancel",
  "agent_get",
  "agent_start",
  "agent_update",
  "publish_notice",
  "read_note",
  "whoami",
  "write_note",
];

interface SearchOutput {
  readonly tools: readonly { readonly description: string; readonly tool: string }[];
}

const listed = (output: unknown) => (output as SearchOutput).tools;

export default defineEval({
  description:
    "Through its own MCP connection the agent sees its authored tools and the channel's agent_* tools, and no framework tools.",

  async test(t) {
    requireMockModel(t);
    const turn = await t.send(
      "Alice is onboarding at the Maple Street front desk and asks which kennel tools the desk can use. MCP_LIST_TOOLS",
    );
    turn.expectOk();

    turn.calledTool("connection_search", {
      count: 1,
      output: (value) => {
        const names = listed(value)
          .map((entry) => entry.tool)
          .sort();
        // Framework tools such as connection_search and load_skill are absent,
        // and agent_get is listed once.
        return JSON.stringify(names) === JSON.stringify(PUBLISHED);
      },
    });
    // The authored agent_get loses to the channel's reserved one.
    turn.calledTool("connection_search", {
      count: 1,
      output: (value) =>
        listed(value).some(
          (entry) =>
            entry.tool === "agent_get" &&
            entry.description.startsWith("Reads complete durable invocation state"),
        ),
    });
  },
});
