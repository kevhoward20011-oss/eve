import { describe, expect, it } from "vitest";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { createAgentTracing } from "#tracing/core/agent-tracing.js";
import {
  createTraceLifecycle,
  type TraceCheckpointer,
  type ScopeRecord,
} from "#tracing/core/scopes.js";
import { durableOtelBackend, liveOtelBackend } from "#tracing/adapters/otel.js";
import { aiSdkContentSerializer } from "#tracing/adapters/serializer.js";
import { AgentSpanIdGenerator } from "#tracing/agent-span-id-generator.js";

describe("constructed agent trace scopes", () => {
  it("constructs a complete callback topology without exposing spans or persistence", async () => {
    const exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    try {
      const tracing = createAgentTracing({
        backend: liveOtelBackend(provider.getTracer("dsl")),
        agentName: "support",
        framework: { name: "custom", version: "1" },
        serializer: aiSdkContentSerializer,
      });
      const value = await tracing.turn(
        { conversationId: "conversation", runId: "run", turnId: "turn", sequence: 0 },
        (turn) =>
          turn.step({ index: 0 }, async (step) => {
            await step.model(
              { provider: "provider", modelId: "model" },
              async () => "answer",
              () => ({ finishReason: "stop", usage: { inputTokens: 3, outputTokens: 2 } }),
            );
            return step.action({ callId: "lookup", name: "lookup" }, async (action) => {
              expect(
                "checkpoint" in action ||
                  "resume" in action ||
                  "setAttribute" in action ||
                  "step" in action ||
                  "action" in action,
              ).toBe(false);
              await action.approval({ requestId: "request" }, async () => true);
              return action.tool(async () => "result");
            });
          }),
      );
      expect(value).toBe("result");
      const spans = exporter.getFinishedSpans();
      const root = spans.find((span) => span.name === "invoke_agent support")!;
      const step = spans.find((span) => span.name === "agent.step")!;
      const action = spans.find((span) => span.name === "agent.action")!;
      expect(step.parentSpanContext?.spanId).toBe(root.spanContext().spanId);
      expect(action.parentSpanContext?.spanId).toBe(step.spanContext().spanId);
      expect(spans.find((span) => span.name === "chat model")!.parentSpanContext?.spanId).toBe(
        step.spanContext().spanId,
      );
      expect(
        spans
          .filter((span) => span.name === "agent.approval" || span.name === "execute_tool lookup")
          .every((span) => span.parentSpanContext?.spanId === action.spanContext().spanId),
      ).toBe(true);
      expect(root.attributes["gen_ai.usage.input_tokens"]).toBe(3);
    } finally {
      await provider.shutdown();
    }
  });

  it("exposes lifecycle beneath the DSL and starts and settles operations once", async () => {
    const exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    try {
      const tracing = createAgentTracing({
        backend: liveOtelBackend(provider.getTracer("lifecycle")),
        agentName: "support",
        framework: { name: "custom", version: "1" },
        serializer: aiSdkContentSerializer,
      });
      const turn = await tracing.lifecycle.turn(
        {
          conversationId: "conversation",
          runId: "run",
          turnId: "turn",
          agentName: "support",
          framework: { name: "custom", version: "1" },
        },
        { sequence: 0 },
        { emit: true, recordInputs: false, recordOutputs: false },
      );
      const step = await turn.step({ index: 0 });
      await step.started();
      await step.started();
      const action = await step.action({ callId: "call", name: "lookup" });
      const tool = await action.tool();
      await tool.completed({ output: "private" });
      await tool.completed({ output: "duplicate" });
      await action.completed();
      await step.completed();
      await turn.completed();
      const spans = exporter.getFinishedSpans();
      expect(spans.filter((span) => span.name === "execute_tool lookup")).toHaveLength(1);
      expect(
        spans.find((span) => span.name === "agent.step")!.events.map((event) => event.name),
      ).toEqual(["step.started", "step.completed"]);
      expect(JSON.stringify(spans.map((span) => span.attributes))).not.toContain("private");
    } finally {
      await provider.shutdown();
    }
  });

  it("restores a suspended action in a new runtime without replaying callbacks or broadening capture", async () => {
    const exporter = new InMemorySpanExporter();
    const idGenerator = new AgentSpanIdGenerator();
    const provider = new BasicTracerProvider({
      idGenerator,
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    const records = new Map<string, ScopeRecord>();
    const checkpointer: TraceCheckpointer = {
      load: async (key) => records.get(key),
      save: async (record) => {
        records.set(record.key, JSON.parse(JSON.stringify(record)) as ScopeRecord);
      },
      remove: async (key) => {
        records.delete(key);
      },
    };
    try {
      const backend = durableOtelBackend({
        tracer: provider.getTracer("durable-dsl"),
        idGenerator,
        samplesTrace: () => true,
      });
      const options = { backend, serializer: aiSdkContentSerializer, checkpointer };
      const before = createTraceLifecycle(options);
      const capture = { emit: true, recordInputs: false, recordOutputs: false };
      const turn = await before.turn(
        {
          conversationId: "conversation",
          runId: "run",
          turnId: "turn",
          agentName: "support",
          framework: { name: "custom", version: "1" },
        },
        { sequence: 0 },
        capture,
        { key: "turn" },
      );
      const step = await turn.step({ index: 0 }, { key: "step" });
      const action = await step.action(
        { callId: "call", name: "lookup", arguments: "secret input" },
        { key: "action" },
      );
      await action.approval(
        { requestId: "request", request: "secret request" },
        { key: "approval" },
      );
      const original = action.reference;
      expect(exporter.getFinishedSpans()).toHaveLength(0);
      expect(JSON.stringify([...records.values()])).not.toContain("secret input");
      const after = createTraceLifecycle(options);
      const restored = await after.restore("action", {
        emit: true,
        recordInputs: true,
        recordOutputs: true,
      });
      await (await after.restore("approval", capture))!.finish({ outcome: "approved" });
      expect(restored!.reference).toEqual(original);
      let executions = 0;
      await (restored!.authoring as import("#tracing/core/scopes.js").ActionScope).tool(
        async () => {
          executions++;
          return "secret output";
        },
      );
      await restored!.finish({ output: "secret output" });
      await (await after.restore("step", capture))!.finish();
      await (await after.restore("turn", capture))!.finish();
      expect(executions).toBe(1);
      expect(records.size).toBe(0);
      const spans = exporter.getFinishedSpans();
      expect(
        spans.find((span) => span.name === "execute_tool lookup")!.parentSpanContext?.spanId,
      ).toBe(original.spanId);
      expect(spans.find((span) => span.name === "agent.action")!.spanContext().spanId).toBe(
        original.spanId,
      );
      expect(spans.find((span) => span.name === "agent.approval")!.parentSpanContext?.spanId).toBe(
        original.spanId,
      );
      expect(JSON.stringify(spans.map((span) => span.attributes))).not.toContain("secret");
    } finally {
      await provider.shutdown();
    }
  });
});
