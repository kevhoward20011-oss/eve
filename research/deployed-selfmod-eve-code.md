---
issue: TBD
status: draft
last_updated: "2026-10-01"
---

# Deployed self-modification with eve-code

## Goal and starting point

Implement deployed self-modification as a coding subagent for a configured
repository that uses `eve/extensions/code` to author draft PRs. Selfmod owns repository context
and sandbox initialization; eve-code owns coding and PR work.

Start from **`prha/deployed-eve-code`**, inspected at `77fbc6932`. Do not start from
or merge `prha/eve-code` to implement this plan. That branch contains a separate
local sandbox redesign that is not a prerequisite.

On this baseline, local selfmod uses `just-bash` with an authored-source mount,
local registry setup integration, and local trace tools. It does **not** use the
isolated local `prepare`/`apply` workflow discussed in the initial architecture
exploration. Preserve the target branch's local product.

This document proposes new APIs and behavior, not shipped functionality. Existing
deployed configuration does not need backward compatibility. Do not add aliases,
configuration migrations, fallback publishers, or a compatibility mode. Keep the
existing local authoring surface and behavior intact.

## Product decisions

- Deployed selfmod produces a source proposal, not a live agent update. An explicit
  implementation request authorizes creating or updating a draft PR. Questions,
  investigations, and design requests authorize read-only work, not publication.
- The configured repository determines the checkout and intended PR target, but
  is not an enforced GitHub access boundary. The application directory identifies
  the agent within the checkout; it is not an editing boundary. Shared packages,
  manifests, lockfiles, tests, workflows, and selfmod's own authored configuration
  may be changed when relevant to the request.
- Use normal Git branches, commits, fetches, and rebases. Remove snapshot-based
  publication and the requirement that the target branch remain unchanged.
- Prefer patches for authored changes, but allow scripts, dependency installers,
  generators, and formatters inside the isolated sandbox.
- Use the project's eve CLI for registry discovery and source installation. Skip
  external setup. OAuth, secret binding, provisioning, merging, production
  deployment, and continuous PR watching are outside this product's workflow.
- Computer use is not required. Do not install a desktop to support source editing.
- Keep one working branch and PR per child task. Follow-ups continue the same child
  and checkout. A new independent request gets a new child and checkout.

### Publication and security boundary

Adopt eve-code's authenticated GitHub commands, **not** a hard draft-only publisher.
Creating a draft is the workflow default, not a permission guarantee. Repository
rules must require review and prevent the bot from bypassing protected branches.
Repository-scoped write credentials can support operations beyond PR creation;
do not describe command parsing or instructions as preventing all such operations.
PR pushes may trigger CI and preview deployments. Those environments must treat
bot-authored code as untrusted and must not expose production secrets.

The deployed mount requires a fail-closed `authorize` callback to decide whether
the current principal may delegate to the coding child. It is checked on session
start and each turn; it is not a per-command GitHub permission check. Scope the
GitHub connector installation to only the intended repository: eve-code's `gh`
tool mints a token for the repository declared in each tool call, not necessarily
the configured checkout. Without a fixed binding, a connector with access to
other repositories in the organization lets the child request tokens for those
too. Keep the checkout's origin token-free and use eve-code's per-command
credential leases.

Keep real credentials outside sandbox files and process environments. Use the
existing brokered header-transform mechanism, with short leases and cleanup on
success, failure, and cancellation. No parent sandbox, production environment,
Vercel deployment connector, or host credentials are inherited. Package scripts
and repository code remain untrusted even when they run successfully in isolation.
Leases constrain token lifetime and repository scope; they do not make arbitrary
code sharing the sandbox trustworthy during an authenticated operation.

Changes to checked-out selfmod configuration affect a future deployment only.
Never import it to decide the current run's connector or credential scope.
Use existing sandbox resource limits and destination-validation patterns; do not
replace them with an unrestricted host shell or unbounded command execution.

## Proposed authoring API

