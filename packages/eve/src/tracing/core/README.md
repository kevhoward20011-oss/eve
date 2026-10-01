# Agent trace scopes

This internal library constructs agent trace topology. It owns span names,
attributes, parent relationships, content projection, and terminal events.
The application supplies semantic data and callbacks, not OTel attributes.
These modules are not public package exports.

`tracing.lifecycle` is the lower-level API. Construct a turn, then its children,
and report `started()`, `completed()`, or `failed()`. The callback DSL delegates
to those same lifecycle operations. SDK and eve event bindings use lifecycle
directly. The backend carries opaque host context without exposing raw spans.

## Callback DSL

Install an OTel provider and async context manager first. The library does not
replace process-wide OTel setup.

```ts
import { createAgentTracing } from "#tracing/core/index.js";
import { liveOtelBackend, aiSdkContentSerializer } from "#tracing/adapters/index.js";

const tracing = createAgentTracing({
  agentName: "support",
  framework: { name: "custom-agent", version: "1.0" },
  backend: liveOtelBackend(tracer),
  serializer: aiSdkContentSerializer,
});

await tracing.turn({ conversationId, runId, turnId, sequence: 0 }, async (turn) => {
  await turn.step({ index: 0 }, async (step) => {
    const response = await step.model({ provider, modelId }, callModel, modelResult);
    return await step.action({ callId, name: "lookup" }, async (action) => {
      await action.approval({ requestId }, requestApproval);
      return await action.tool(executeLookup);
    });
  });
});
```

A turn can construct steps. A step can construct models and actions. An action
can construct tools and approvals. Each constructor controls its child's parent
and lifetime. Memory operations can run in turn, step, and action scopes.
No authoring scope exposes a span, attribute map, checkpoint, or resume method.

`modelResult` converts the application's model result into semantic usage,
response identity, finish reason, and permitted response parts. The callback's
return value passes through unchanged. Failed callbacks keep the original error.

Content capture is off by default. Set `content.recordInputs` and
`content.recordOutputs` separately. A delegated activation starts a fresh trace
and links only its first turn to the caller. Related activations retain the
same conversation identity.

## SDK hooks

Use `aiSdkTracing(turn)` for SDK-owned execution. Its hooks construct the same
scopes internally. Application code needs only the turn callback:

```ts
await tracing.turn({ conversationId, runId, turnId, sequence: 0 }, async (turn) => {
  return await generateText({ model, messages, tools, telemetry: aiSdkTracing(turn) });
});
```

Consume streaming responses inside the callback. Do not return an unconsumed
stream or detach child work. Physical SDK retries have separate model spans.
Unrelated integrations can pass through `aiSdkTracing(turn, { integrations })`.
Do not install a second integration that records the same model or tool spans.

## Runtime persistence

Configure `checkpointer` once with a `TraceCheckpointer` adapter. The lifecycle saves
serializable scope state through `load`, `save`, and `remove`. The adapter joins
that state to the runtime's existing checkpoint. It does not create a separate
workflow checkpoint.

Runtime bindings supply stable keys for operations that cross workers. The
callback DSL remains unchanged. Internal runtime scopes can restore state by
key and accept a terminal event in another worker. Only the application runtime
controls suspension, retry, and replay. Tracing never reruns callbacks itself.

Persistence requires a backend with reserved-ID support. Restore preserves
parent identity, start time, capture ceiling, and operation metadata. Denied
content does not enter persisted state. The caller serializes state changes for
one operation key and owns export deduplication.

The integration layer uses the same runtime scope constructors. It projects existing
turn, action, and approval records into semantic bindings. Existing workflow
state remains the sole persistence owner; no second checkpoint tree is added.

Use `lifecycle.resolve(record, { executionContext })` to reconstruct a semantic
checkpoint record from an external runtime. Record conversion belongs in the
checkpointer adapter. Construct ordinary children directly from the resolved
parent; the lifecycle inherits attempt and output context automatically.

Transport adapters use `createTransportLifecycle().request()` or `.mcp()`.
They supply protocol data, not span names or OTel options. The backend remains
the only component that starts OTel spans.

## Compatibility and transports

Neutral output uses schema version 1. The optional eve output profile retains
schema version 4, existing link keys, and Vercel session attribution. Apply output
mapping before destination filtering. A profile cannot restore denied content.

Request and MCP transport tracing are separate entry points. Pass route templates,
not user-supplied URLs. Enrich the active tool scope instead of creating a second
MCP call span when the tool already owns execution.

Agent Runs export, remote protocol authorization, and global registration remain
outside scope construction.
