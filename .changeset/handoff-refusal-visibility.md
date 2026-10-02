---
"eve": patch
---

When a newer deployment refuses or fails to take over a session, the current owner now logs a `session handoff refused` warning with the session ID, both deployment IDs, the reason, and any error from the target, instead of keeping the session silently.

A caller deployment on this release now relays remote agent tool approvals and sign-in requests to sessions still owned by an eve 0.66 to 0.68 deployment. Production callbacks reach the newest deployment, which previously rejected them with `400 Unsupported callback kind.`
