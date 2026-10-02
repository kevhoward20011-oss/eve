---
issue: TBD
status: proposed
last_updated: "2026-10-01"
---

# Agent tracing library

## Decision

Extract one neutral trace engine. Use the engine in eve before a public release.
Add an AI SDK adapter for agents that do not use eve.

This plan supersedes the trace topology in
[Provider-neutral local observability](./provider-neutral-local-observability.md).
Keep its existing `createAiSdkHookBridge` for eve event conversion. The standalone
SDK adapter supplies callback-owned lifetimes; it does not replace eve's bridge
or install a second bridge in eve.

Use a callback DSL to construct the trace topology. SDK hooks construct the same
scopes internally. Keep persistence at the runtime boundary, not in authoring code.

Keep vendor names out of the core API. An explicit output wrapper preserves
existing eve traces and Agent Runs behavior.

All APIs below are proposed. The attribute tables define the neutral contract.
The compatibility table maps that contract to current eve output.
The prose follows ASD-STE100 rules. Software identifiers are technical names.
This document does not claim certified ASD-STE100 compliance.

## Authoring API

```ts
interface AgentTracing {
  turn<T>(input: TurnInput, execute: (turn: TurnScope) => Promise<T>): Promise<T>;
  integrations: { aiSdk: typeof aiSdkTracing };
}

interface TurnInput {
  conversationId: string;
  runId: string;
  turnId: string;
  sequence: number;
  caller?: TraceReference;
  request?: TraceReference;
  signal?: AbortSignal;
}

interface TraceReference {
  traceId: string;
  spanId: string;
  traceFlags: number;
  isRemote?: boolean;
  tracestate?: string;
}

interface TurnScope {
  step<T>(input: StepInput, execute: (step: StepScope) => Promise<T>): Promise<T>;
}

interface StepInput {
  index: number;
  attempt?: number;
}
interface ModelInput {
  provider: string;
  modelId: string;
  messages?: readonly unknown[];
}
interface ModelResult {
  usage: { inputTokens?: number; outputTokens?: number };
  finishReason: string;
}
interface ActionInput {
  callId: string;
  name: string;
  arguments?: unknown;
}
interface ApprovalInput {
  requestId: string;
  request?: unknown;
}
interface StepScope {
  model<T>(
    input: ModelInput,
    execute: () => Promise<T>,
    result?: (value: T) => ModelResult,
  ): Promise<T>;
  action<T>(input: ActionInput, execute: (action: ActionScope) => Promise<T>): Promise<T>;
}
interface ActionScope {
  tool<T>(execute: () => Promise<T>): Promise<T>;
  approval<T>(input: ApprovalInput, execute: () => Promise<T>): Promise<T>;
}

declare function createAgentTracing(input: {
  agentName?: string;
  framework?: { name: string; version: string };
  adapter: {
    backend: TraceBackend;
    serializer: ContentSerializer;
    integrations?: { aiSdk: typeof aiSdkTracing };
  };
  checkpointer?: TraceCheckpointer;
  content?: { recordInputs: boolean; recordOutputs: boolean };
}): AgentTracing;

declare function liveOtelBackend(tracer: Tracer): TraceBackend;
declare function aiSdkTracing(
  turn: TurnScope,
  options?: {
    integrations?: readonly Telemetry[];
  },
): TelemetryOptions;

type CaptureDecision =
  { emit: false } | { emit: true; recordInputs: boolean; recordOutputs: boolean };
```

```ts
const tracing = createAgentTracing({
  agentName: "support",
  framework: { name: "custom-agent", version: "1.0" },
  adapter: {
    backend: liveOtelBackend(tracer),
    serializer: aiSdkContentSerializer,
    integrations: { aiSdk: aiSdkTracing },
  },
  content: { recordInputs: false, recordOutputs: false },
});

await tracing.turn({ conversationId, runId, turnId, sequence: 0 }, async (turn) => {
  const result = await generateText({
    model,
    messages,
    tools,
    telemetry: tracing.integrations.aiSdk(turn, { integrations: [existingTelemetry] }),
  });
  return result.text;
});
```

The callback defines the turn lifetime. Consume streams inside the callback.
Await child work before the callback ends. A thrown application error marks the
turn as failed. The library throws the same error.

The standalone SDK adapter returns full `TelemetryOptions` with `isEnabled: true`.
Its `integrations` option retains unrelated telemetry integrations.
eve uses `createAiSdkHookBridge` instead. That bridge emits model and tool events,
not action events; framework dispatch remains the sole action source.

