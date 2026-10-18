# Backlog

## ▶ NEXT
**B-001** Live run in LM Studio: add the server to `~/.lmstudio/mcp.json`, run `scenarios/01` with Gemma 31B (thinking off), review in Obsidian, tune `src/guide.ts`/tool descriptions from what the model gets wrong.

## P2
- **B-002** `WIKI_MANUAL_INDEX=1` mode: agent must maintain index.md itself (harder eval).
- **B-003** Per-call audit log (`calls.jsonl` per sandbox: tool, args, error) to count tool errors per model without reading chat transcripts.

## P3
- **B-004** Semantic/hybrid search (qmd or embeddings) once wikis outgrow BM25.
- **B-005** `raw/assets/` image support.
- **B-006** Optimistic concurrency (`revision` on read/edit) if multiple agents ever share a sandbox.

## Parked
