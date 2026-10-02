---
"eve": patch
---

An MCP connection can now call another eve agent's `mcpChannel` tools that need the calling user's approval or sign-in. The request reaches that user as an `input.requested` prompt, only that user's answer is accepted, and a session that cannot ask anyone fails the call. Set `forwardPrincipal: true` on `defineMcpClientConnection` to send the calling user to a server that trusts this deployment as a forwarder.
