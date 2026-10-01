import type { Nitro } from "nitro/types";
import { describe, expect, it } from "vitest";

import { createScheduleRegistrations } from "#runtime/schedules/register.js";
import {
  registerScheduleTaskHandlers,
  registerToolSessionSandboxSweepTask,
  shouldScheduleToolSessionSandboxSweep,
  TOOL_SESSION_SANDBOX_SWEEP_CRON,
  TOOL_SESSION_SANDBOX_SWEEP_TASK_NAME,
} from "#internal/nitro/host/schedule-task-routes.js";

const DISPATCH_MODULE_PATH = "/framework/schedule-task.ts";

const ARTIFACTS_CONFIG = {
  kind: "production",
  sandboxScope: "test-sandbox-scope",
} as const;

describe("schedule task routes", () => {
  it("registers virtual task handlers and cron entries for compiled schedules", () => {
    const nitro = createNitroStub();

    registerScheduleTaskHandlers(nitro, {
      artifactsConfig: ARTIFACTS_CONFIG,
      dispatchModulePath: DISPATCH_MODULE_PATH,
      registrations: createScheduleRegistrations([
        {
          cron: "0 8 * * *",
          hasRun: false,
          name: "daily-digest",
          logicalPath: "schedules/daily-digest.mjs",
          markdown: "Send a digest.",
          sourceId: "schedules/daily-digest.mjs",
          sourceKind: "module",
        },
        {
          cron: "0 8 * * *",
          hasRun: false,
          name: "weekly-cleanup",
          logicalPath: "schedules/weekly-cleanup.mjs",
          markdown: "Run maintenance.",
          sourceId: "schedules/weekly-cleanup.mjs",
          sourceKind: "module",
        },
      ]),
    });

    expect(nitro.options.experimental.tasks).toBe(true);
    expect(nitro.options.tasks).toEqual({
      "eve.schedule.c2NoZWR1bGVzL2RhaWx5LWRpZ2VzdC5tanM": {
        description: 'Run eve schedule "daily-digest" from "schedules/daily-digest.mjs".',
        handler: "#eve-schedule-task/eve.schedule.c2NoZWR1bGVzL2RhaWx5LWRpZ2VzdC5tanM",
      },
      "eve.schedule.c2NoZWR1bGVzL3dlZWtseS1jbGVhbnVwLm1qcw": {
        description: 'Run eve schedule "weekly-cleanup" from "schedules/weekly-cleanup.mjs".',
        handler: "#eve-schedule-task/eve.schedule.c2NoZWR1bGVzL3dlZWtseS1jbGVhbnVwLm1qcw",
      },
    });
    expect(nitro.options.scheduledTasks).toEqual({
      "0 8 * * *": [
        "eve.schedule.c2NoZWR1bGVzL2RhaWx5LWRpZ2VzdC5tanM",
        "eve.schedule.c2NoZWR1bGVzL3dlZWtseS1jbGVhbnVwLm1qcw",
      ],
    });

    const virtualSource =
      nitro.options.virtual["#eve-schedule-task/eve.schedule.c2NoZWR1bGVzL2RhaWx5LWRpZ2VzdC5tanM"];
    expect(virtualSource).toBeDefined();
    // The virtual module exports a plain task object so Nitro can call
    // `handler.run(event)` at cron-trigger time. We avoid `defineTask`
    // because it imports from `"nitro/task"`, which is unavailable in
    // production deployments where `nitro` is a build-only dependency.
    expect(virtualSource).not.toContain("nitro/task");
    expect(virtualSource).not.toContain("defineTask");
    expect(virtualSource).toContain(
      `import { dispatchScheduleTask } from ${JSON.stringify(DISPATCH_MODULE_PATH)};`,
    );
    expect(virtualSource).toContain(`const config = ${JSON.stringify(ARTIFACTS_CONFIG)};`);
    expect(virtualSource).toContain("export default {");
    expect(virtualSource).toContain("async run(event)");
    expect(virtualSource).toContain("dispatchScheduleTask(event.name, config)");
  });

  it("does nothing when there are no registrations", () => {
    const nitro = createNitroStub();

    registerScheduleTaskHandlers(nitro, {
      artifactsConfig: ARTIFACTS_CONFIG,
      dispatchModulePath: DISPATCH_MODULE_PATH,
      registrations: [],
    });

    expect(nitro.options.experimental.tasks).toBeFalsy();
    expect(nitro.options.tasks).toEqual({});
    expect(nitro.options.scheduledTasks).toEqual({});
    expect(nitro.options.virtual).toEqual({});
  });
});

describe("tool-session sandbox sweep task", () => {
  it("schedules the sweep weekly as a framework task", () => {
    const nitro = createNitroStub();

    registerToolSessionSandboxSweepTask(nitro, {
      artifactsConfig: ARTIFACTS_CONFIG,
      sweepModulePath: "/framework/tool-session-sandbox-sweep-task.ts",
    });

    expect(TOOL_SESSION_SANDBOX_SWEEP_CRON).toMatch(/^\d+ \d+ \* \* 0$/);
    expect(nitro.options.experimental.tasks).toBe(true);
    expect(nitro.options.scheduledTasks).toEqual({
      [TOOL_SESSION_SANDBOX_SWEEP_CRON]: TOOL_SESSION_SANDBOX_SWEEP_TASK_NAME,
    });
    const source =
      nitro.options.virtual[`#eve-schedule-task/${TOOL_SESSION_SANDBOX_SWEEP_TASK_NAME}`];
    expect(source).toContain(
      'import { runToolSessionSandboxSweepTask } from "/framework/tool-session-sandbox-sweep-task.ts";',
    );
    expect(source).toContain("runToolSessionSandboxSweepTask(config)");
    expect(source).not.toContain("nitro/task");
  });

  it("schedules it only for providers that keep tool-session sandboxes", () => {
    expect(
      shouldScheduleToolSessionSandboxSweep({ preset: "vercel", providerName: "vercel" }),
    ).toBe(true);
    expect(
      shouldScheduleToolSessionSandboxSweep({ preset: undefined, providerName: "just-bash" }),
    ).toBe(true);
    expect(
      shouldScheduleToolSessionSandboxSweep({ preset: "vercel", providerName: "just-bash" }),
    ).toBe(false);
    expect(
      shouldScheduleToolSessionSandboxSweep({ preset: undefined, providerName: "docker" }),
    ).toBe(false);
  });
});

function createNitroStub(): Nitro {
  return {
    options: {
      experimental: {
        tasks: false,
      },
      scheduledTasks: {},
      tasks: {},
      virtual: {},
    },
  } as unknown as Nitro;
}
