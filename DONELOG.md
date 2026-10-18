# Done log

## 2026-10-18 — B-000 Initial server
Shipped the 12-tool MCP server (sandbox per session, seeded raw/, derived index, append-only log, BM25 search, lint, model manual via `wiki_get_info`), seed docs (fictional Harrow Valley) and 5 evaluation scenarios. Plan reviewed by Codex ("fix first" → fixes folded in). Codex reviewed the implementation and returned "fix first" with 6 findings: symlink bypass on log and bulk reads, a process-lock race, non-atomic raw writes, false "ingested" on raw/wiki name collisions, no way to remove sources, and a lint fix that named an argument that didn't exist. All 6 are fixed, with regression tests in `test/review.test.ts`. Gate: `npm test` 36/36, `npm run e2e` passed.
