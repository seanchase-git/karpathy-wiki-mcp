# karpathy-wiki-mcp

Sandboxed Karpathy LLM-Wiki MCP server (TypeScript, stdio) for evaluating local models in LM Studio. See README.md.

- Planning: `BACKLOG.md` (open work, `▶ NEXT` handoff) and `DONELOG.md` (finished, append-only). IDs `B-nnn`.
- Gate: `npm test && npm run e2e` must pass before a commit.
- `src/guide.ts` is the model-facing manual; keep tool/argument names there in sync with `src/server.ts`.
- Never put seed facts (`seed/`, `scenarios/`) into the guide or tool descriptions — that leaks eval answers.
- `wikis/` is runtime output (gitignored).
