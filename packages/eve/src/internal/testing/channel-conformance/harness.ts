import { createChannelOperations } from "#channel/channel-operations.js";
import { type CompiledChannel, isCompiledChannel } from "#channel/compiled-channel.js";
import { type RouteHandlerArgs, isHttpRouteDefinition } from "#channel/routes.js";
import { createWorkflowRuntime } from "#execution/workflow-runtime.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { getCompiledRuntimeAgentBundle } from "#runtime/sessions/compiled-agent-cache.js";
import type { Session } from "#channel/session.js";
import { askQuestion } from "#tools/provided/ask-question.js";

/** One outbound call a channel made to its platform API. */
export interface PlatformCall {
  readonly body: unknown;
  readonly method: string;
  /** The JSON the fake platform answered with. */
  readonly response: unknown;
}

/** A choice the platform rendered for a person, with whatever the driver needs to press it. */
export interface RenderedOption {
  readonly label: string;
  readonly handle: unknown;
}

/**
 * What a platform can do for a person, independent of eve. A rule that needs a
 * capability a driver lacks is skipped for that channel as "not supported".
 */
export type ChannelCapability =
  /** A person can press a rendered choice. */
  | "buttons"
  /** A person can send a plain-text message to the conversation. */
  | "text-replies";

/**
 * Teaches the HITL conformance suite to speak one channel's platform protocol.
 *
 * Drivers translate only between platform wire formats and conversation
 * actions. They never read session state, so they keep working across changes
 * to how eve stores and routes requests.
 */
export interface ChannelDriver {
  readonly name: string;
  readonly capabilities: readonly ChannelCapability[];
  /**
   * Builds the channel against a fake platform that reports each outbound call
   * to `record`. HTTP platforms use {@link recordingFetch}.
   */
  createChannel(record: (call: PlatformCall) => void): unknown;
  /** A webhook request carrying a person's message. */
  message(text: string): Request;
  /** Options rendered in one outbound call for a question, or `undefined` when it isn't one. */
  findOptions(call: PlatformCall, prompt: string): readonly RenderedOption[] | undefined;
  /** A webhook request pressing a rendered option. */
  press(option: RenderedOption): Request;
  /** Text the bot posted in one outbound call, if any. */
  postedText(call: PlatformCall): string | undefined;
}

/** What a person can do and see in one channel conversation. Contract rules use only this. */
export interface ChannelConversation {
  /** The person sends a plain-text message. */
  say(text: string): Promise<void>;
  /** Waits for the bot to post `prompt` with choices, returning them. */
  waitForQuestion(prompt: string): Promise<readonly RenderedOption[]>;
  /** The person presses one rendered choice. */
  press(option: RenderedOption): Promise<void>;
  /** Waits until `tool` returns, as visible in the bot's reply, and returns its output. */
  waitForToolResult(tool: string): Promise<unknown>;
}

const WAIT_TIMEOUT_MS = 15_000;

/** A `fetch` for an HTTP platform API: `decode` turns each request into a call and its answer. */
export function recordingFetch(
  record: (call: PlatformCall) => void,
  decode: (request: Request) => Promise<PlatformCall>,
): typeof globalThis.fetch {
  return async (input, init) => {
    const call = await decode(new Request(input, init));
    record(call);
    return Response.json(call.response);
  };
}

/**
 * Runs `body` against an agent with `ask_question` and `driver`'s channel. Every
 * interaction goes through the channel's real webhook routes; the only fake is
 * the platform API behind the channel's injected `fetch`.
 */
