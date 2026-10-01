/**
 * Remote input: a typed tool interrupt for a remote server that needs the
 * calling turn's user before it can finish a call (an MCP `input_required`
 * with an approval form, from another eve agent's `mcpChannel`).
 *
 * ## Lifecycle
 *
 * 1. **Interrupt.** The tool returns a {@link RemoteInputSignal}. The tools
 *    wrapper stashes the full signal and hands the AI SDK an opaque
 *    {@link RemoteInputPendingOutput}, so the retry payload (`requestState`)
 *    never reaches the model, telemetry, or `action.result`.
 * 2. **Park.** {@link parkRemoteInputs} turns each signal into a
 *    `tool-approval` input request on the call: it drops the pending tool
 *    result, records a `tool-approval-request` part for the call, and
 *    journals the retry payload and the expected responder on
 *    `session.state`. The turn parks and emits `input.requested` like any
 *    approval, so every channel renders it unchanged.
 * 3. **Answer.** The approval delivery coordinator accepts an answer only
 *    from the journaled responder ({@link checkRemoteInputResponder}): a
 *    different person is refused and the request stays pending; an answer
 *    whose channel cannot name its responder fails the call closed.
 * 4. **Continue.** On approve, {@link loadRemoteInputContinuations} moves
 *    the retry payload into virtual context and the AI SDK re-runs the
 *    approved call; the tool reads it with
 *    {@link takeRemoteInputContinuation} and retries with the answer. On
 *    deny, the call ends as denied and nothing is sent back.
 */

import type { ModelMessage, ToolSet, TypedToolResult } from "ai";

import type { SessionAuthContext } from "#channel/types.js";
import { contextStorage, type AlsContext } from "#context/container.js";
import { ContextKey } from "#context/key.js";
import { readToolInterrupt } from "#harness/tool-interrupts.js";
import { createRuntimeToolCallActionFromToolCall } from "#harness/tool-call-action.js";
import type { HarnessSession, SessionStateMap } from "#harness/types.js";
import { isObject } from "#shared/guards.js";
import type { InputRequest } from "#shared/input.js";

const REMOTE_INPUT_SIGNAL_BRAND = "__eveRemoteInputSignal";
const REMOTE_INPUT_PENDING_BRAND = "__eveRemoteInputPending";
const PENDING_REMOTE_INPUTS_KEY = "eve.runtime.pendingRemoteInputs";
const REQUEST_ID_PREFIX = "remote-input_";

/** Opaque retry payload: sent back to the server on approve, never inspected here. */
export interface RemoteInputRetry {
  /** How many times this call has already asked; bounds sign-in re-asks. Not sent. */
  readonly attempt?: number;
  readonly inputResponses?: Readonly<Record<string, unknown>>;
  readonly requestState?: string;
}

/** Returned from a tool's `execute` to park the call until its user answers. */
export interface RemoteInputSignal {
  readonly [REMOTE_INPUT_SIGNAL_BRAND]: true;
  /** What the call retries with when the user approves. */
  readonly approve: RemoteInputRetry;
  /** Connection that asked, for the model-facing placeholder. */
  readonly connection: string;
  /** The server's question, shown to the user. */
  readonly prompt: string;
}

/** Model-facing stand-in for a {@link RemoteInputSignal}: no prompt, no retry payload. */
export interface RemoteInputPendingOutput {
  readonly [REMOTE_INPUT_PENDING_BRAND]: true;
  readonly connection: string;
}

export function requestRemoteInput(input: {
  readonly approve: RemoteInputRetry;
  readonly connection: string;
  readonly prompt: string;
}): RemoteInputSignal {
  return { [REMOTE_INPUT_SIGNAL_BRAND]: true, ...input };
}

export function isRemoteInputSignal(value: unknown): value is RemoteInputSignal {
  return isObject(value) && value[REMOTE_INPUT_SIGNAL_BRAND] === true;
}

export function isRemoteInputPendingOutput(value: unknown): value is RemoteInputPendingOutput {
  return isObject(value) && value[REMOTE_INPUT_PENDING_BRAND] === true;
}

/** Whether a tool output is a remote input interrupt, full or model-facing. */
export function isPendingRemoteInputToolOutput(value: unknown): boolean {
  return isRemoteInputSignal(value) || isRemoteInputPendingOutput(value);
}

export function modelFacingRemoteInputOutput(signal: RemoteInputSignal): RemoteInputPendingOutput {
  return { [REMOTE_INPUT_PENDING_BRAND]: true, connection: signal.connection };
}

export function remoteInputPendingModelText(connection: string): string {
  return `Waiting for the user to answer a request from connection "${connection}".`;
}

