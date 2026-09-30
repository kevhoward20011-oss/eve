---
issue: https://github.com/vercel/eve/issues/4045
status: proposed
last_updated: "2026-09-30"
---

# Agent Runs and AI Gateway Transcripts

Agent Runs will use AI Gateway Transcripts for Gateway-captured model content,
without restoring content excluded by eve's trace policy.

## Chat span metadata (E1)

Each `chat <modelId>` span gains these attributes without changing trace schema
version `4` or removing content:

| Attribute                              | Semantics                                                                                                                                                     |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gen_ai.generation.id`                 | Non-empty Gateway generation id from the completed call's provider metadata, or a failed call's error when available. The existing `agent.step` copy remains. |
| `vercel.ai_gateway.transcript.enabled` | Only `true`, when Gateway reports `transcripts.enabled === true`. This means capture started, not that asynchronous storage completed. Otherwise absent.      |
| `agent.trace.content.input`            | Set at call start; `true` only when eve records the call's input.                                                                                             |
| `agent.trace.content.output`           | Set on completed calls; `true` only when eve records the call's output.                                                                                       |

Gateway identifiers and capture metadata are independent of content recording.
Destination redaction narrows the corresponding content flag to `false`.
eve does not send `providerOptions.gateway.transcripts`; capture is controlled
by Gateway, whose metadata rollout flag defaults off.

## Agent Runs destination (E2, later)

When Gateway reports transcript capture, only the Agent Runs destination will
omit `gen_ai.input.messages`, `gen_ai.system_instructions`, `ai.prompt.system`,
`gen_ai.output.messages`, `ai.response.text`, `ai.response.tool_calls`, and
`ai.response.tool_results`. Reasoning (`ai.response.reasoning`) remains because
Gateway does not capture it. Content flags remain so Agent Runs can fetch only
directions eve recorded. Other destinations retain their existing content,
subject to their own export policies.

Agent Runs must never fetch a Gateway content direction unless that span's
exported `agent.trace.content.input` or `.output` is `true`. Gateway capture is
not permission to bypass eve's policy. Session title visibility remains keyed
to `invoke_agent` and is unchanged.
