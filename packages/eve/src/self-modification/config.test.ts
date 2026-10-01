import { afterEach, describe, expect, it } from "vitest";

import { isLocalSelfModificationEnabled, resolveSelfModificationConfig } from "./config.js";

afterEach(() => {
  delete process.env.EVE_DEV;
});

describe("local self-modification configuration", () => {
  it("defaults to local editing only during development", () => {
    const config = resolveSelfModificationConfig({});
    expect(isLocalSelfModificationEnabled(config)).toBe(false);
    process.env.EVE_DEV = "1";
    expect(isLocalSelfModificationEnabled(config)).toBe(true);
  });

  it("validates local configuration", () => {
    expect(() => resolveSelfModificationConfig({ local: { enabled: "yes" as never } })).toThrow(
      "local.enabled must be a boolean",
    );
  });
});