For a custom loop, construct children through their parent scopes:

```ts
await tracing.turn(turnInfo, async (turn) => {
  await turn.step({ index: 0 }, async (step) => {
    await step.model({ provider, modelId }, callModel, modelResult);
    await step.action({ callId, name: "lookup" }, async (action) => {
      await action.approval({ requestId }, requestApproval);
      return await action.tool(executeLookup);
    });
  });
});
```

Construction controls parentage, span names, attributes, completion, and cleanup.
No authoring scope exposes a raw span, attribute map, checkpoint, or resume method.
Configure every adapter through `createAgentTracing`. Consumers use callback or
lifecycle methods for usage, protocol metadata, payloads, and errors.
Attribute builders are private implementation details, not API entry points.

## Span topology and lifetime

```text
transport trace
  └── agent.channel.request
        ── channel.request link ──> activation trace

activation trace
invoke_agent <agent>
  ├── search_memory / upsert_memory
  └── agent.step
        ├── chat <model>
        │     └── provider HTTP spans
        └── agent.action
              ├── agent.approval
              └── execute_tool <tool>
                    └── memory, MCP, HTTP, or database spans

agent.action or execute_tool
  ── agent.dispatch link ──> invoke_agent <child> in a new trace

execution delivery span
  ── execution.delivery link ──> agent.step in a different trace
```

| Span                             | Kind                              | Lifetime and parent                                                                            |
| -------------------------------- | --------------------------------- | ---------------------------------------------------------------------------------------------- |
| `invoke_agent <agent>`           | INTERNAL                          | New root for each turn. Durable mode emits the root at its terminal transition.                |
| `agent.step`                     | INTERNAL                          | One execution attempt. Parent is the activation.                                               |
| `chat <model>`                   | CLIENT                            | One physical model request. Parent is the step. Stream completion ends the span.               |
| `agent.action`                   | INTERNAL; CLIENT for remote calls | Logical dispatch through accepted result. Parent is the step. Can cross workers.               |
| `execute_tool <tool>`            | INTERNAL                          | Physical tool execution. Parent is the action. Step is the fallback parent.                    |
| `agent.approval`                 | INTERNAL                          | Tool approval wait. Parent is the action. Can cross workers.                                   |
| `search_memory`, `upsert_memory` | CLIENT                            | One memory operation. Use active agent context, then stored turn or session context.           |
| `agent.channel.request`          | SERVER                            | Optional inbound request. Use extracted transport context. End when the handler returns.       |
| `tools/list`                     | CLIENT                            | MCP discovery. Parent is the active context.                                                   |
| `tools/call <tool>`              | CLIENT                            | MCP fallback when no tool annotation target exists. Otherwise annotate the existing tool span. |

Channel delivery events update activation metadata. They do not create spans.
Questions and session limits do not create approval spans.
Registration and sampling probes are private. Do not export those probes.

Only the first child turn links to its dispatching caller. Related turns and
agents share `gen_ai.conversation.id`. Trace links are not authorization grants.

## Attribute contract

Omit optional attributes when the source or capture decision omits them.
Do not add common attributes to span types that do not currently receive them.
`string[]` means an OTel string array. Content marked JSON is serialized text.

### Shared groups

