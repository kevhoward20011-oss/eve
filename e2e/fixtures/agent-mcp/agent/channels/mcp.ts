import { mcpChannel } from "eve/channels/mcp";

import {
  FORWARDER_ID,
  FORWARDER_TOKEN,
  REQUEST_STATE_SECRET,
  USER_HEADER,
  fixturePrincipal,
} from "../../fixture";

// The loopback connection authenticates as the forwarder and names its user
// in `eve-forwarded-principal`; evals that speak MCP directly name a user.
export default mcpChannel({
  auth: (request) => {
    if (request.headers.get("authorization") === `Bearer ${FORWARDER_TOKEN}`) {
      return fixturePrincipal(FORWARDER_ID, "service");
    }
    const user = request.headers.get(USER_HEADER);
    return user === null ? null : fixturePrincipal(user, "user");
  },
  requestStateSecret: REQUEST_STATE_SECRET,
  skills: true,
  tools: true,
  trustedForwarders: (forwarder) =>
    forwarder.authenticator === "e2e-fixture" && forwarder.principalId === FORWARDER_ID,
});