Keep one `eve/self-modification` mount. A `deployed` option enables the deployed
product; the mount keeps its local behavior:

```ts
// agent/extensions/self-modification/extension.ts
import selfModification from "eve/self-modification";

export default selfModification({
  // model: "provider/model",
  // reasoning: "high",
  deployed: {
    authorize: ({ principal }) => principal?.principalId === "trusted-editor",
    github: { repository: "acme/agents", connector: "github/agent-author" },
    directory: "apps/support",
    baseBranch: "main",
  },
});
```

The extension contributes two children with distinct source trees:
`self-modification__agent` (local) and `self-modification__deployed`. Each dynamic
resolver returns `null` outside its mode, so the root agent sees at most one:
`eve dev` offers only the local child; other runtimes offer the deployed child when
`deployed` is configured and `authorize` allows the caller. A single mount means no
namespace collision with the bundled development extension, and the TUI and setup
keep their fixed mount path.

Require an authorization callback and `github: { repository, connector }`;
`directory` defaults to `"."` and `baseBranch` to `"main"`. Forge-specific identity
and credentials live under the provider key, so another git forge would be a sibling
key; `directory` and `baseBranch` are git-general. Validate GitHub identifiers and
safe relative paths. Configure the connector's installation for only this
repository; `github.repository` does not constrain eve-code's `gh` credential
requests.

For the initial product, use Connect-backed GitHub authentication. Delete the old
deployed PAT exception and checkout/publish credential-provider configuration.
Do not add a second provider abstraction solely to preserve those configurations.
General eve-code credential helpers can remain available to other consumers.

Selfmod derives and wires the child, code mount, sandbox, and credential broker.
Consumers do not repeat the same repository context in agent, sandbox, and
extension files. Keep model and reasoning overrides; avoid exposing every eve-code option through
selfmod. Setup writes the `deployed` option into a generated mount; when the mount
contains authored settings it provisions the connector and prints the option to
merge rather than rewriting the file.

Sandbox modules are evaluated by `eve build` and `eve dev`, so the deployed child's
sandbox must not throw at import. Outside deployed mode, or on hosts without Vercel
Sandbox or microsandbox, it binds an inert environment and fails when opened.

## Ownership and lifecycle

```text
parent delegates an implementation request
  -> deployed selfmod child
       -> dedicated sandbox + full checkout + task branch
       -> eve-code mount
            -> inspect / edit / CLI / checks
            -> authenticated Git / signed commit when required / draft PR
       -> concise handoff: PR URL, validation, remaining setup
```

The extension root cannot own a sandbox or mount another extension. Compose code
under the contributed **child agent's** extension slot. Verify packaged discovery
of this exact shape before building around it; do not broaden extension-root
nesting or change the execution engine to implement the product.

Use `/workspace/repository` as the canonical repository root. Supply the configured
application directory and derived `agent/` path as context. Remove the deployed
`/source` alias. An optional read-only `/eve-docs` reference must be independent of
local source mounts, with framework-version context; do not promise a mount that
the deployed sandbox does not actually provide.

Prepare reusable tooling without repository contents or credentials. Initialize
the private checkout after `environment.open()`. Reuse the sandbox on follow-up
turns; never reclone or reset it on ordinary resume. If the sandbox is lost, report
that state rather than silently discarding unpublished edits. Use existing session
lifecycle and expiry controls rather than adding a workspace recovery service.

## Implementation phases

Implement in dependency order. Each phase includes focused tests; final validation
is not a reason to defer security or composition validation. Intermediate commits
may be internal wiring, but do not expose a partially secured deployed product.

### Phase 1: Separate the products and prove composition

1. Extract the local-only extension configuration and contributions from the
   environment-switching implementation. Preserve local mounts, registry/TUI
   integration, trace tools, model inheritance, and bundled development behavior.
2. Define the new `deployed` option on the existing mount. Use separate child
   source trees so local tools and instructions cannot leak into the deployed child.
