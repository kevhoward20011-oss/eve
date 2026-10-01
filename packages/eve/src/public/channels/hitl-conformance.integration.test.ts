import { describe, it } from "vitest";

import { type HitlRule, hitlContract } from "#internal/testing/channel-conformance/contract.js";
import {
  type ChannelDriver,
  withChannelConversation,
} from "#internal/testing/channel-conformance/harness.js";
import { chatSdkDriver } from "#internal/testing/channel-conformance/chat-sdk-driver.js";
import { slackDriver } from "#internal/testing/channel-conformance/slack-driver.js";
import { telegramDriver } from "#internal/testing/channel-conformance/telegram-driver.js";

/**
 * Runs the HITL contract against every first-party channel. Each cell is one of:
 *
 * - must pass;
 * - not supported: the platform lacks a capability the rule requires (skipped);
 * - broken: the channel should pass but doesn't yet. It runs as `it.fails`,
 *   so fixing it turns the cell red until its `broken` entry is deleted.
 */
const channels: readonly {
  readonly driver: () => ChannelDriver;
  readonly broken?: Partial<Record<HitlRule, string>>;
}[] = [
  { driver: chatSdkDriver },
  {
    driver: slackDriver,
    broken: {
      "a text reply matching an option answers the only pending question":
        "the answer is the whole <slack_message> envelope",
    },
  },
  {
    driver: telegramDriver,
    broken: {
      "a text reply matching an option answers the only pending question":
        "the leftover channel context interrupts the turn and withdraws the question",
    },
  },
];

describe.each(channels.map((entry) => ({ ...entry, name: entry.driver().name })))(
  "$name HITL contract",
  ({ driver, broken }) => {
    for (const rule of hitlContract) {
      const { capabilities } = driver();
      const supported = rule.requires.every((capability) => capabilities.includes(capability));
      const reason = broken?.[rule.rule];
      const test = !supported ? it.skip : reason === undefined ? it : it.fails;
      const name = !supported
        ? `${rule.rule} (not supported)`
        : reason === undefined
          ? rule.rule
          : `${rule.rule} (broken: ${reason})`;
      test(name, () => withChannelConversation(driver(), (c) => rule.run(c)), 60_000);
    }
  },
);
