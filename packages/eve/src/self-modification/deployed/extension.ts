import { defineExtension } from "eve/extension";

import { deployedSelfModificationConfigSchema } from "./config-schema.js";

/** Deployed self-modification extension. Its coding child is composed separately from local selfmod. */
export default defineExtension({ config: deployedSelfModificationConfigSchema });
