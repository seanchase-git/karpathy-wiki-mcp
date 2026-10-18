# Done log

## 2026-10-18 — B-000 Initial server
Shipped the 12-tool MCP server (sandbox per session, seeded raw/, derived index, append-only log, BM25 search, lint, model manual via `wiki_get_info`), seed docs (fictional Harrow Valley) and 5 evaluation scenarios. Plan reviewed by Codex ("fix first" → fixes folded in). Codex reviewed the implementation and returned "fix first" with 6 findings: symlink bypass on log and bulk reads, a process-lock race, non-atomic raw writes, false "ingested" on raw/wiki name collisions, no way to remove sources, and a lint fix that named an argument that didn't exist. All 6 are fixed, with regression tests in `test/review.test.ts`. Gate: `npm test` 36/36, `npm run e2e` passed.

## 2026-10-18 — B-007 Ask for a sandbox_id when none is given
The guide, the `wiki_start` description and the server instructions now tell the model what to do: use a sandbox_id the user gave it, start a new wiki when the user asked for one, and otherwise ask the user which of the two they want. Gate: `npm test` 36/36, `npm run e2e` passed.

## 2026-10-18 — B-008 Stop leaking a model name into sandbox ids
A Qwen run created `…-gemma-3-31b` sandboxes. Qwen had passed `model="gemma-3-31b"`, copying the example in the `wiki_start` description, the error hints and the README system prompt. Every model-facing example is now neutral (`<your-model-id>`, `20261018-143005-my-model`). `wiki_start` rejects a missing model and placeholder values, and tells the model to ask the user. The LM Studio model lookup (`src/lmstudio.ts`, `WIKI_LMSTUDIO_URL`) is removed so the server has no host dependency. The README says the server is built for LM Studio and that the model id must go in the system prompt. Gate: `npm test` 35/35 (the LM Studio parser test was removed), `npm run e2e` passed.
