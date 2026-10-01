import { describe, it } from "vitest";

import { type HitlRule, hitlContract } from "#internal/testing/channel-conformance/contract.js";
import {
  type ChannelDriver,
  withChannelConversation,
} from "#internal/testing/channel-conformance/harness.js";
import { slackDriver } from "#internal/testing/channel-conformance/slack-driver.js";
import { telegramDriver } from "#internal/testing/channel-conformance/telegram-driver.js";

/**
 * Runs the HITL contract against every first-party channel. Each cell is one of:
 *
 * - must pass;
 * - not supported: the platform lacks a capability the rule requires (skipped);
 * - known gap: the channel should pass but doesn't yet. It runs as `it.fails`,
 *   so fixing the gap turns the cell red until its entry is deleted.
 */
const channels: readonly {
  readonly driver: () => ChannelDriver;
  readonly knownGaps?: Partial<Record<HitlRule, string>>;
}[] = [
  {
    driver: slackDriver,
    knownGaps: {
      "a text reply matching an option answers the only pending question":
        "the answer is the whole <slack_message> envelope",
    },
  },
  {
    driver: telegramDriver,
    knownGaps: {
      "pressing a rendered option answers the pending question with that option": "#4105",
      "a text reply matching an option answers the only pending question":
        "the reply starts a new turn instead",
    },
  },
];

describe.each(channels.map((entry) => ({ ...entry, name: entry.driver().name })))(
  "$name HITL contract",
  ({ driver, knownGaps }) => {
    for (const rule of hitlContract) {
      const { capabilities } = driver();
      const supported = rule.requires.every((capability) => capabilities.includes(capability));
      const gap = knownGaps?.[rule.rule];
      const test = !supported ? it.skip : gap === undefined ? it : it.fails;
      const name = !supported
        ? `${rule.rule} (not supported)`
        : gap === undefined
          ? rule.rule
          : `${rule.rule} (known gap: ${gap})`;
      test(name, () => withChannelConversation(driver(), (c) => rule.run(c)), 60_000);
    }
  },
);
