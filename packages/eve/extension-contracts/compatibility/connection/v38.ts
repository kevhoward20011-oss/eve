import { defineMcpClientConnection } from "#public/connections/index.js";

// The only declaration change from epoch 38 to 39 is an optional
// `readonly forwardPrincipal?: boolean` on `McpClientConnectionDefinition`.
// Connections that omit it send no forwarded-principal header, as before.
export default defineMcpClientConnection({
  description: "Search the support knowledge base.",
  url: "https://support.example.com/mcp",
  approval({ toolName }) {
    return toolName.endsWith("__search") ? "approved" : "user-approval";
  },
});
