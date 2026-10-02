import { defineTool } from "#public/tools/index.js";

// The only declaration change from epoch 73 to 74 is an optional
// `readonly forwardPrincipal?: boolean` on `McpClientConnectionDefinition`,
// which the tool API reaches through its connection types. Tools that never
// name it compile unchanged.
export default defineTool({
  description: "Look up an order by id.",
  inputSchema: {
    type: "object",
    properties: { id: { type: "string" } },
    required: ["id"],
  },
  approval: ({ toolName, toolInput }) =>
    toolName === "lookup_order" && typeof toolInput?.id === "string"
      ? "not-applicable"
      : "user-approval",
  execute: (input) => ({ id: (input as { readonly id: string }).id }),
});
