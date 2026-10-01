import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { buildApplication } from "../../src/internal/nitro/host/build-application.js";
import { startProductionServer } from "../../src/internal/nitro/host/start-production-server.js";
import { useScenarioApp } from "../../src/internal/testing/scenario-app.js";

/**
 * The interop test from the tools-and-skills plan ("Calling it from any MCP
 * client"): the official MCP Inspector CLI, pinned as a devDependency, lists
 * and calls a built agent's tools and reads its skills over `mcpChannel`.
 * The `mcp` helper below is the plan's shell function, plus the two flags a
 * real run needs: `--header` for the channel's auth (a production server, so
 * no `localDev()`), and `--protocol-era`, because ad-hoc Inspector runs
 * negotiate `2025-11-25` unless told otherwise.
 */

const INSPECTOR_BIN = fileURLToPath(
  new URL(
    "../../node_modules/@modelcontextprotocol/inspector/clients/launcher/build/index.js",
    import.meta.url,
  ),
);
const SCENARIO_TIMEOUT_MS = 360_000;
const INSPECTOR_TIMEOUT_MS = 60_000;
const TOKEN = "inspector-scenario-token";

const SKILL_MD = [
  "---",
  "name: usage-triage",
  "description: Triage an account's usage spike with query_usage.",
  "license: Apache-2.0",
  "metadata:",
  '  owner: "billing"',
  "---",
  "",
  "# Usage triage",
  "",
  "Call `query_usage`, then follow [the runbook](references/runbook.md).",
  "",
].join("\n");

const scenarioApp = useScenarioApp();