3. Add a packaged discovery/compilation test for a contributed child that mounts
   `eve/extensions/code`, including its read-only worker and parent-sandbox binding.
   Verify that the parent receives delegation, not the child's coding tools.

**Acceptance:** configuration tests reject the retired deployed shape; the local
suite remains green; the packaged child resolves code tools, skills, and its worker
without flattening their namespaces or duplicating contributions. If composition
has a discovery defect, fix that narrow defect rather than introducing a selfmod
special case in `execution/` or `harness/`.

**Start here:** `packages/eve/src/self-modification/extension/`, `config.ts`,
`mode.ts`, `packages/eve/package.json`, and packaged extension/discovery tests.

### Phase 2: Build the child's development sandbox

Prepare supported Node.js, Git, package-manager tooling, ripgrep, and eve-code's
`installCodeTooling`. Include the tooling revalidation key using the provider's
supported environment options. Do not install computer-use assets or Vercel CLI
authentication. Retain the baseline's supported deployed providers (Vercel Sandbox
and microsandbox); require their typed mutable network-policy capability and fail
clearly when no suitable provider exists.

After `open()`, fetch the configured base and create a working branch in
`/workspace/repository`. Keep remotes token-free. Validate that the
configured application exists within the checkout and has `agent/`, including
symlink containment. Remove the deployed source alias and detached baseline ref.

Leave dependency installation to the coding child when needed, using the repository's
declared package manager and lockfile. Report missing private-package credentials
rather than inheriting host credentials. Allow required package scripts inside the
isolated, non-production environment. The checkout is guaranteed before sandbox
access succeeds; installed project dependencies are not. There is no model-facing
prepare operation and no install-specific workspace reset.

**Acceptance:** scenario tests cover root and monorepo applications, usable coding
CLI tools, unavailable providers, checkout/auth failures, secret-free prepared
artifacts, initialization failure cleanup, and resume with edits preserved. A
second child must not see the first child's checkout. Read-only code workers share
only their owning child's sandbox.

**Start here:** `packages/eve/src/self-modification/{sandbox,git-workspace,git}.ts`
and `packages/eve-code/extension/lib/sandbox.ts`. Use the branch's typed provider
sessions rather than adding methods back to the generic `SandboxSession` interface.

### Phase 3: Replace deployed tools and instructions with eve-code

Mount code in the deployed child and remove selfmod's deployed `edit_file`,
`publish`, `registry_add`, `search_registry`, and model-discovery-specific workflow.
Do not mount local trace inspection. Use ordinary sandbox tools plus code's patch,
search, GitHub, and PR skill contributions. Make code's computer-use tool explicitly
optional and absent here; do not replace it with a tool that always fails.

Keep a short selfmod instruction layer: configured repository/application coordinates,
authoring reusable eve capabilities, read-only versus implementation intent,
source-only registry installation, and the handoff contract. Read repository
`AGENTS.md` files. Tell the child to work in the configured checkout and target
its PR there. This is workflow guidance, not a credential restriction; do not
claim that eve-code's `gh` tool enforces the target. Keep general coding and PR
guidance in eve-code rather than copying it.

Use the installed project CLI from the checkout (which may be at the workspace
root rather than the application directory):

```sh
eve registry search "slack" --json
eve add channel/slack --non-interactive --skip-setup
```

The executable must resolve to the checkout's dependency, not an unpinned remote
CLI download. Inspect installed source and dependency diffs normally. Do not build
a replacement setup-answer protocol. Record missing secrets and external setup as
prerequisite names/actions, never request their values in chat.

Let eve-code fetch/reconcile the base, stage intended changes, use its signed-commit
path when required, and create a draft PR. Use a stable task branch derived from
existing child/task identity. On retry or follow-up, inspect that branch and PR
before creating another; do not overwrite unrelated remote work. Surface conflicts
and partial publication (for example, branch pushed but PR creation failed).
This is normal Git reconciliation, not an exactly-once publication transaction.