| Group            | Attributes                                                                                                                                                   | Applies to                                                            |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| Identity         | `agent.run.id: string`, `agent.trace.schema.version: 1`, `gen_ai.conversation.id: string`                                                                    | Activation, step, model, action, tool, approval, memory.              |
| Naming           | `operation.name: string`, `resource.name: string`                                                                                                            | All except MCP discovery and fallback spans.                          |
| Framework        | `agent.framework.name: string`, `agent.framework.version: string`                                                                                            | Activation, step, action, approval.                                   |
| Attempt          | `agent.step.index: number`, `agent.step.attempt: number`, `agent.turn.id: string`                                                                            | Step, action, approval.                                               |
| Structural usage | `agent.usage.input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens`, `cost_usd` under `agent.usage.*`: optional numbers                   | Step, model, action; activation has input and output totals only.     |
| GenAI usage      | `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, `gen_ai.usage.cache_read.input_tokens`, `gen_ai.usage.cache_write.input_tokens`: optional numbers | Model; activation has input and output totals only.                   |
| Runtime context  | `ai.settings.context.<key>`: OTel primitive or homogeneous primitive array                                                                                   | Step, model.                                                          |
| Error            | `error.type: string`; ERROR status; permitted exception event and status message                                                                             | Failed agent operations and MCP. Request spans use ERROR status only. |

Invocation totals add completed model calls in that activation. They exclude
delegated agents. Preserve current step usage assignment during extraction.
The step receives completed call usage, not a second aggregate.

### Activation

| Attributes                                                             | Type and rule                                                                                          |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `gen_ai.operation.name`                                                | `invoke_agent`.                                                                                        |
| `gen_ai.agent.name`, `agent.name`                                      | Optional strings.                                                                                      |
| `agent.run.type`                                                       | `session` or `subagent`.                                                                               |
| `agent.turn.id`, `agent.turn.sequence`, `agent.turn.outcome`           | String; number; optional `completed`, `cancelled`, or `failed`.                                        |
| `agent.channel.audience`                                               | Optional `public`, `private`, or `unknown`.                                                            |
| `agent.channel.kind`, `agent.channel.name`, `agent.channel.request.id` | Optional strings.                                                                                      |
| `agent.channel.delivery.id`, `agent.channel.delivery.input`            | Optional string; optional input JSON. Attach only for unique delivery ownership.                       |
| `agent.session.origin`, `agent.session.title`                          | Optional `schedule` or `channel`; optional input text.                                                 |
| `agent.schedule.id`, `agent.subagent.name`                             | Optional strings. Do not inherit schedule ID into children.                                            |
| `agent.parent_call.id`, `agent.parent_run.id`                          | Optional strings.                                                                                      |
| `agent.principal.current.id`, `agent.principal.initiator.id`           | Optional strings subject to capture policy.                                                            |
| `agent.principal.current.type`, `agent.principal.initiator.type`       | Optional `anonymous`, `app`, `local-dev`, `none`, `other`, `runtime`, `service`, `unknown`, or `user`. |
| `agent.trace.content.input`, `agent.trace.content.output`              | Booleans. Describe the effective capture decision.                                                     |

Child activations omit inherited title and channel origin unless they own the
trace-session metadata. Keep this ownership rule in the eve adapter.

### Step and model

| Span  | Attributes                                                                                              | Type and rule                                                                |
| ----- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Step  | `agent.name`, `agent.channel.kind`, `agent.session.origin`                                              | Optional strings; origin is `schedule` or `channel`.                         |
| Step  | `agent.model.id`, `agent.model.provider`                                                                | Optional strings set when a model call starts.                               |
| Step  | `gen_ai.usage.cost`, `gen_ai.usage.gateway_cost`, `gen_ai.usage.input_cost`, `gen_ai.usage.output_cost` | Optional gateway-reported numbers. Do not estimate cost.                     |
| Step  | `gen_ai.generation.id`                                                                                  | Optional gateway generation string.                                          |
| Model | `gen_ai.operation.name`, `gen_ai.provider.name`, `gen_ai.request.model`                                 | `chat`; provider string; model string.                                       |
| Model | `gen_ai.agent.name`, `gen_ai.response.id`, `gen_ai.response.model`                                      | Optional strings.                                                            |
| Model | `gen_ai.response.finish_reasons`                                                                        | Optional string array. Does not require content permission.                  |
| Model | `gen_ai.input.messages`, `gen_ai.system_instructions`                                                   | Optional input JSON in GenAI format.                                         |
| Model | `gen_ai.output.messages`                                                                                | Optional output JSON in GenAI format.                                        |
| Model | `ai.response.finish_reason`, `ai.response.reasoning`, `ai.response.text`                                | Optional output strings. Preserve the current output gate for finish reason. |
| Model | `ai.response.tool_calls`, `ai.response.tool_results`                                                    | Optional output JSON. Includes provider-executed tool results.               |

### Action, tool, and approval

| Span         | Attributes                                                               | Type and rule                                                            |
| ------------ | ------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| Action       | `agent.action.call_id`, `agent.action.name`                              | Strings.                                                                 |
| Action       | `agent.action.kind`                                                      | `load-skill`, `remote-agent-call`, `subagent-call`, or `tool-call`.      |
| Action       | `agent.action.outcome`                                                   | Optional `abandoned`, `cancelled`, `completed`, `failed`, or `rejected`. |
| Action       | `agent.action.error.code`                                                | Optional string.                                                         |
| Action       | `agent.invocation.role`, `gen_ai.agent.name`                             | `caller` and agent string for agent-call actions only.                   |
| Action, tool | `gen_ai.tool.call.arguments`, `gen_ai.tool.call.result`                  | Optional input JSON and output JSON. Agent-call actions omit both.       |
| Tool         | `gen_ai.operation.name`, `gen_ai.tool.type`                              | `execute_tool`; `function`.                                              |
| Tool         | `gen_ai.agent.name`, `gen_ai.tool.call.id`, `gen_ai.tool.name`           | Optional agent string; call string; tool string.                         |
| Approval     | `agent.action.call_id`, `agent.action.name`, `agent.approval.request_id` | Strings.                                                                 |
| Approval     | `agent.approval.kind`                                                    | `tool-approval`.                                                         |
| Approval     | `agent.approval.outcome`                                                 | `approved`, `cancelled`, `denied`, `failed`, `ignored`, or `invalid`.    |
| Approval     | `agent.approval.request`, `agent.approval.response`                      | Optional input JSON and output JSON.                                     |

An error result marks failure even when execution does not throw.
SDK tool hooks can precede action dispatch. Reserve tool context, then attach the
action parent. Drain unresolved tools with the step fallback on attempt exit.

### Memory, request, and MCP

| Span              | Attributes                                                          | Type and rule                                               |
| ----------------- | ------------------------------------------------------------------- | ----------------------------------------------------------- |
| Memory            | `gen_ai.operation.name`                                             | `search_memory` or `upsert_memory`.                         |
| Memory            | `gen_ai.memory.store.id`, `agent.memory.phase`, `agent.memory.slot` | Strings.                                                    |
| Memory            | `agent.turn.id`, `gen_ai.memory.record.count`                       | Optional string; optional number.                           |
| Memory            | `gen_ai.memory.records`                                             | Optional JSON. Retain current input-content classification. |
| Request           | `http.request.method`, `http.route`                                 | Strings. Use a route template, not the concrete path.       |
| Request           | `http.response.status_code`, `url.scheme`, `server.address`         | Optional number; optional strings.                          |
| Request           | `agent.channel.name`, `agent.channel.kind`                          | Optional strings set after channel resolution.              |
| MCP               | `agent.connection.name`, `mcp.method.name`                          | Strings. Also annotate existing tool spans.                 |
| MCP               | `mcp.protocol.version`, `mcp.session.id`, `jsonrpc.request.id`      | Optional strings.                                           |
| MCP               | `rpc.response.status_code`                                          | Optional string.                                            |
| MCP               | `network.protocol.name`, `network.transport`                        | `http`; `tcp`.                                              |
| MCP call          | `gen_ai.operation.name`, `gen_ai.tool.name`                         | `execute_tool`; optional string.                            |
| MCP fallback call | `gen_ai.tool.call.arguments`, `gen_ai.tool.call.result`             | Optional input JSON and output JSON.                        |

Request spans omit bodies, query parameters, credentials, and session IDs.
MCP discovery and fallback spans do not receive common agent identity attributes.

### Events, links, and status

| Owner       | Contract                                                                                                                  |
| ----------- | ------------------------------------------------------------------------------------------------------------------------- |
| Activation  | `turn.started`, then optional `turn.completed`, `turn.cancelled`, or `turn.failed`.                                       |
| Step        | `step.started`, then `step.completed` or `step.failed`.                                                                   |
| Error event | `exception` with permitted `exception.type`, `exception.message`, and `exception.stacktrace`. Retain current size bounds. |
| Link        | Trace reference and `agent.link.type`: `agent.dispatch`, `channel.request`, or `execution.delivery`.                      |
| Status      | OTel status code and optional permitted message. Cancellation alone is not ERROR.                                         |

## Architecture and backend boundary

```text
application turn callback ──> live activation driver ───┐
AI SDK hooks ───────────────> SDK adapter ──────────────┤
                                                       ├─> shared trace engine
