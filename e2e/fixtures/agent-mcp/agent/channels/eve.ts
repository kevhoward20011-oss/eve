import { eveChannel } from "eve/channels/eve";

import { USER_HEADER, fixturePrincipal } from "../../fixture";

/** Fixture-only authentication: evals name the speaker so they can act as Alice or Bob. */
export default eveChannel({
  auth: (request) => fixturePrincipal(request.headers.get(USER_HEADER) ?? "e2e-eval", "user"),
});
