import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";

import { selfModificationConfigSchema } from "./config-schema.js";

describe("local self-modification extension config", () => {
  it("accepts the same static model and reasoning values as agent configuration", () => {
    const languageModel = new MockLanguageModelV3();

    expect(
      selfModificationConfigSchema.parse({ model: "provider/model", reasoning: "high" }),
    ).toMatchObject({ model: "provider/model", reasoning: "high" });
    expect(selfModificationConfigSchema.parse({ model: languageModel }).model).toBe(languageModel);
  });

  it.each([
    { model: 42 },
    { model: { provider: "test", modelId: "model" } },
    { reasoning: "maximum" },
    { reasoning: {} },
    { deployed: {} },
  ])("rejects invalid local configuration: %j", (config) => {
    expect(() => selfModificationConfigSchema.parse(config)).toThrow();
  });
});
