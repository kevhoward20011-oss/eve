---
"eve": minor
---

Deployed self-modification now uses a separate `eve/self-modification/deployed` extension with a repository, application directory, base branch, and Connect-backed GitHub connector. It proposes source changes in draft PRs instead of updating the running agent; the former deployed configuration and publisher are no longer supported.
