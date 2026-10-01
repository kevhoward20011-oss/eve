import { z } from "#compiled/zod/index.js";
import { isAgentReasoningDefinition, isRuntimeLanguageModel } from "#internal/runtime-model.js";
import type { AgentReasoningDefinition, AgentStaticModelDefinition } from "#public/index.js";

import { deployedSelfModificationConfigSchema } from "../deployed/config-schema.js";

export const selfModificationConfigSchema = z
  .object({
    model: z
      .custom<AgentStaticModelDefinition>(
        (value) => typeof value === "string" || isRuntimeLanguageModel(value),
      )
      .optional(),
    reasoning: z.custom<AgentReasoningDefinition>(isAgentReasoningDefinition).optional(),
    local: z.object({ enabled: z.boolean().optional() }).optional(),
    deployed: deployedSelfModificationConfigSchema.optional(),
  })
  .strict();
