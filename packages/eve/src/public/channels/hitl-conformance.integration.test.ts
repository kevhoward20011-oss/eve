import { describe, expect, it } from "vitest";

import { type HitlRule, hitlContract } from "#internal/testing/channel-conformance/contract.js";
import {
  type ChannelDriver,
  withChannelConversation,
} from "#internal/testing/channel-conformance/harness.js";
import {
  chatSdkDriver,
  chatSdkTextDriver,
} from "#internal/testing/channel-conformance/chat-sdk-driver.js";
import { discordDriver } from "#internal/testing/channel-conformance/discord-driver.js";
import { githubDriver } from "#internal/testing/channel-conformance/github-driver.js";
import { linearDriver } from "#internal/testing/channel-conformance/linear-driver.js";
import { linqDriver } from "#internal/testing/channel-conformance/linq-driver.js";
import { slackDriver } from "#internal/testing/channel-conformance/slack-driver.js";
import { teamsDriver } from "#internal/testing/channel-conformance/teams-driver.js";
import { telegramDriver } from "#internal/testing/channel-conformance/telegram-driver.js";
import { twilioDriver } from "#internal/testing/channel-conformance/twilio-driver.js";

interface BrokenCell {
  readonly reason: string;
  /** Matches the error this rule fails with today. */
  readonly symptom: RegExp;
}

/**
 * Runs the HITL contract against every registered channel driver. Each cell is one of:
 *
 * - must pass;
 * - not supported: the platform lacks a capability the rule requires (skipped);
 * - broken: the channel should pass but doesn't yet. The cell passes only when
 *   the rule fails with the recorded `symptom`, so a fix or an unrelated
 *   failure (such as harness breakage) both turn it red.
 */
const channels: readonly {
  readonly driver: () => ChannelDriver;
  readonly broken?: Partial<Record<HitlRule, BrokenCell>>;
}[] = [
  { driver: chatSdkDriver },
  {
    driver: chatSdkTextDriver,
    broken: {
      "a rendered question shows every option a person can choose": {
        reason: "#3712: the card's fallback text is only the prompt",
        symptom: /the question showed \[\]/,
      },
    },
  },
  { driver: discordDriver },
  { driver: githubDriver },
  { driver: linearDriver },
  { driver: linqDriver },
  { driver: slackDriver },
  { driver: teamsDriver },
  { driver: telegramDriver },
  {
    driver: twilioDriver,
    broken: {
      "a rendered question shows every option a person can choose": {
        reason: "the channel never sends the question (no input.requested handler)",
        symptom: /Timed out waiting for the question "Which day works for the review\?" on twilio/,
      },
      "a text reply matching an option answers the only pending question": {
        reason: "the channel never sends the question (no input.requested handler)",
        symptom: /Timed out waiting for the question "Which day works for the review\?" on twilio/,
      },
    },
  },
];

describe.each(channels.map((entry) => ({ ...entry, name: entry.driver().name })))(
  "$name HITL contract",
  ({ driver, broken }) => {
    for (const rule of hitlContract) {
      const { capabilities } = driver();
      const supported = rule.requires.every((capability) => capabilities.includes(capability));
      const known = broken?.[rule.rule];
      const run = () => withChannelConversation(driver(), (c) => rule.run(c));
      if (!supported) {
        it.skip(`${rule.rule} (not supported)`, run);
      } else if (known === undefined) {
        it(rule.rule, run, 60_000);
      } else {
        it(
          `${rule.rule} (broken: ${known.reason})`,
          () => expect(run()).rejects.toThrow(known.symptom),
          60_000,
        );
      }
    }
  },
);