**Acceptance:** tests inspect the resolved tool set and instructions, not just the
presence of a mount file. A scenario edits a shared package and app source, runs a
generator/check, installs registry source without setup, and exercises PR creation
and a follow-up. Investigation requests must not edit or publish. Editing selfmod
source must not alter the active connector configuration.

### Phase 4: Remove the old deployed implementation and update setup

Delete unused deployed snapshot validation, protected-path detection, blob upload,
base-ref enforcement, custom publisher, registry continuation/rollback, and old
credential/configuration branches. Keep utilities still required by local selfmod
or the new checkout, and replace tests for deleted guarantees with tests for the
new contract. Do not preserve dead code for hypothetical recovery or compatibility.

Update selfmod setup, registry scaffolds, package exports, authored-package build
coverage, and generated configuration tests to emit the new deployed import.
Retain connector provisioning guidance, including restricting its installation to
the intended repository. Explain required repository permissions/rules and the
absence of production setup.

**Acceptance:** a fresh registry installation produces compilable new configuration;
local installation still produces the local mount; installed-package consumption
works outside this monorepo. Search the tree for stale deployed config examples,
`/source` guidance, custom `publish` references, and draft-only security claims.
Local uses of those names are not automatically obsolete.

**Start here:** `packages/eve/src/self-modification/{proposal,github-publisher,credentials,setup}.ts`,
`extension/production-registry-add.ts`, `packages/eve/src/setup/integrations/self-modification/`,
`apps/docs/registry/eve/self-modification/`, and `packages/eve-self-modification/`.

### Phase 5: Validate the deployed product and document it

Extend `docs/guides/self-modification.md` with the separate deployed authoring API,
repository/connector prerequisites and scope, workspace lifecycle, source-only
registry flow, review boundary, and troubleshooting. Keep its existing local
behavior accurate. Update eve-code documentation for optional computer use. Add
a **minor** eve changeset for the breaking deployed API.

Add deterministic, fixture-owned evals for the deployed child. Cover a requested
source change resulting in a draft PR, monorepo-wide edits, registry installation
with outstanding setup, continued work on an existing PR, read-only investigation,
and connector access failures. Assert that the running parent is unchanged and that
responses distinguish source installation from an active integration.

Use self-contained test doubles at the existing sandbox/Connect/GitHub boundaries;
do not require real GitHub credentials, external service startup, or a production
configuration bypass. Scenario tests must also exercise real Git/CLI subprocesses
and the actual composed extension. Keep existing local fixture evals as regression
coverage rather than rewriting them into deployed tests.

**Acceptance:** the fixture boots, accepts a request, and streams the handoff through
HTTP in CI. Tests verify the resulting branch/PR state and tool effects, not only
model prose. Connector and publication failures are actionable and secret-free.

## Validation and handoff

Read the target worktree's `AGENTS.md` and relevant package guidance before editing.
For every phase, record its completed scope, checks actually run, and remaining
failures in the implementation handoff. Build eve after changing eve-code sources:
its published extension is copied from `packages/eve-code/extension/`; do not edit
the generated copy as the source of truth.

Run formatting, lint, typechecking, and relevant unit tests during implementation.
Use the tier-specific config for filtered framework tests:

```sh
pnpm --filter eve exec vitest run --config vitest.unit.config.ts self-modification
pnpm --filter eve exec vitest run --config vitest.integration.config.ts <pattern>
pnpm --filter eve exec vitest run --config vitest.scenario.config.ts <pattern>
```

Build before scenario suites and follow `packages/eve-code/README.md` for that
package's tests. Run `pnpm guard:invariants` and `pnpm docs:check` before handoff.
E2E runs in CI only. If phases ship as separate PRs, each public behavior change
needs its matching documentation and changeset; do not defer them all to phase 5.

The implementation is complete when deployed selfmod has one coding workflow,
one repository tree, and no custom registry or publication protocol, while the
baseline local product continues to work unchanged.
