import { describe, expect, it } from "vitest";

import { deployedSelfModificationConfigSchema } from "./config-schema.js";

function validate(value: unknown) {
  const result = deployedSelfModificationConfigSchema["~standard"].validate(value);
  if (result instanceof Promise) throw new Error("Expected synchronous validation.");
  return result;
}

describe("deployed self-modification configuration", () => {
  const deployed = {
    authorize: () => true,
    baseBranch: "release/production",
    directory: "apps/weather",
    github: { connector: "github/agent-author" },
    repository: "acme/agents",
  };

  it.each([deployed, { ...deployed, directory: "." }])("accepts %j", (config) => {
    expect(validate(config).issues).toBeUndefined();
  });

  it.each([
    ["repository", { ...deployed, repository: "github.com/acme/agents" }, "owner/repo"],
    ["repository owner", { ...deployed, repository: "-acme/agents" }, "owner/repo"],
    ["directory", { ...deployed, directory: "../agents" }, "safe repository-relative"],
    ["base branch", { ...deployed, baseBranch: "refs/heads/main" }, "not a full Git ref"],
    ["lock ref", { ...deployed, baseBranch: "main.lock" }, "valid branch name"],
    ["connector", { ...deployed, github: { connector: "" } }, "connector"],
    ["authorization", { ...deployed, authorize: true }, "authorize must be a function"],
    [
      "missing authorization",
      { ...deployed, authorize: undefined },
      "authorize must be a function",
    ],
    ["unknown key", { ...deployed, target: { branch: "main" } }, "target"],
  ])("rejects an invalid %s", (_name, config, message) => {
    const issues = validate(config).issues ?? [];
    expect(
      issues.map((issue) => `${issue.path?.join(".")}: ${issue.message}`).join("\n"),
    ).toContain(message);
  });
});
