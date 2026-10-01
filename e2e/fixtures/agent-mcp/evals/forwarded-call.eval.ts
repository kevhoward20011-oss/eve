import { isDeepStrictEqual } from "node:util";

import { defineEval } from "eve/evals";

import { FORWARDER_ID, USER_HEADER } from "../fixture";
import { requireMockModel } from "./mcp-client";

export default defineEval({
  description:
    "A tool called through the loopback connection returns its exact structured output and runs as the forwarded user, not the forwarding service.",

  async test(t) {
    requireMockModel(t);
    const turn = await t.send(
      "Alice starts her shift and checks which account the kennel tools see her as. MCP_WHOAMI",
      { headers: { [USER_HEADER]: "alice" } },
    );
    turn.expectOk();

    turn.calledTool("loopback__whoami", {
      count: 1,
      output: (value) =>
        isDeepStrictEqual(value, {
          forwardedBy: FORWARDER_ID,
          principalId: "alice",
          principalType: "user",
        }),
    });
  },
});
