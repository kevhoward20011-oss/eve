---
"eve": patch
---

Long-lived sessions now move to newer deployments after an eve upgrade: a deployment upgrades handoff checkpoints written by eve 0.66.0 and later instead of leaving the session on its old deployment. Refused handoffs now log a `session handoff failed` warning with the target deployment and reason. Callbacks from remote agents to sessions created by eve 0.66–0.68 no longer fail with `Unsupported callback kind`.
