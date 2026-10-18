# karpathy-wiki-mcp

A sandboxed MCP server that implements Andrej Karpathy's [LLM Wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) pattern. Its purpose is to **evaluate local models** in LM Studio. Each agent session gets its own wiki folder. The model then ingests sources, cross-links pages, answers questions from the wiki and lints it. You grade the result by opening that folder in Obsidian.

The tools are written for 26–31B models such as Gemma 31B, Gemma 26B and Qwen:
- arguments are flat;
- replies are plain markdown and end with a `Next:` hint;
- errors say how to fix the problem and give an example;
- names are matched leniently, with "did you mean" suggestions;
- every page write reports any links to pages that don't exist yet.

`wiki_get_info` returns a complete manual (`src/guide.ts`). It covers the method, the INGEST, QUERY and LINT recipes, a worked example, and the common mistakes.

## Setup

This needs Node 20 or newer.

```bash
npm install
npm run build
npm test         # unit and in-memory MCP tests
npm run e2e      # starts the built server over stdio and runs a full ingest
```

Add the server to LM Studio (`~/.lmstudio/mcp.json`):

```json
"karpathy-wiki": {
  "command": "/absolute/path/to/node",
  "args": ["/absolute/path/to/karpathy-wiki-mcp/dist/index.js"]
}
```

Options are set as environment variables or flags:

| Env | Flag | Default | Meaning |
|---|---|---|---|
| `WIKI_ROOT` | `--root` | `<repo>/wikis` | Where sandboxes are created |
| `WIKI_SEED_DIR` | `--seed` | `<repo>/seed` | `.md`/`.txt` files copied into each new sandbox's `raw/`. Use `none` to start empty |
| `WIKI_LMSTUDIO_URL` | `--lmstudio-url` | `http://127.0.0.1:1234` | Used only to guess the model name when the agent leaves it out |

## Running an evaluation

1. Open a new LM Studio chat and use this system prompt: `You have access to a wiki MCP server. Your model name is gemma-3-31b. Call wiki_get_info before anything else.`
2. Paste a prompt from `scenarios/`, starting with `01-cold-start-ingest.md`.
3. Open `wikis/<sandbox_id>/` **as its own Obsidian vault**, then go through that scenario's checklist. Opening the sandbox folder alone keeps `[[links]]` from resolving into other sandboxes.

`scenarios/README.md` gives the expected pages and lists the deliberate conflicts in the seed data. Don't show that file to the model.

## Sandbox layout

```
wikis/20261018-143005-gemma-3-31b/    sandbox_id = folder name (no colons: Obsidian forbids them)
  SCHEMA.md   the manual (the schema layer)
  index.md    catalog, rebuilt by the server after every change
  log.md      append-only: "## [YYYY-MM-DD HH:mm] op | title"
  raw/        sources: seed files plus pasted text; read-only for the agent
  wiki/       pages; filename = title, YAML frontmatter written by the server
```

## Tools

- `wiki_get_info`
- `wiki_start(model)`
- `wiki_status`
- `wiki_list(folder)`
- `wiki_read(name, offset)`
- `wiki_search(query, scope)`
- `wiki_create_page(title, type, summary, content, sources, tags)`
- `wiki_edit_page(title, mode, content, section, summary, sources, tags)`
- `wiki_delete_page(title, reason)`
- `wiki_add_source(title, content)`
- `wiki_lint`
- `wiki_log(operation, title, details)`

Every tool except the first two takes `sandbox_id`.

## What the server does for the model

Be aware of these when you grade:
- **index.md is maintained for the model.** The server rebuilds it from page frontmatter after every change, so the index can't fall out of sync with the pages. That means index upkeep is not part of the test.
- **log.md is written by both sides.** The server logs every create, edit and delete. Ingest, query and lint entries come only from the model calling `wiki_log`, so their presence is part of the test. A retried call can produce a duplicate line.
- **"Ingested" is a proxy.** A raw source counts as ingested once a `source` page cites it. That doesn't prove the model read or integrated the source.
- **Frontmatter comes from the server.** The model passes `type`, `summary`, `sources` and `tags`. Source names that don't exist are rejected with a warning and not saved.

## Trust model

LM Studio starts one server process that all chats share, and MCP doesn't tell the server which chat is calling. Sandboxes are therefore separate **namespaces for one trusted local user**, not security boundaries: an agent that knows another sandbox's id can use that sandbox.

What the server does enforce:
- No path can leave `WIKI_ROOT`. Traversal and symlinks are refused.
- Raw sources are never modified.
- Writes are atomic.
- Calls to the same sandbox run one at a time.
- Only one server process runs per `WIKI_ROOT`, enforced by `.server.lock`.

Limits are 100 KB per file and 2,000 pages per sandbox.

## License

MIT
