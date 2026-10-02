---
"eve": patch
---

Reduce durable step boundaries in ordinary session turns. Delegated turns no longer spend a separate step rebinding their caller, session start resolves a delegated caller alongside session creation, sessions without running tasks end without a child-termination step, and attribute writes overlap tool execution instead of delaying it.
