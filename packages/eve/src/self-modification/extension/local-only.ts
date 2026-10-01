import { defineDynamic } from "#dynamic/definition.js";

import {
  isLocalSelfModificationEnabled,
  resolveSelfModificationConfig,
  type ResolvedSelfModificationConfig,
} from "../config.js";
import selfModification from "./extension.js";

/** Returns a definition only when local self-modification is enabled. */
export function resolveLocalOnly<T>(
  config: ResolvedSelfModificationConfig,
  definition: T,
): T | null {
  return isLocalSelfModificationEnabled(config) ? definition : null;
}

/** Creates a dynamic definition that is present only during local development. */
export function defineLocalOnlyDynamic<T>(definition: T) {
  return defineDynamic({
    events: {
      "session.started": () =>
        resolveLocalOnly(resolveSelfModificationConfig(selfModification.config), definition),
    },
  });
}
