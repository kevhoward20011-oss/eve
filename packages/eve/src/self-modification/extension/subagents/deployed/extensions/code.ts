import code from "eve/extensions/code";

import { deployedGitHubConfig } from "../../../../deployed/github.js";
import selfModification from "../../../extension.js";

const deployed = selfModification.config.deployed;

export default code(deployed === undefined ? {} : { github: deployedGitHubConfig(deployed) });
