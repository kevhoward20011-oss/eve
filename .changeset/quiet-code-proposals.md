---
"eve": minor
---

Deployed self-modification is now a `deployed` option on the `eve/self-modification` mount. It requires an `authorize` callback, a GitHub repository, and a Vercel Connect connector; `directory` and `baseBranch` default to `"."` and `"main"`. Outside `eve dev`, authorized callers can delegate to a coding subagent that proposes changes as draft PRs without updating the running agent, while `eve dev` keeps local editing. The former `deployed.source`/`target`/`credentials` configuration and publisher are removed. Extension discovery also now finds packaged mounts whose default exports are rewritten during compilation, and built-in extensions mounted from inside the eve package.
