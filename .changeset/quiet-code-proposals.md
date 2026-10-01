---
"eve": minor
---

Deployed self-modification is now configured with a `deployed` option on the `eve/self-modification` mount (`repository`, `directory`, `baseBranch`, and a Connect-backed `github.connector`). Outside `eve dev`, a separate coding subagent proposes source changes as draft PRs instead of updating the running agent, while `eve dev` keeps local editing; the former `deployed.source`/`target`/`credentials` configuration and publisher are no longer supported.
