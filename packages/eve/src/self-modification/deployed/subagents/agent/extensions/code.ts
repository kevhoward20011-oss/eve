import code from "eve/extensions/code";

import { deployedGitHubConfig } from "../../../github.js";

export default code({
  github: deployedGitHubConfig(),
});
