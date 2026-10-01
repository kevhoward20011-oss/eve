---
"eve": patch
---

A plain-text reply that answers a pending `ask_question` or `ctx.ask()` question no longer leaves its channel context behind. Before, channels that attach per-message context, such as Telegram, Discord, Teams, and Twilio, added that block to history as a separate message after the answer, and the model replied to it instead of continuing from the answer.