eve lifecycle events ──────> eve adapter ──────────────┤       ↓
eve stored state ──────────> durable activation driver ┘  output mapping
                                                               ↓
                                                          OTel backend
                                                               ↓
                                                       destination policies
```

The engine receives prepared identities, metadata, capture decisions, and parent
references. It does not read eve context or environment variables.
Adapters normalize SDK payloads before the engine serializes content.

Use explicit parents to construct the topology. Use OTel `context.with()` to
activate those parents during execution. This permits HTTP and database child
spans. Use the host's installed context manager. Do not replace global setup.
Do not use `enterWith()` to create start/end scopes.

Keep two backend capabilities:

```ts
interface TraceBackend {
  start(span: PreparedSpan): SpanWriter;
  run<T>(reference: TraceReference, capture: CaptureDecision, execute: () => T): T;
  current(): TraceReference | undefined;
}

interface DurableTraceBackend extends TraceBackend {
  reserveActivation(input: {
    key: string;
    span: PreparedSpan;
    capture: CaptureDecision;
  }): TraceReference;
  reserveChild(parent: TraceReference, key: string): TraceReference;
  startReserved(span: PreparedSpan, reference: TraceReference): SpanWriter;
}
```

These backend types are adapter contracts, not authoring scope APIs:

```ts
type Attributes = Readonly<
  Record<string, string | number | boolean | readonly (string | number | boolean)[] | undefined>
