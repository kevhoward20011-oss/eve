---
"eve": patch
---

Reduce durable step boundaries in ordinary session turns. Delegated turns no longer spend a separate step rebinding their caller, session start resolves a delegated caller alongside session creation, sessions without running tasks or blocking runs skip the child-termination and cancellation steps, a finished session replies before its timeout timer is cancelled, and attribute writes overlap tool execution instead of delaying it.
