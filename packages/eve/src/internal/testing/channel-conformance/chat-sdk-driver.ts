import { chatSdkChannel } from "#public/channels/chat-sdk/index.js";
import {
  type Adapter,
  type AdapterPostableMessage,
  type ChatInstance,
  Message,
  type StateAdapter,
  type WebhookOptions,
  parseMarkdown,
} from "#compiled/chat/index.js";
import { createMemoryState } from "#compiled/@chat-adapter/state-memory/index.js";
import type { ChannelDriver, PlatformCall } from "#internal/testing/channel-conformance/harness.js";

const ADAPTER = "conformance";
const PERSON = { fullName: "Alice", isBot: false, isMe: false, userId: "alice", userName: "alice" };
let nextThread = 0;

interface CardNode {
  readonly children?: readonly CardNode[];
  readonly content?: string;
  readonly id?: string;
  readonly label?: string;
  readonly type?: string;
  readonly value?: string;
}

type Inbound =
  | { readonly kind: "message"; readonly text: string }
  | { readonly kind: "action"; readonly actionId: string; readonly value?: string };

/**
 * Drives `chatSdkChannel` with a card-capable direct-message adapter: one
 * thread, no streaming, and every message handed to eve with an empty
 * `context`. The fake adapter is the platform: it reads inbound JSON and
 * records every post and edit. Text-only adapters such as Linq and Photon
 * flatten cards, so they need their own drivers.
 */
export function chatSdkDriver(): ChannelDriver {
  nextThread += 1;
  const threadId = `${ADAPTER}:D${nextThread}`;
  let sequence = 0;

  function inbound(body: Inbound): Request {
    return new Request(`https://agent.example.com/eve/v1/${ADAPTER}`, {
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
  }

  return {
    name: "chat-sdk",
    capabilities: ["buttons", "text-replies"],
    createChannel(record) {
      const bridge = chatSdkChannel({
        adapters: { [ADAPTER]: fakeAdapter(threadId, record, () => (sequence += 1)) },
        concurrency: "concurrent",
        routes: { [ADAPTER]: `/eve/v1/${ADAPTER}` },
        state: createMemoryState() as StateAdapter,
        streaming: false,
        userName: "eve",
      });
      bridge.bot.onDirectMessage(async (thread, message) => {
        await bridge.send(message.text, { auth: null, context: [], thread });
      });
      return bridge.channel;
    },
    message: (text) => inbound({ kind: "message", text }),
    findOptions(call, prompt) {
      if (call.method !== "postMessage" && call.method !== "editMessage") return undefined;
      const card = cardOf(call.body as AdapterPostableMessage);
      if (card === undefined || !texts(card).includes(prompt)) return undefined;
      const buttons = nodes(card).filter((node) => node.type === "button" && node.id !== undefined);
      return buttons.length === 0
        ? undefined
        : buttons.map((button) => ({ handle: button, label: button.label ?? "" }));
    },
    press(option) {
      const button = option.handle as CardNode;
      return inbound({ actionId: button.id!, kind: "action", value: button.value });
    },
    postedText(call: PlatformCall) {
      if (call.method !== "postMessage" && call.method !== "editMessage") return undefined;
      const posted = call.body as AdapterPostableMessage;
      if (typeof posted === "string") return posted;
      if ("markdown" in posted) return posted.markdown;
      if ("raw" in posted) return posted.raw;
      return undefined;
    },
  };
}

function fakeAdapter(
  threadId: string,
  record: (call: PlatformCall) => void,
  nextId: () => number,
): Adapter {
  let chat: ChatInstance | null = null;
  const self = {
    name: ADAPTER,
    userName: "eve",
    async initialize(instance: ChatInstance) {
      chat = instance;
    },
    async handleWebhook(request: Request, options?: WebhookOptions) {
      const body = (await request.json()) as Inbound;
      const id = `inbound-${nextId()}`;
      if (body.kind === "action") {
        await chat?.processAction(
          {
            actionId: body.actionId,
            adapter,
            messageId: id,
            raw: body,
            threadId,
            user: PERSON,
            value: body.value,
          },
          options,
        );
      } else {
        await chat?.processMessage(
          adapter,
          threadId,
          inboundMessage(threadId, id, body.text),
          options,
        );
      }
      return new Response("ok");
    },
    channelIdFromThreadId: () => threadId,
    decodeThreadId: (id: string) => ({ threadId: id }),
    encodeThreadId: (input: { threadId: string }) => input.threadId,
    getChannelVisibility: () => "private" as const,
    isDM: () => true,
    parseMessage: (raw: { text?: string }) => inboundMessage(threadId, "parsed", raw.text ?? ""),
    renderFormatted: () => "",
    fetchMessages: async () => ({ messages: [] }),
    fetchThread: async (id: string) => ({
      channelId: threadId,
      channelVisibility: "private" as const,
      id,
      isDM: true,
      metadata: {},
    }),
    async postMessage(id: string, posted: AdapterPostableMessage) {
      const messageId = `posted-${nextId()}`;
      record({ body: posted, method: "postMessage", response: { id: messageId } });
      return { id: messageId, raw: posted, threadId: id };
    },
    async editMessage(id: string, messageId: string, posted: AdapterPostableMessage) {
      record({ body: posted, method: "editMessage", response: { id: messageId } });
      return { id: messageId, raw: posted, threadId: id };
    },
    async addReaction() {},
    async deleteMessage() {},
    async removeReaction() {},
    async startTyping() {},
  };
  // Chat SDK adapters have many optional members; the fake implements the ones eve calls.
  const adapter: Adapter = self as typeof self & Adapter;
  return adapter;
}

function inboundMessage(threadId: string, id: string, text: string): Message {
  return new Message({
    attachments: [],
    author: PERSON,
    formatted: parseMarkdown(text),
    id,
    isMention: false,
    metadata: { dateSent: new Date("2026-01-01T00:00:00.000Z"), edited: false },
    raw: { text },
    text,
    threadId,
  });
}

function cardOf(posted: AdapterPostableMessage): CardNode | undefined {
  if (typeof posted !== "object" || posted === null) return undefined;
  if ("card" in posted) return posted.card as CardNode;
  return (posted as CardNode).type === "card" ? (posted as CardNode) : undefined;
}

function nodes(node: CardNode): CardNode[] {
  return [node, ...(node.children ?? []).flatMap(nodes)];
}

function texts(node: CardNode): string {
  return nodes(node)
    .flatMap((child) => (child.content === undefined ? [] : [child.content]))
    .join("\n");
}