>;
interface PreparedSpan {
  type:
    | "activation"
    | "step"
    | "model"
    | "action"
    | "tool"
    | "approval"
    | "memory"
    | "channelRequest"
    | "mcp";
  operationId: string;
  name: string;
  attributes: Attributes;
  kind?: "INTERNAL" | "CLIENT" | "SERVER";
  parent?: TraceReference;
  root?: boolean;
  links?: readonly TraceLink[];
  startTimeMs?: number;
}
interface SpanWriter {
  reference: TraceReference;
  setAttribute(key: string, value: NonNullable<Attributes[string]>): void;
  addEvent(name: string, attributes?: Attributes, timeMs?: number): void;
  fail(error?: unknown, errorType?: string): void;
  setStatus(code: "UNSET" | "OK" | "ERROR"): void;
  end(timeMs?: number): void;
}
```

`Tracer`, `Telemetry`, and `TelemetryOptions` are OTel and AI SDK adapter types.
`ContentSerializer` provides bounded JSON, text, and GenAI message serialization.
`TraceCheckpointer` loads, saves, and removes semantic scope records by key.

Ordinary mode starts a real root. The root sampler supplies the trace flags.
Durable mode reserves IDs and stores timestamps before span emission.
An arbitrary OTel tracer cannot supply reserved-ID support. Use eve's existing
ID generator and sampler preparation path for the first durable backend.

Async context does not cross workers. Persist portable references and capture
decisions for continuation. Keep transport context separate from dispatch links.

## Output overrides and compatibility

Use a private eve output profile in the OTel adapter. Do not add vendor fields
to lifecycle input or create a second span engine. The profile only translates
attributes and link attributes. It cannot change names or trace references.

```ts
interface OutputMapping {
  attributes(span: MappingContext, attributes: Attributes): Attributes;
  link(span: MappingContext, link: TraceLink): Attributes;
}

interface MappingContext {
  type: PreparedSpan["type"];
  operationId: string;
}

