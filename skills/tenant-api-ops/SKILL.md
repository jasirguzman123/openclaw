---
name: tenant-api-ops
description: Execute tenant API operations for this tenant only. Fetch documentation from the URL configured for this runtime and keep actions scoped to tenant domains.
---

# tenant-api-ops

## Startup (Required)

1. Read the file `tenant-docs/.docs-base-url` (one line: the documentation base URL for this tenant).
2. Use `web_fetch` on that URL to get the index (list of paths).
3. For each path listed in the index, use `web_fetch` on the base URL + path (e.g. base URL + `api/foo.md`).
4. Never resolve docs under `skills/tenant-api-ops/` or any skill directory.
5. If the file is missing or the docs URL fetch fails, report: tenant docs unavailable.

## Tenant Scope

- All requests are in this tenant's business context.
- Allowed API domains: localhost
- Do not call external, third-party, or unrelated domains.

## Docs paths (relative to base URL)

- api/openapi.json
- api/46638176.md
- api/3fbe2603.md

## Execution Rules

1. Map user intent to documented endpoints and entities.
2. If operation is undocumented, explain the gap and stop.
3. Use update_id context when reporting task status.
4. Return concise structured output: action, endpoint, request summary, response status, and business result.
