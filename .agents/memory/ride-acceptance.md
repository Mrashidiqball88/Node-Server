---
name: Ride acceptance
description: Concurrency and ownership rule for assigning drivers to ride requests.
---

Driver assignment must be an atomic conditional update that matches only rides still in `requested` status and excludes the passenger’s own user ID.

**Why:** A read-then-write flow allows two drivers to claim the same ride under concurrent requests, and a passenger must not be able to accept their own request.

**How to apply:** Keep the status transition and driver assignment in one MongoDB update, return a conflict when no requested ride remains, and preserve the assigned driver and acceptance timestamp.