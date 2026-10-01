import { describe, expect, it } from "vitest";

import {
  createRuntimeToolResultFromToolError,
  createRuntimeToolResultFromValue,
} from "#harness/action-result-helpers.js";
import { modelFacingRemoteInputOutput, requestRemoteInput } from "#harness/remote-input.js";

describe("createRuntimeToolResultFromValue", () => {
  it("rejects non-JSON-serializable successful action results", () => {
    expect(() =>
      createRuntimeToolResultFromValue({
        callId: "call_timestamp",
        output: { now: new Date("2026-01-02T03:04:05.000Z") },
        toolName: "timestamp",
      }),
    ).toThrow(
      'Tool "timestamp" call "call_timestamp" produced a non-JSON-serializable action result. Expected a JSON-serializable value.',
    );
  });

  it("normalizes top-level undefined action results to null", () => {
    expect(
      createRuntimeToolResultFromValue({
        callId: "call_empty",
        output: undefined,
        toolName: "empty",
      }),
    ).toEqual({
      callId: "call_empty",
      kind: "tool-result",
      output: null,
      toolName: "empty",
    });
  });

  it("projects Error instances for failed action results to their message", () => {
    expect(
      createRuntimeToolResultFromValue({
        callId: "call_failed",
        isError: true,
        output: new Error("tool failed"),
        toolName: "broken",
      }),
    ).toEqual({
      callId: "call_failed",
      isError: true,
      kind: "tool-result",
      output: "tool failed",
      toolName: "broken",
    });
  });
});

describe("createRuntimeToolResultFromToolError", () => {
  it("projects AI SDK tool-error parts as failed action results", () => {
    expect(
      createRuntimeToolResultFromToolError({
        error: new Error('No skill named "demo"'),
        input: { skill: "demo" },
        toolCallId: "call_load_skill",
        toolName: "load_skill",
        type: "tool-error",
      }),
    ).toEqual({
      callId: "call_load_skill",
      isError: true,
      kind: "tool-result",
      output: 'No skill named "demo"',
      toolName: "load_skill",
    });
  });
});

describe("createRuntimeToolResultFromValue with a remote input signal", () => {
  const signal = requestRemoteInput({
    approve: {
      attempt: 1,
      inputResponses: { confirm: { action: "accept", content: { approved: true } } },
      requestState: "opaque-state-SECRET",
    },
    connection: "billing",
    prompt: "Approve the refund?",
  });

  it.each([
    ["the full signal", signal],
    ["the model-facing output", modelFacingRemoteInputOutput(signal)],
  ])("projects %s without the retry payload", (_label, output) => {
    const result = createRuntimeToolResultFromValue({
      callId: "call_1",
      output,
      toolName: "connection_execute",
    });
    expect(result.output).toEqual({ __eveRemoteInputPending: true, connection: "billing" });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("requestState");
    expect(serialized).not.toContain("opaque-state-SECRET");
    expect(serialized).not.toContain("inputResponses");
    expect(serialized).not.toContain("Approve the refund?");
  });
});