// ---------------------------------------------------------------------------
// Journal
// ---------------------------------------------------------------------------

/** One parked remote input, journaled on `session.state` across the park. */
export interface PendingRemoteInput {
  readonly callId: string;
  readonly connection: string;
  readonly requestId: string;
  /** The only person whose answer counts: the user the call ran for. */
  readonly responder: SessionAuthContext | null;
  readonly retry: RemoteInputRetry;
}

export function getPendingRemoteInputs(
  state: SessionStateMap | undefined,
): readonly PendingRemoteInput[] {
  const value = state?.[PENDING_REMOTE_INPUTS_KEY];
  return Array.isArray(value) ? (value as PendingRemoteInput[]) : [];
}

export function getPendingRemoteInput(
  state: SessionStateMap | undefined,
  requestId: string,
): PendingRemoteInput | undefined {
  return getPendingRemoteInputs(state).find((entry) => entry.requestId === requestId);
}

function setPendingRemoteInputs(
  state: SessionStateMap | undefined,
  entries: readonly PendingRemoteInput[],
): SessionStateMap {
  const { [PENDING_REMOTE_INPUTS_KEY]: _previous, ...rest } = state ?? {};
  return entries.length === 0 ? rest : { ...rest, [PENDING_REMOTE_INPUTS_KEY]: [...entries] };
}

/** Whether an input request is a remote input (journaled by {@link parkRemoteInputs}). */
export function isRemoteInputRequestId(requestId: string): boolean {
  return requestId.startsWith(REQUEST_ID_PREFIX);
}

// ---------------------------------------------------------------------------
// Park
// ---------------------------------------------------------------------------

/**
 * Converts this step's remote input interrupts into approval requests on
 * their calls. Returns `undefined` when no tool interrupted for remote input.
 *
 * A signal whose call is not in `messages` (a call resumed from an earlier
 * step) cannot be parked; its result becomes an error instead.
 */
export function parkRemoteInputs(input: {
  readonly messages: readonly ModelMessage[];
  readonly responder: SessionAuthContext | null;
  readonly state: SessionStateMap | undefined;
  readonly toolResults: readonly TypedToolResult<ToolSet>[] | undefined;
}):
  | {
      readonly messages: ModelMessage[];
      readonly requests: InputRequest[];
      readonly state: SessionStateMap;
    }
  | undefined {
  const signals = new Map<string, RemoteInputSignal>();
  for (const toolResult of input.toolResults ?? []) {
    const signal = readRemoteInputSignal(toolResult);
    if (signal !== undefined) signals.set(toolResult.toolCallId, signal);
  }
  if (signals.size === 0) return undefined;

  const requests: InputRequest[] = [];
  const entries: PendingRemoteInput[] = [];
  const parked = new Set<string>();
  const messages: ModelMessage[] = [];
  for (const message of input.messages) {
    if (message.role !== "assistant" || typeof message.content === "string") {
      messages.push(message);
      continue;
    }
    const content: (typeof message.content)[number][] = [];
    for (const part of message.content) {
      content.push(part);
      if (part.type !== "tool-call") continue;
      const signal = signals.get(part.toolCallId);
      if (signal === undefined) continue;
      const requestId = `${REQUEST_ID_PREFIX}${part.toolCallId}`;
      content.push({
        approvalId: requestId,
        toolCallId: part.toolCallId,
        type: "tool-approval-request",
      });
      requests.push({
        action: createRuntimeToolCallActionFromToolCall({ toolCall: part }),
        allowFreeform: false,
        display: "confirmation",
        kind: "tool-approval",
        options: [
          { id: "approve", label: "Approve" },
          { id: "cancel", label: "Cancel" },
        ],
        prompt: signal.prompt,
        requestId,
      });
      entries.push({
        callId: part.toolCallId,
        connection: signal.connection,
        requestId,
        responder: input.responder,
        retry: signal.approve,
      });
      parked.add(part.toolCallId);
    }
    messages.push({ ...message, content });
  }

  const projected = messages.flatMap((message): ModelMessage[] => {
    if (message.role !== "tool") return [message];
    const content = message.content.flatMap((part) => {
      if (part.type !== "tool-result" || !signals.has(part.toolCallId)) return [part];
      if (parked.has(part.toolCallId)) return [];
      return [
        {
          ...part,
          output: {
            type: "error-text" as const,
            value:
              `Connection "${signals.get(part.toolCallId)!.connection}" asked for input on a ` +
              "resumed call, which eve cannot ask about. Call the tool again.",
          },
        },
      ];
    });
    return content.length === 0 ? [] : [{ ...message, content }];
  });

  return {
    messages: projected,
    requests,
    state: setPendingRemoteInputs(input.state, [
      ...getPendingRemoteInputs(input.state).filter(
        (entry) => !entries.some((next) => next.callId === entry.callId),
      ),
      ...entries,
    ]),
  };
}

