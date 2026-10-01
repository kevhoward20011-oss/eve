---
title: "Self-Modification"
description: "Update authored agent files locally or propose repository changes from a deployed agent."
---

When `eve dev` starts a local server, it mounts the bundled self-modification extension by default. Ask your agent to change its instructions, tools, skills, or other files under `agent/`; eve delegates the source work to the `self-modification__agent` subagent. Connecting to an existing server with `eve remote connect --url <url>` does not add the bundled extension to that server.

The bundled extension is for local development and is not included in production builds. To let a deployed agent propose changes, mount the extension yourself and add the `deployed` option described in [Propose changes from a deployed agent](#propose-changes-from-a-deployed-agent).

```bash
eve dev
```

For example, ask the agent to add a reusable action:

```text
Add a tool that converts temperatures between Celsius and Fahrenheit.
```

The self-modification subagent changes the authored files in your project. Review the diff and test the new behavior as you would for any other source change. `eve dev` reloads changes while you work.

## Change the self-modification model

The subagent uses your agent's model by default. To give it a different model or reasoning level, ask for it directly:

```text
Switch the self-modification subagent to openai/gpt-6-sol with low reasoning.
```

The first time, this creates `agent/extensions/self-modification/extension.ts` with those settings. After that file exists, later changes edit it. You can also edit the file yourself: it accepts `model` and `reasoning` options.

## Propose changes from a deployed agent

Add a `deployed` option to the self-modification mount. The same mount keeps local editing in `eve dev`; outside `eve dev`, it delegates repository work to a separate coding subagent, `self-modification__deployed`, which proposes changes as draft pull requests instead of changing the running agent. Only one of the two subagents is offered at a time.

```ts
// agent/extensions/self-modification/extension.ts
import selfModification from "eve/self-modification";

export default selfModification({
  deployed: {
    authorize: ({ principal }) => principal?.principalId === "trusted-editor",
    github: { repository: "acme/agents", connector: "github/agent-author" },
    directory: "apps/support",
    baseBranch: "main",
  },
});
```

`authorize`, `github.repository` (in `owner/repo` form), and `github.connector` are required. `directory` is the application directory relative to the repository root and defaults to `"."`; `baseBranch` is the branch pull requests target and defaults to `"main"`. `authorize` receives the current authenticated `principal` (or `null`) and the request's `channel` kind and metadata. The callback must return `true` to make the coding subagent available; `false` or a thrown error hides it, and a thrown error is logged. It runs on session start and each turn, including follow-ups. The example principal ID is illustrative: check the identities produced by your channel before writing your policy. Setup scaffolds `authorize: () => true`, which lets any caller who can reach the deployed agent request draft PRs, and warns you about it. We recommend replacing it with a policy that admits only trusted callers before you deploy. If your mount file already contains settings you wrote, setup does not rewrite it; it prints the `deployed` option for you to add.

This is a delegation gate, not a per-GitHub-command authorization check. GitHub access is determined separately by the connector installation and repository permissions. The top-level `model` and `reasoning` options apply to both the local and deployed subagents. The deployed subagent's sandbox runs on Vercel Sandbox, or on microsandbox for self-hosted deployments; on other hosts, delegation fails with an error naming the supported providers. The repository must contain the configured application and its `agent/` directory. The sandbox checks out the repository before the child works in it. The child installs project dependencies when needed, using the repository's package manager and lockfile. The project `eve` CLI is available only after its dependencies are installed; in a monorepo, it may live at the workspace root rather than the application directory. Private packages need their own installation credentials; the sandbox does not inherit host credentials.

Provision a GitHub Vercel Connect connector, attach it to the deployed project, and restrict its installation to **only the configured repository**. Give it the repository permissions needed to read source, push branches, and create pull requests. Require review with repository rules that prevent the bot from bypassing protected branches. The `github.repository` setting chooses the intended checkout and PR target, **not** an access restriction on the connector: the coding tool can request tokens for other repositories in the connector's installation. Do not expose production secrets to CI or preview deployments triggered by bot-authored pushes.

Ask for persistent changes in ordinary terms, such as “Replace your hardcoded weather tool with a live weather API.” The parent delegates source work to the self-modification child, which has its own repository checkout. The source does not need to exist in the parent's sandbox. Questions about possible changes are read-only; they do not authorize publication.

An explicit implementation request authorizes a draft PR. Ask for an investigation or design instead when you want read-only work. The child works in `/workspace/repository`; its application directory is context, not a limit on which repository files it may edit. It uses a child-owned sandbox for repository work and reuses the checkout on follow-up turns. Continue with the same child for follow-ups; independent requests should use separate children. The running parent is not redeployed or updated by a source proposal. Review and merge the PR, then deploy separately. A lost sandbox is not silently restored from an unpublished checkout.

To add a registry capability, the child first installs project dependencies if necessary, then searches using the checkout-installed `eve registry search "slack" --json` and installs source with `eve add channel/slack --non-interactive --skip-setup`. This **does not activate the integration**. Inspect the installed source and dependency diff, then complete OAuth, secret binding, or other external setup after review and deployment. The handoff should distinguish the PR URL and checks run from outstanding setup; do not send secret values in chat.

### Troubleshoot deployed proposals

| Symptom                                                | Check                                                                                                                                                                                                                          | Next action                                                                                                                                                      |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent says it cannot change its tools                  | Check whether the model received the self-modification child tool. A denied `authorize` callback also omits the child; a resolver error appears in server logs as `Dynamic subagent resolver (...) threw — omitting subagent.` | If the tool is missing, check the caller's principal and policy, then investigate any logged resolver error. If present, check the parent's delegation guidance. |
| Checkout or GitHub command fails                       | Check that the Connect connector is attached to the deployed project and installed on the configured repository with read/write permissions.                                                                                   | Fix the connector installation or permissions; do not paste a token into chat or sandbox files.                                                                  |
| Dependency installation fails                          | Check the checkout's package manager, lockfile, and private-package access.                                                                                                                                                    | Provide package access through an appropriate isolated setup, not inherited production credentials.                                                              |
| Push succeeds but no PR appears                        | Inspect the working branch and existing PR on GitHub.                                                                                                                                                                          | Resolve the reported publication failure and continue the same child; do not create an unrelated branch.                                                         |
| Registry files exist but the integration does not work | Check which external setup steps remain in the handoff.                                                                                                                                                                        | Complete those steps after reviewing and deploying the source change.                                                                                            |

## Run without self-modification

Pass `--no-default-extensions` when you do not want `eve dev` to mount bundled development extensions:

```bash
eve dev --no-default-extensions
```

This disables the complete bundled default set for that server, including self-modification. It does not remove files from your project or disable extensions that you have explicitly mounted under `agent/extensions/`.

## What to read next

- [Terminal UI](./dev-tui): work with your agent locally.
- [Instructions](../instructions): define the agent's behavior.
- [Tools](../tools): add model-callable actions.
- [Skills](../skills): give the agent reusable procedures.
