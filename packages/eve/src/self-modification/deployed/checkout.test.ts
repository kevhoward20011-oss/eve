import { beforeEach, describe, expect, it, vi } from "vitest";

const { executeGitHubShell } = vi.hoisted(() => ({ executeGitHubShell: vi.fn() }));
vi.mock("#extensions/code/extension/lib/github-shell.js", () => ({ executeGitHubShell }));
vi.mock("./github.js", () => ({
  deployedGitHubConfig: () => ({
    broker: vi.fn(),
    connector: "github/agent-author",
    org: "acme",
  }),
}));
vi.mock("./extension.js", () => ({
  default: {
    config: {
      authorize: () => true,
      baseBranch: "main",
      directory: "apps/weather",
      github: { connector: "github/agent-author" },
      repository: "acme/agents",
    },
  },
}));

import type { SandboxSession } from "#shared/sandbox-session.js";

import {
  createDeployedSelfModificationEnvironment,
  initializeDeployedCheckout,
  prepareDeployedSelfModificationSandbox,
} from "./checkout.js";

describe("deployed checkout initialization", () => {
  const run = vi.fn();
  const sandbox = {
    resolvePath: (path: string) => `/workspace/${path}`,
    run,
    removePath: vi.fn(),
    readFile: vi.fn(),
    readBinaryFile: vi.fn(),
    readTextFile: vi.fn(),
    spawn: vi.fn(),
    writeFile: vi.fn(),
    writeBinaryFile: vi.fn(),
    writeTextFile: vi.fn(),
  } as SandboxSession;

  beforeEach(() => {
    vi.clearAllMocks();
    executeGitHubShell.mockResolvedValue({ exitCode: 0, stderr: "", stdout: "" });
    run.mockResolvedValue({ exitCode: 0, stderr: "", stdout: "" });
  });

  it("clones through the scoped credential lease before creating and validating the checkout", async () => {
    await initializeDeployedCheckout(sandbox, "child-1");

    expect(executeGitHubShell).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "gh repo clone 'acme/agents' repository -- --branch 'main' --single-branch",
        permissions: [{ access: "write", provider: "github", repositories: ["acme/agents"] }],
      }),
      expect.objectContaining({ connector: "github/agent-author", org: "acme" }),
      expect.objectContaining({ sessionId: "child-1" }),
    );
    const getSandbox = executeGitHubShell.mock.calls[0]![2].getSandbox;
    expect(await getSandbox()).toBe(sandbox);
    expect(run).toHaveBeenCalledOnce();
    const command = run.mock.calls[0]![0].command as string;
    expect(command).toContain("remote set-url origin 'https://github.com/acme/agents.git'");
    expect(command).toContain("git -C '/workspace/repository' switch -c 'eve/selfmod-");
    expect(command).toContain("realpath -e -- '/workspace/repository/apps/weather/agent'");
    expect(command).toContain('case "$agent" in "$root"/*)');
  });

  it("stops before touching a checkout when authentication or clone fails", async () => {
    executeGitHubShell.mockResolvedValue({
      exitCode: 128,
      stderr: "Repository not found",
      stdout: "",
    });
    await expect(initializeDeployedCheckout(sandbox, "child-1")).rejects.toThrow(
      "Could not check out configured repository acme/agents (exit 128).",
    );
    expect(run).not.toHaveBeenCalled();
  });

  it("rejects an invalid application or agent directory", async () => {
    run.mockResolvedValue({ exitCode: 2, stderr: "", stdout: "" });
    await expect(initializeDeployedCheckout(sandbox, "child-1")).rejects.toThrow(
      "verify the configured application directory and agent/ exist inside the checkout",
    );
  });
});

describe("deployed self-modification sandbox", () => {
  it("uses Vercel Sandbox when deployed on Vercel", () => {
    const environment = createDeployedSelfModificationEnvironment({
      isMicrosandboxSupported: () => false,
      isDeployedOnVercel: () => true,
    });
    expect(environment.provider).toBe("vercel");
  });

  it("uses microsandbox outside Vercel when it supports mutable network policies", () => {
    const environment = createDeployedSelfModificationEnvironment({
      isMicrosandboxSupported: () => true,
      isDeployedOnVercel: () => false,
    });
    expect(environment.provider).toBe("microsandbox");
  });

  it("rejects providers that cannot safely broker checkout credentials", () => {
    expect(() =>
      createDeployedSelfModificationEnvironment({
        isMicrosandboxSupported: () => false,
        isDeployedOnVercel: () => false,
      }),
    ).toThrow("Vercel Sandbox or a supported microsandbox");
  });

  it("prepares reusable CLI tooling without checkout contents or credentials", async () => {
    const commands: string[] = [];
    const writes: string[] = [];
    await prepareDeployedSelfModificationSandbox({
      resolvePath: (path) => `/workspace/${path}`,
      run: async ({ command }) => {
        commands.push(command);
        return { exitCode: 0, stderr: "", stdout: "" };
      },
      writeTextFile: async ({ path }) => {
        writes.push(path);
      },
    });

    expect(commands[0]).toContain("git ripgrep ca-certificates nodejs npm");
    expect(commands.join("\n")).toContain("typescript@6.0.3");
    expect(commands.join("\n")).not.toContain("EVE_SELF_MODIFICATION_GITHUB_TOKEN");
    expect(writes).toEqual(
      expect.arrayContaining(["/workspace/.eve-code/gh", "/workspace/.eve-code/diagnostics.cjs"]),
    );
  });
});
