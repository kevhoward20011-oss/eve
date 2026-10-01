import type { DynamicResolveContext } from "#dynamic/definition.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const authorize = vi.hoisted(() => vi.fn());

vi.mock("../../extension.js", () => ({
  default: {
    config: {
      authorize,
      repository: "acme/agents",
      directory: ".",
      baseBranch: "main",
      github: { connector: "github/agent-author" },
    },
  },
}));

import agent from "./agent.js";

const context: DynamicResolveContext = {
  channel: {},
  messages: [],
  model: { id: "openai/gpt-5.4" },
  session: { auth: { current: null, initiator: null }, id: "parent" },
};

describe("deployed self-modification delegation", () => {
  beforeEach(() => authorize.mockReset());

  it.each(["session.started", "turn.started"] as const)(
    "denies delegation when the policy rejects or throws on %s",
    async (event) => {
      const principal = {
        authenticator: "test",
        principalId: "alice",
        principalType: "user" as const,
        attributes: {},
      };
      const request = {
        ...context,
        channel: { kind: "slack", metadata: { workspace: "acme" } },
        session: { ...context.session, auth: { current: principal, initiator: null } },
      };
      authorize.mockResolvedValueOnce(false).mockRejectedValueOnce(new Error("policy unavailable"));
      await expect(agent.events[event]?.({}, request)).resolves.toBeNull();
      await expect(agent.events[event]?.({}, request)).resolves.toBeNull();
      expect(authorize).toHaveBeenCalledWith({ channel: request.channel, principal });
    },
  );

  it("does not delegate to anonymous callers unless the policy allows them", async () => {
    authorize.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    await expect(agent.events["session.started"]?.({}, context)).resolves.toBeNull();
    await expect(agent.events["turn.started"]?.({}, context)).resolves.toMatchObject({
      model: context.model!.id,
    });
    expect(authorize).toHaveBeenCalledWith({ channel: context.channel, principal: null });
  });

  it.each(["session.started", "turn.started"] as const)(
    "explains source delegation and proposal boundaries on %s",
    async (event) => {
      authorize.mockResolvedValueOnce(true);
      const resolved = await agent.events[event]?.({}, context);
      expect(resolved).toMatchObject({
        model: context.model!.id,
        description: expect.any(String),
      });
      const description = (resolved as { description: string }).description;
      expect(description).toContain("change this eve agent");
      expect(description).toContain("persistent changes to future behavior");
      expect(description).toContain("replacing a hardcoded weather tool with a live API");
      expect(description).toContain("Your sandbox need not contain the source");
      expect(description).toContain("exact tool or skill identifiers");
      expect(description).toContain("Questions, investigations, and design requests are read-only");
      expect(description).toContain("only an explicit implementation request");
      expect(description).toContain("same child with agentId");
      expect(description).toContain("does not change the running agent, even on the next turn");
      expect(description).not.toContain("/source");
    },
  );
});