interface TraceLink {
  context: TraceReference;
  relationship: "agent.dispatch" | "channel.request" | "execution.delivery";
}
```

The default output uses the neutral attributes above and schema version 1.
Apply overrides to initial attributes, later updates, and root sampler input.
Preserve IDs, topology, kinds, timestamps, and events. Do not map third-party spans.
Mappings cannot restore content denied before span creation.

The eve wrapper lives in `adapters/eve/compatibility.ts`:

```ts
const backend = liveOtelBackend(tracer, eveOutputMapping());
```

Runtime records supply platform and trace-session attribution from existing eve
state. Do not parse operation IDs or use an unbounded global metadata map.
Keep attribution until deferred span emission finishes.

| Neutral contract                                   | Existing eve output                                                     |
| -------------------------------------------------- | ----------------------------------------------------------------------- |
| `agent.trace.schema.version=1`                     | Replace with `agent.trace.schema.version=4`.                            |
| Link `agent.dispatch`                              | Write `eve.link.type=agent.dispatch`.                                   |
| Link `channel.request`                             | Write `eve.link.type=channel.request`.                                  |
| Link `execution.delivery`                          | Write `eve.link.type=workflow.delivery`.                                |
| Request `agent.channel.name`, `agent.channel.kind` | Rename to `eve.channel.name`, `eve.channel.kind` on request spans only. |
| MCP `agent.connection.name`                        | Rename to `eve.connection.name` on MCP spans and tool updates.          |
| Adapter trace-session attribution                  | Add `vercel.session_id` only on Vercel spans with agent identity.       |
| Other names, attributes, events, and links         | Retain current values without duplicate aliases.                        |

Keep activation `agent.channel.*` keys unchanged. Set framework name and version
from the actual caller. eve installation retains its existing tracer scopes.
Apply compatibility before destination policies. Existing filters must see the
existing keys. Do not repeat compatibility mapping in the Agent Runs exporter.

Protocol adapters retain current `eve` tracestate and baggage formats. Those
formats do not belong in the core API. Transport compatibility is separate from
output mapping and authorization.

## eve adoption and durable state

Configure `checkpointer` once through a runtime-owned `TraceCheckpointer` adapter.
The adapter loads, saves, and removes serializable records in the existing
workflow checkpoint. The library does not create a separate checkpoint.

Internal runtime bindings supply stable operation keys. Scope construction
restores or creates the corresponding record. The record retains ancestry,
reserved identity, start time, capture permission, and semantic operation data.
Only the application runtime controls suspension, replay, and retry.
Tracing must never invoke earlier application callbacks during restoration.

Lifecycle is the lower-level API. The callback DSL uses lifecycle construction,
`started()`, `completed()`, and `failed()` internally. SDK hooks and eve events
use that same implementation. The backend accepts opaque host context explicitly;
no adapter captures a raw span or wraps it with `Proxy`.

eve can project its existing durable records into runtime scope bindings.
Do not add a second persistence owner or expose those bindings to tool authors.

Keep `createAgentOtelInstrumentation()` as the installation entry point.
Replace its span construction with calls to the shared engine.
Keep the current bus, context runner, and authored instrumentation interfaces.

Do not change serialized formats during the first extraction.
Durable actions and approvals can outlive a step. Callback return does not finish
them. eve terminal events remain the completion authority.
eve retains its event bridge instead of installing the standalone SDK adapter.
SDK step completion does not
replace framework completion after durable action resolution.

## Export, privacy, and failure rules

- Ordinary mode records no content by default. Permit inputs and outputs separately.
- eve resolves audience and trusted forwarding before it supplies a capture decision.
- Delegation and continuation must not increase capture permission.
- Retain bounded GenAI JSON, text, and exception serialization.
- Keep destination filtering outside the engine. Do not mutate shared spans.
- Retain the current content classifier, including third-party `ai.*` attributes.
- Redaction removes denied content, exception details, and status messages.
- Instrumentation failures must not replace application results or errors.
- End unfinished live model and tool spans on attempt termination.

Keep global registration, local trace storage, replay deduplication, and parent
export ordering in eve installation code. Keep CLI telemetry separate.

The Agent Runs destination retains the current Vercel request-context transport.
Export before that context becomes unavailable. Preserve resource attributes and
instrumentation scope in OTLP. Keep automatic deployment configuration in eve.
Trace topology alone does not guarantee Agent Runs availability.

## Delivery and validation

Keep runtime behavior in `packages/eve` through internal adoption.
Before public release, validate eve adoption and an internal standalone SDK consumer.

Compare mapped output with each current source writer. Check late MCP updates,
deferred roots, sampler inputs, and destination filters. Check that neutral
output has no `eve.*` keys or `vercel.session_id`.

Check parallel turns, tool races, SDK retries, streaming, cancellation, and root
sampling. Check denied content after delegation and continuation.
Check `eve traces` rendering and usage totals. Add fixture-owned activation and
delegation e2e coverage. Run e2e in CI.

## Source contract

- [Activation, step, and model](../packages/eve/src/tracing/agent-otel-provider.ts).
- [Activation metadata](../packages/eve/src/tracing/adapters/eve/metadata.ts).
- [Action](../packages/eve/src/tracing/agent-action-instrumentation.ts).
- [Tool execution](../packages/eve/src/tracing/agent-tool-instrumentation.ts).
- [Approval](../packages/eve/src/tracing/agent-approval-instrumentation.ts).
- [Memory](../packages/eve/src/tracing/agent-memory-instrumentation.ts).
- [Request](../packages/eve/src/internal/nitro/routes/channel-request-instrumentation.ts).
- [MCP](../packages/eve/src/runtime/connections/mcp-tracing.ts).
- [Content classification](../packages/eve/src/tracing/content-attributes.ts).
- [Vercel export](../packages/eve/src/tracing/vercel-runtime-span-exporter.ts).
