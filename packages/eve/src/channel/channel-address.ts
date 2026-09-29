import type { UserContent } from "ai";

import type { ChannelAdapter } from "#channel/adapter.js";
import {
  createChannelDeliveryMetadata,
  type ChannelDeliverySource,
} from "#channel/delivery-metadata.js";
import type { SendPayload } from "#channel/routes.js";
import { normalizeSendInput, serializeUrlFilePartsInMessage } from "#channel/send-input.js";
import { createSession, sessionCallbackToTurnCaller, type Session } from "#channel/session.js";
import type {
  CancelTurnResult,
  ClearSessionResult,
  CompactSessionResult,
  ResetSessionResult,
  RunInput,
  Runtime,
  SessionAuthContext,
  SessionCallback,
  SessionCommand,
  TurnPolicy,
} from "#channel/types.js";
import { DEFAULT_TURN_POLICY } from "#channel/types.js";
import { OccurrenceAdmissionPendingError } from "#shared/occurrence-admission-errors.js";
import { isReservedSessionCommandToken } from "#execution/session-inbox/address.js";

interface BaseChannelAddressDeliveryOptions {
  readonly auth: SessionAuthContext | null;
  readonly callback?: SessionCallback;
  readonly initiatorAuth?: SessionAuthContext | null;
  readonly title?: string;
  readonly turnPolicy?: TurnPolicy;
}

/** Delivery options for a channel address whose continuation token is already bound. */
export type ChannelAddressDeliveryOptions<TState = undefined> = [TState] extends [undefined]
  ? BaseChannelAddressDeliveryOptions
  : BaseChannelAddressDeliveryOptions & { readonly state?: Partial<TState> };

/**
 * Dynamic handle for whichever durable session currently owns one channel-local address.
 * Only {@link send} may create a session when the address is unowned.
 */
interface ChannelAddress<TState = undefined> {
  readonly continuationToken: string;
  deliver(input: SendPayload, options: ChannelAddressDeliveryOptions<TState>): Promise<Session>;
  send(
    message: string | UserContent,
    options: ChannelAddressDeliveryOptions<TState>,
  ): Promise<Session>;
  respond(
    inputResponses: SendPayload["inputResponses"],
    options: ChannelAddressDeliveryOptions<TState>,
  ): Promise<Session>;
  cancel(options?: { readonly turnId?: string }): Promise<CancelTurnResult>;
  compact(): Promise<CompactSessionResult>;
  clear(): Promise<ClearSessionResult>;
  reset(options?: { readonly reason?: string }): Promise<ResetSessionResult>;
  resolveSession(): Promise<Session | undefined>;
}

/** Factory for binding a route-local continuation token to a {@link ChannelAddress}. */
type ChannelAddressFn<TState = undefined> = (continuationToken: string) => ChannelAddress<TState>;

