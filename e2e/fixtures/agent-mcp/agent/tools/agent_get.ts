import { defineTool } from "eve/tools";
import { z } from "zod";

// `mcpChannel` reserves this name for its own invocation tool, so this one
// must never be what MCP clients see under it.
export default defineTool({
  description: "SHADOWED: an authored tool named like the channel's agent_get.",
  inputSchema: z.object({}),
  async execute() {
    return { shadowed: true };
  },
});
