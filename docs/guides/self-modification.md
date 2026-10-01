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

The `deployed` option accepts:

- `authorize` (required): decides whether the current caller can delegate to the coding subagent.
- `github.repository` (required): the repository to check out and open pull requests against, in `owner/repo` form.
- `github.connector` (required): the GitHub Vercel Connect connector that provides repository credentials.
- `directory`: the application directory relative to the repository root. Defaults to `"."`.
- `baseBranch`: the branch pull requests target. Defaults to `"main"`.

The top-level `model` and `reasoning` options apply to both the local and deployed subagents.

### Authorize callers

`authorize` receives the current authenticated `principal`, or `null` for anonymous callers, and the request's `channel` kind and metadata. Return `true` to offer the coding subagent. Returning `false` or throwing hides it, and eve logs the thrown error. The callback runs on session start and on each turn, including follow-ups.

The principal ID in the example is illustrative. Check the identities your channel produces before you write a policy.

### Connect GitHub

Create a GitHub Vercel Connect connector, attach it to the deployed project, and install it on the configured repository. Grant the repository permissions needed to read source, push branches, and create pull requests. Use repository rules to require review on protected branches.

### Sandbox and checkout

The deployed subagent's sandbox runs on Vercel Sandbox, or on microsandbox for self-hosted deployments. On other hosts, delegation fails with an error naming the supported providers.

The sandbox checks out the repository to `/workspace/repository`, which must contain the configured application and its `agent/` directory. The subagent installs dependencies when needed, using the repository's package manager and lockfile. The project `eve` CLI is available after installation; in a monorepo, it may live at the workspace root. Private packages need their own installation credentials because the sandbox does not inherit host credentials.

### Request a change

Ask for persistent changes in ordinary terms, such as “Replace your hardcoded weather tool with a live weather API.” The parent delegates the work to the coding subagent, which has its own checkout, so the source does not need to exist in the parent's sandbox.

Questions, investigations, and design requests are read-only. An explicit implementation request authorizes the subagent to push a branch and open a draft PR. It may edit any file in the repository; the application directory gives it context.

Follow-up turns continue the same subagent and reuse its checkout. Independent requests use a separate subagent. A draft PR does not change the running agent: review and merge it, then deploy.

To add a registry capability, the subagent searches with `eve registry search "slack" --json` and installs source with `eve add channel/slack --non-interactive --skip-setup`. Complete OAuth, secret binding, and other external setup after you review and deploy the change. The subagent's handoff lists the PR URL, the checks it ran, and any remaining setup.

## Run without self-modification

Self-modification runs when you mount the extension yourself under `agent/extensions/`, or when you run `eve dev`, which mounts the bundled extension by default. To start `eve dev` without the bundled extension, pass `--no-default-extensions`:

```bash
eve dev --no-default-extensions
```

This flag disables all bundled development extensions for that server, including self-modification. It does not affect an extension you have mounted yourself; remove that mount to turn it off.

## What to read next

- [Terminal UI](./dev-tui): work with your agent locally.
- [Instructions](../instructions): define the agent's behavior.
- [Tools](../tools): add model-callable actions.
- [Skills](../skills): give the agent reusable procedures.