export async function withChannelConversation(
  driver: ChannelDriver,
  body: (conversation: ChannelConversation) => Promise<void>,
): Promise<void> {
  const calls: PlatformCall[] = [];
  const created = driver.createChannel((call) => void calls.push(call));
  if (!isCompiledChannel(created)) throw new Error(`${driver.name} is not a compiled channel.`);
  const channel: CompiledChannel = created;

  const runtime = await createTestRuntime({
    agent: { name: `${driver.name}-hitl-conformance` },
    modules: [
      {
        logicalPath: "tools/ask_question.ts",
        loadNamespace: async () => ({ default: askQuestion() }),
      },
      {
        logicalPath: `channels/${driver.name}.ts`,
        loadNamespace: async () => ({ default: channel }),
      },
    ],
  });

  await runtime.run(async () => {
    const compiledArtifactsSource = createBundledRuntimeCompiledArtifactsSource();
    const bundle = await getCompiledRuntimeAgentBundle({ compiledArtifactsSource });
    const entry = bundle.graph.root.channels.find((candidate) => candidate.name === driver.name);
    if (entry?.adapter === undefined) throw new Error(`Expected the ${driver.name} adapter.`);
    // Mirrors the operations production route dispatch builds for each request.
    const operations = createChannelOperations({
      adapter: entry.adapter,
      channelName: driver.name,
      runtime: createWorkflowRuntime({ compiledArtifactsSource }),
      turnPolicy: entry.turnPolicy,
    });
    const sessions = new Map<string, Session>();

    async function post(request: Request): Promise<void> {
      const pending: Promise<unknown>[] = [];
      const args: RouteHandlerArgs = {
        ...operations,
        from: (address) => {
          const source = operations.from(address);
          return {
            ...source,
            send: async (...sendArgs) => track(await source.send(...sendArgs)),
            respond: async (...respondArgs) => track(await source.respond(...respondArgs)),
          };
        },
        attachSession: unsupported("attachSession"),
        params: {},
        requestIp: null,
        to: unsupported("to"),
        waitUntil: (task) => void pending.push(task),
      };
      const response = await findRoute(channel, request).handler(request, args);
      await Promise.all(pending);
      if (!response.ok) throw new Error(`${driver.name} webhook answered ${response.status}.`);
    }

    async function waitFor<T>(label: string, select: (call: PlatformCall) => T | undefined) {
      const deadline = Date.now() + WAIT_TIMEOUT_MS;
      while (Date.now() < deadline) {
        for (const call of calls) {
          const selected = select(call);
          if (selected !== undefined) return selected;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error(
        `Timed out waiting for ${label} on ${driver.name}. Platform calls:\n${JSON.stringify(calls, null, 2)}`,
      );
    }

    const conversation: ChannelConversation = {
      say: (text) => post(driver.message(text)),
      press: (option) => post(driver.press(option)),
      waitForQuestion: (prompt) =>
        waitFor(`the question "${prompt}"`, (call) => driver.findOptions(call, prompt)),
      waitForToolResult: (tool) =>
        waitFor(`${tool} to return`, (call) => {
          const text = driver.postedText(call);
          return text === undefined ? undefined : readMockToolReply(text, tool);
        }),
    };

    function track(session: Session): Session {
      sessions.set(session.id, session);
      return session;
    }

    try {
      await body(conversation);
    } finally {
      await Promise.allSettled([...sessions.values()].map((session) => session.cancel()));
    }
  });
}

function findRoute(channel: CompiledChannel, request: Request) {
  const { pathname } = new URL(request.url);
  const route = channel.routes.find(
    (candidate) =>
      isHttpRouteDefinition(candidate) &&
      candidate.method === request.method &&
      candidate.path === pathname,
  );
  if (route === undefined || !isHttpRouteDefinition(route)) {
    throw new Error(`No ${request.method} route for ${pathname}.`);
  }
  return route;
}

function unsupported(name: string): () => never {
  return () => {
    throw new Error(`The HITL conformance harness does not provide ctx.${name}.`);
  };
}

/**
 * After a tool returns, the deterministic test model replies
 * `Used <tool> for "<message>": <JSON output>`. Reading the output back from
 * the posted reply keeps rules on what a person sees.
 */
function readMockToolReply(text: string, tool: string): unknown {
  if (!text.startsWith(`Used ${tool} for "`)) return undefined;
  const output = /": (\{.*\})\s*$/su.exec(text)?.[1];
  if (output === undefined) return undefined;
  try {
    return JSON.parse(output) as unknown;
  } catch {
    return undefined;
  }
}