describe("MCP Inspector CLI against mcpChannel", () => {
  it(
    "lists and calls tools and reads skills, in both protocol eras",
    async () => {
      const { appRoot } = await scenarioApp({
        name: "mcp-inspector-cli",
        installDependencies: true,
        files: {
          "agent/agent.ts": 'export default { model: "openai/gpt-5.4" };',
          "agent/instructions.md": "You triage usage.",
          "agent/channels/mcp.ts": [
            'import { mcpChannel } from "eve/channels/mcp";',
            "",
            "export default mcpChannel({",
            "  auth: (request) =>",
            `    request.headers.get("authorization") === "Bearer ${TOKEN}"`,
            '      ? { attributes: {}, authenticator: "scenario", principalId: "inspector", principalType: "user" }',
            "      : null,",
            "});",
            "",
          ].join("\n"),
          "agent/tools/query_usage.ts": [
            'import { defineTool } from "eve/tools";',
            "",
            "export default defineTool({",
            '  description: "Usage for one account over a window.",',
            "  inputSchema: {",
            '    type: "object",',
            "    properties: {",
            '      account: { type: "string" },',
            '      window: { type: "string", enum: ["7d", "30d"] },',
            "    },",
            '    required: ["account", "window"],',
            "    additionalProperties: false,",
            "  },",
            "  async execute({ account, window }) {",
            "    return { account, window, requests: 1234 };",
            "  },",
            "});",
            "",
          ].join("\n"),
          "agent/skills/usage-triage/SKILL.md": SKILL_MD,
          "agent/skills/usage-triage/references/runbook.md": "# Runbook\n\nCheck the top caller.\n",
        },
      });

      await buildApplication(appRoot, { skipSandboxPrewarm: true });
      const server = await startProductionServer(appRoot, { host: "127.0.0.1", port: 0 });
      // The Inspector keeps a catalog, client config, and OAuth state under
      // the home directory; give it a throwaway one.
      const home = await mkdtemp(join(tmpdir(), "eve-inspector-home-"));
      const url = new URL("/eve/v1/mcp", server.url).href;
      const mcp = (era: "legacy" | "modern", ...args: string[]) =>
        runInspector(home, [
          "--cli",
          "--transport",
          "http",
          "--server-url",
          url,
          "--header",
          `Authorization: Bearer ${TOKEN}`,
          "--protocol-era",
          era,
          "--format",
          "json",
          ...args,
        ]);

      try {
        for (const era of ["modern", "legacy"] as const) {
          // mcp --method tools/list
          const tools = await mcp(era, "--method", "tools/list");
          expect(tools.code, tools.stderr).toBe(0);
          const listed = result(tools.stdout).tools as { name: string; inputSchema: unknown }[];
          expect(listed.find((tool) => tool.name === "query_usage")).toMatchObject({
            inputSchema: { required: ["account", "window"], type: "object" },
          });

          // mcp --method tools/call --tool-name query_usage --tool-args-json '{...}'
          const call = await mcp(
            era,
            "--method",
            "tools/call",
            "--tool-name",
            "query_usage",
            "--tool-args-json",
            '{"account":"acme","window":"30d"}',
          );
          expect(call.code, call.stderr).toBe(0);
          expect(result(call.stdout)).toMatchObject({
            structuredContent: { account: "acme", requests: 1234, window: "30d" },
          });

          // mcp --method skills/list
          const skills = await mcp(era, "--method", "skills/list");
          expect(skills.code, skills.stderr).toBe(0);
          expect(result(skills.stdout).skills).toEqual([
            {
              uri: "skill://usage-triage/SKILL.md",
              frontmatter: {
                name: "usage-triage",
                description: "Triage an account's usage spike with query_usage.",
                license: "Apache-2.0",
                metadata: { owner: "billing" },
              },
              resources: [
                expect.objectContaining({
                  uri: "skill://usage-triage/SKILL.md",
                  digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
                  size: Buffer.byteLength(SKILL_MD),
                }),
                expect.objectContaining({ uri: "skill://usage-triage/references/runbook.md" }),
              ],
            },
          ]);

          // The Inspector's own SEP-2640 conformance and digest checks.
          const verified = await mcp(era, "--method", "skills/list", "--verify");
          expect(verified.code, `${verified.stdout}\n${verified.stderr}`).toBe(0);
          expect(verified.stdout).toContain('"outcome":"verified"');

          // mcp --method resources/read --uri skill://usage-triage/SKILL.md
          const read = await mcp(
            era,
            "--method",
            "resources/read",
            "--uri",
            "skill://usage-triage/SKILL.md",
          );
          expect(read.code, read.stderr).toBe(0);
          expect(result(read.stdout).contents).toEqual([
            { uri: "skill://usage-triage/SKILL.md", mimeType: "text/markdown", text: SKILL_MD },
          ]);

          const directory = await mcp(
            era,
            "--method",
            "resources/directory/read",
            "--uri",
            "skill://usage-triage",
          );
          expect(directory.code, directory.stderr).toBe(0);
          expect(result(directory.stdout).resources).toEqual([
            expect.objectContaining({ uri: "skill://usage-triage/SKILL.md" }),
            expect.objectContaining({
              uri: "skill://usage-triage/references",
              mimeType: "inode/directory",
            }),
          ]);

          const traversal = await mcp(
            era,
            "--method",
            "resources/read",
            "--uri",
            "skill://usage-triage/references/../SKILL.md",
          );
          expect(traversal.code).not.toBe(0);
        }

        const unauthenticated = await runInspector(home, [
          "--cli",
          "--transport",
          "http",
          "--server-url",
          url,
          "--protocol-era",
          "modern",
          "--stored-auth-only",
          "--format",
          "json",
          "--method",
          "skills/list",
        ]);
        // HTTP 401 → the Inspector's `auth_required` exit code.
        expect(unauthenticated.code).toBe(3);
      } finally {
        await server.close();
        await rm(home, { force: true, recursive: true });
      }
    },
    SCENARIO_TIMEOUT_MS,
  );
});

interface InspectorRun {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function runInspector(home: string, args: readonly string[]): Promise<InspectorRun> {
  return await new Promise((resolve) => {
    execFile(
      process.execPath,
      [INSPECTOR_BIN, ...args],
      {
        env: {
          ...process.env,
          HOME: home,
          MCP_CATALOG_PATH: join(home, "mcp.json"),
          MCP_CLIENT_CONFIG_PATH: join(home, "client.json"),
          USERPROFILE: home,
        },
        timeout: INSPECTOR_TIMEOUT_MS,
      },
      (error, stdout, stderr) => {
        const code = error === null ? 0 : typeof error.code === "number" ? error.code : 1;
        resolve({ code, stderr, stdout });
      },
    );
  });
}

/** The `result` of the one JSON object `--format json` prints. */
function result(stdout: string): Record<string, unknown> {
  const parsed = JSON.parse(stdout.trim()) as { readonly result?: unknown };
  if (typeof parsed.result !== "object" || parsed.result === null) {
    throw new Error(`Inspector printed no result: ${stdout}`);
  }
  return parsed.result as Record<string, unknown>;
}
