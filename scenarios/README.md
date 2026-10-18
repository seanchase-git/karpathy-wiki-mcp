# Wiki MCP evaluation scenarios

Five prompts that exercise the LLM-wiki MCP server end to end, using the fictional Harrow Valley seed sources in `../seed/`. The facts are invented, so anything a model gets right must have come from the sources.

## How to run

1. Start a **fresh LM Studio chat** with the model under test.
2. Set the system prompt to:
   `You have access to a wiki MCP server. Your model id is <MODEL>. Call wiki_get_info before anything else.`
   (replace `<MODEL>` with the id of the model under test, e.g. `qwen3-32b`. Change it every time you switch models).
3. Paste the scenario's prompt block verbatim and let the agent run.
4. Open the sandbox folder `wikis/<sandbox_id>/` as an **Obsidian vault** and walk the scenario's "What good looks like" checklist. Check the graph view, backlinks, `index`/`log` pages and the `raw/` folder.

## Scenario order

| # | File | Tests |
|---|------|-------|
| 1 | `01-cold-start-ingest.md` | `wiki_start`, ingesting the four seed sources into a cross-linked wiki |
| 2 | `02-query-and-writeback.md` | Answering from the wiki, citing pages, filing a synthesis, refusing to invent |
| 3 | `03-contradiction.md` | Adding a new source that conflicts with an existing fact |
| 4 | `04-lint-and-repair.md` | `wiki_lint`, repairing broken links and orphans |
| 5 | `05-resume-session.md` | Re-orienting in an existing sandbox via `wiki_status` |

Scenario 1 creates the sandbox. **Scenarios 2-5 continue an existing sandbox**: use a new chat each time, and replace `<SANDBOX_ID>` in the prompt with the sandbox id the agent reported in scenario 1 (it is the folder name under `wikis/`). Run them in order on the same sandbox, ideally with a copy of the folder saved between scenarios so a failure does not contaminate later runs.

## Seed facts worth knowing

The seed set contains exactly one deliberate conflict between two documents, checked in scenario 3. It is intentionally not flagged in the documents.

- Railway opening year: `seed/01 Harrow Valley Railway.md` says **1874** (14 March 1874); `seed/02 Calder-Voss Mining Company.md` says **1879**.

Expected entity pages: Harrow Valley Railway, Calder-Voss Mining Company, Tallow Bridge, Ingrid Halvorsen Pell, plus Tobias Calder, Marek Voss, Dunmoor Mine, Sable Gap, Gannet Bank, Pell & Daughters, Harrow Valley Railway Preservation Society, "Mirren" locomotive. Expected concept pages: Switchback grade, Rack railway (Pell rack), Narrow-gauge railway.

Grading is by Sean's judgement in Obsidian, not automatic. Note per model: tool calls that errored, pages invented without a source, and whether the model needed prompting to continue.
