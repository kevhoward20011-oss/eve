import { defineEval } from "eve/evals";
import { equals, satisfies } from "eve/evals/expect";

import { USER_HEADER } from "../fixture";
import { mcpRequest, requireMockModel } from "./mcp-client";

const NOTICE = "Biscuit goes home on Friday at noon.";
const REFUSED = "Only the person this request was made for can answer it.";
/** eve's minted MCP `requestState`: `v1.<payload>.<mac>`, both base64url. */
const REQUEST_STATE = /v1\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/u;

const as = (user: string) => ({ headers: { [USER_HEADER]: user } });

/**
 * The channel's approval reaches the calling session's user as an ordinary
 * `input.requested`, and only that user can answer it.
 *
 * The approval holds the calling turn (`turn.waiting` on `input`); a refused
 * answer leaves it held, and the requester's answer resumes the same turn.
 */
export default defineEval({
  description:
    "An MCP approval asks the calling session's user; another person's answer is refused, and the tool runs once after the user approves.",
  timeoutMs: 180_000,

  async test(t) {
    requireMockModel(t);

    // Positive control for the leak check below: the channel's real
    // requestState matches REQUEST_STATE.
    const direct = await mcpRequest(t.target, "alice", "tools/call", {
      arguments: { notice: NOTICE },
      name: "publish_notice",
    });
    await t.require(
      direct.result?.requestState,
      satisfies(
        (state: unknown) => typeof state === "string" && REQUEST_STATE.test(state),
        "the channel mints a requestState the leak pattern recognizes",
      ),
    );

    const parked = await t.send(
      `Alice asks the desk agent to post a pickup notice for Biscuit. MCP_PUBLISH "${NOTICE}"`,
      as("alice"),
    );
    parked.event("input.requested", { count: 1 });
    parked.calledTool("loopback__publish_notice", { count: 0 });
    const session = parked.session;
    const request = session.requireInputRequest({ toolName: "connection_execute" });
    const answer = [{ optionId: "approve", requestId: request.requestId }];

    // Bob is on the same thread and tries to approve Alice's notice. He is
    // refused, and the turn stays held for Alice.
    const bob = await session.respond(answer, as("bob"));
    bob.event("message.completed", { data: { message: REFUSED } });
    bob.event("turn.waiting", { data: { on: "input" } });
    await t.require(bob.events.filter((event) => event.type === "action.result").length, equals(0));

    // The request stayed pending: Alice's answer to the same request id runs
    // it, once (it ran neither when parked nor on Bob's answer), as Alice.
    const approved = await session.respond(answer, as("alice"));
    approved.expectOk();
    approved.calledTool("loopback__publish_notice", {
      count: 1,
      output: { by: "alice", published: NOTICE },
    });

    await t.require(
      JSON.stringify([...parked.events, ...bob.events, ...approved.events]),
      satisfies(
        (text: string) => !REQUEST_STATE.test(text),
        "no event carries the MCP requestState",
      ),
    );
  },
});
