---
"eve": patch
---

Slack thread replies now answer pending tool approvals and `ctx.ask()` questions by what the person typed, such as `approve` or an option label. Before, eve matched the attributed `<slack_message>` envelope instead, so typed answers never resolved a choice and free-text answers included the envelope.
