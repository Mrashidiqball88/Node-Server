---
name: API codegen and Zod
description: Compatibility note for the OpenAPI-to-Zod generation setup.
---

The current OpenAPI generator emits Zod 4 APIs such as `zod.email()`, so the shared API validation package and server-side request validation must use Zod 4-compatible dependencies.

**Why:** Regenerating contracts with an older Zod major version causes library typecheck failures even when the OpenAPI document is valid.

**How to apply:** Run API codegen after OpenAPI changes and keep the generated validation package on the Zod major expected by the installed generator.