function readRemoteInputSignal(
  toolResult: TypedToolResult<ToolSet>,
): RemoteInputSignal | undefined {
  if (isRemoteInputSignal(toolResult.output)) return toolResult.output;
  if (!isRemoteInputPendingOutput(toolResult.output)) return undefined;
  const ctx = contextStorage.getStore();
  const stashed = ctx === undefined ? undefined : readToolInterrupt(ctx, toolResult.toolCallId);
  return isRemoteInputSignal(stashed) ? stashed : undefined;
}

// ---------------------------------------------------------------------------
// Answer
// ---------------------------------------------------------------------------

/**
 * Who may answer a remote input request:
 *
 * - `accept`: the user the call ran for.
 * - `refuse`: someone else. The request stays pending for the right person.
 * - `fail-closed`: nobody can be named (the channel reports no responder, or
 *   the call ran for no authenticated user). The call fails as cancelled.
 *
 * `undefined` when `requestId` is not a parked remote input.
 */
export function checkRemoteInputResponder(
  state: SessionStateMap | undefined,
  requestId: string,
  responder: SessionAuthContext | null,
): "accept" | "fail-closed" | "refuse" | undefined {
  const entry = getPendingRemoteInput(state, requestId);
  if (entry === undefined) return undefined;
  if (entry.responder === null || responder === null) return "fail-closed";
  return samePerson(entry.responder, responder) ? "accept" : "refuse";
}

export const REMOTE_INPUT_REFUSED_FEEDBACK =
  "Only the person this request was made for can answer it.";
export const REMOTE_INPUT_FAILED_CLOSED_FEEDBACK =
  "This request was cancelled: only the person it was made for can answer it, " +
  "and this answer did not say who sent it.";

function samePerson(left: SessionAuthContext, right: SessionAuthContext): boolean {
  return (
    left.authenticator === right.authenticator &&
    left.issuer === right.issuer &&
    left.principalType === right.principalType &&
    left.principalId === right.principalId
  );
}

// ---------------------------------------------------------------------------
// Continue
// ---------------------------------------------------------------------------

const RemoteInputContinuationsKey = new ContextKey<Readonly<Record<string, RemoteInputRetry>>>(
  "eve.remoteInputContinuations",
);

/**
 * Settles journaled remote inputs whose requests resolved this step. An
 * approved one becomes a continuation the re-run call reads; a denied one is
 * dropped. Entries whose request is no longer pending are pruned.
 */
export function loadRemoteInputContinuations(input: {
  readonly context: AlsContext | undefined;
  readonly pendingRequestIds: ReadonlySet<string>;
  readonly resolved:
    | readonly {
        readonly inputs: readonly {
          readonly outcome: string;
          readonly request: Pick<InputRequest, "requestId">;
        }[];
      }[]
    | undefined;
  readonly session: HarnessSession;
}): HarnessSession {
  const entries = getPendingRemoteInputs(input.session.state);
  if (entries.length === 0) return input.session;
  const outcomes = new Map<string, string>();
  for (const batch of input.resolved ?? []) {
    for (const resolved of batch.inputs) outcomes.set(resolved.request.requestId, resolved.outcome);
  }
  const continuations: Record<string, RemoteInputRetry> = {};
  const remaining: PendingRemoteInput[] = [];
  for (const entry of entries) {
    const outcome = outcomes.get(entry.requestId);
    if (outcome === "approved") continuations[entry.callId] = entry.retry;
    else if (outcome === undefined && input.pendingRequestIds.has(entry.requestId)) {
      remaining.push(entry);
    }
  }
  if (Object.keys(continuations).length > 0) {
    input.context?.setVirtualContext(RemoteInputContinuationsKey, {
      ...input.context.get(RemoteInputContinuationsKey),
      ...continuations,
    });
  }
  if (remaining.length === entries.length) return input.session;
  return { ...input.session, state: setPendingRemoteInputs(input.session.state, remaining) };
}

/**
 * The approved answer for a call parked on remote input, when this run is
 * its continuation. Each continuation is read once.
 */
export function takeRemoteInputContinuation(callId: string): RemoteInputRetry | undefined {
  const ctx = contextStorage.getStore();
  const continuations = ctx?.get(RemoteInputContinuationsKey);
  const continuation = continuations?.[callId];
  if (ctx === undefined || continuation === undefined) return undefined;
  const { [callId]: _taken, ...rest } = continuations!;
  ctx.setVirtualContext(RemoteInputContinuationsKey, rest);
  return continuation;
}