/** Creates one channel address backed by the runtime's continuation dispatch primitive. */
export function createChannelAddress<TState = undefined>(input: {
  readonly adapter: ChannelAdapter<any>;
  readonly channelName: string;
  readonly continuationToken: string;
  readonly metadata?: ChannelDeliverySource;
  readonly runtime: Runtime;
  readonly turnPolicy?: TurnPolicy;
  readonly requestInput?: boolean;
  /** Recover an active occurrence without redelivering its request. */
  readonly occurrenceToken?: string;
}): ChannelAddress<TState> {
  const metadata: Partial<ChannelDeliverySource> = input.metadata ?? {};
  const namespacedToken = `${input.channelName}:${input.continuationToken}`;
  if (isReservedSessionCommandToken(namespacedToken)) {
    throw new Error(`Channel address "${namespacedToken}" uses eve's reserved session namespace.`);
  }

  return {
    continuationToken: input.continuationToken,
    async deliver(sendInput, options) {
      const delivery =
        metadata.channelKind !== undefined && metadata.channelName !== undefined
          ? createChannelDeliveryMetadata(metadata as ChannelDeliverySource)
          : undefined;
      const payload = normalizeSendInput(sendInput);
      const caller = sessionCallbackToTurnCaller(options.callback);
      const commandWithoutCaller = {
        auth: options.auth,
        delivery,
        kind: "send" as const,
        payload: {
          ...payload,
          message: serializeUrlFilePartsInMessage(payload.message),
        },
        requestId: metadata.requestId,
        turnPolicy:
          payload.message === undefined
            ? undefined
            : (options.turnPolicy ?? input.turnPolicy ?? DEFAULT_TURN_POLICY),
      };
      const command: Extract<SessionCommand, { readonly kind: "send" }> =
        caller === undefined ? commandWithoutCaller : { ...commandWithoutCaller, caller };
      const occurrenceToken = input.occurrenceToken;
      const continuationToken = namespacedToken;
      const dispatch = async (): Promise<Session | undefined> => {
        if (occurrenceToken !== undefined) {
          const owner = await input.runtime.resolveContinuation(occurrenceToken);
          if (owner === undefined) return undefined;
          return createSession(owner.sessionId, input.runtime, {
            ...metadata,
            turnPolicy: input.turnPolicy,
          });
        }
        const result = await input.runtime.dispatchContinuation({
          command,
          continuationToken: namespacedToken,
        });
        return result.status === "accepted"
          ? createSession(result.sessionId, input.runtime, {
              ...metadata,
              turnPolicy: input.turnPolicy,
            })
          : undefined;
      };

      const existing = await dispatch();
      if (existing !== undefined) return existing;
      if (payload.inputResponses && payload.inputResponses.length > 0) {
        throw new Error(
          "Cannot deliver inputResponses — the target session was not found via continuation token.",
        );
      }

      const state = (options as { readonly state?: TState }).state;
      const adapter =
        state === undefined
          ? input.adapter
          : {
              ...input.adapter,
              state: { ...input.adapter.state, ...(state as Record<string, unknown>) },
            };
      const runInput: Omit<RunInput, "occurrenceToken"> & { occurrenceToken?: string } = {
        adapter,
        auth: options.auth,
        capabilities: { requestInput: input.requestInput ?? true },
        callback: options.callback,
        channelName: input.channelName,
        continuationConflictCommand: occurrenceToken === undefined ? command : undefined,
        continuationToken,
        delivery,
        initiatorAuth: options.initiatorAuth,
        input: {
          context: payload.context,
          message: serializeUrlFilePartsInMessage(payload.message) ?? "",
          outputSchema: payload.outputSchema,
          state: payload.state,
        },
        requestId: metadata.requestId,
        title: options.title,
      };
      if (occurrenceToken !== undefined) runInput.occurrenceToken = occurrenceToken;
      const handle = await input.runtime.createSession(runInput);
      const sessionId =
        occurrenceToken === undefined
          ? handle.sessionId
          : await resolveCreateOnceOwner(input.runtime, occurrenceToken);
      return createSession(sessionId, input.runtime, {
        ...metadata,
        turnPolicy: input.turnPolicy,
      });
    },
    async send(message, options) {
      return await this.deliver({ message }, options);
    },
    async respond(inputResponses, options) {
      if (inputResponses === undefined || inputResponses.length === 0) {
        throw new Error("respond() requires at least one input response.");
      }
      return await this.deliver({ inputResponses }, options);
    },
    async cancel(options) {
      return await input.runtime.dispatchContinuation({
        command: { kind: "cancel", turnId: options?.turnId },
        continuationToken: namespacedToken,
      });
    },
    async compact() {
      return await input.runtime.dispatchContinuation({
        command: { kind: "compact" },
        continuationToken: namespacedToken,
      });
    },
    async clear() {
      return await input.runtime.dispatchContinuation({
        command: { kind: "clear" },
        continuationToken: namespacedToken,
      });
    },
    async reset(options) {
      return await input.runtime.dispatchContinuation({
        command: { kind: "reset", reason: options?.reason },
        continuationToken: namespacedToken,
      });
    },
    async resolveSession() {
      const owner = await input.runtime.resolveContinuation(namespacedToken);
      return owner === undefined
        ? undefined
        : createSession(owner.sessionId, input.runtime, {
            ...metadata,
            turnPolicy: input.turnPolicy,
          });
    },
  };
}

const CREATE_ONCE_OWNER_TIMEOUT_MS = 5_000;
const CREATE_ONCE_OWNER_POLL_MS = 20;

/** Thrown when a create-once claim has not settled; callers should retry the delivery. */
export class CreateOnceClaimPendingError extends Error {
  readonly continuationToken: string;
  constructor(continuationToken: string) {
    super(`Create-once claim "${continuationToken}" did not settle; retry the delivery.`);
    this.name = "CreateOnceClaimPendingError";
    this.continuationToken = continuationToken;
  }
}

/**
 * Continuation claims settle inside workflow startup, so a redelivered
 * occurrence may start a workflow that loses the claim. Only a resolved
 * claim identifies the admitted session; an unsettled claim is never
 * reported as admitted.
 */
export async function resolveCreateOnceOwner(
  runtime: Runtime,
  continuationToken: string,
  options: { readonly timeoutMs?: number } = {},
): Promise<string> {
  const deadline = Date.now() + (options.timeoutMs ?? CREATE_ONCE_OWNER_TIMEOUT_MS);
  while (true) {
    try {
      const owner = await runtime.resolveContinuation(continuationToken);
      if (owner !== undefined) return owner.sessionId;
    } catch (error) {
      if (!(error instanceof OccurrenceAdmissionPendingError)) throw error;
    }
    if (Date.now() >= deadline) throw new CreateOnceClaimPendingError(continuationToken);
    await new Promise<void>((resolve) => setTimeout(resolve, CREATE_ONCE_OWNER_POLL_MS));
  }
}

/** Builds a request-scoped factory for channel addresses on one authored channel. */
export function createChannelAddressFn<TState = undefined>(input: {
  readonly adapter: ChannelAdapter<any>;
  readonly channelName: string;
  readonly metadata?: ChannelDeliverySource;
  readonly runtime: Runtime;
  readonly turnPolicy?: TurnPolicy;
  readonly requestInput?: boolean;
  readonly occurrenceToken?: string;
}): ChannelAddressFn<TState> {
  return (continuationToken) => createChannelAddress({ ...input, continuationToken });
}
