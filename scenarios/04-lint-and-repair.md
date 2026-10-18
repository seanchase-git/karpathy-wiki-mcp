# Scenario 4: Lint and repair

Continues the sandbox. Do this **before** starting the chat:

1. Open `wikis/<sandbox_id>/` in Obsidian.
2. Delete the page file for **Tobias Calder** (the entity page, likely `entities/Tobias Calder.md`, or wherever the model put it). If the model never made one, delete the **Sable Gap** entity page instead; if neither exists, delete the **Switchback grade** concept page.
3. Note which file you deleted and how many pages used to link to it (check backlinks first).

## Prompt

```
Continue with sandbox <SANDBOX_ID>. I think the wiki has a few problems: some pages seem to have been lost. Please run a health check on it and fix whatever you find. Don't just report problems; repair them. If a page has been lost and you can rebuild it from the sources, do so. Otherwise fix the links so nothing points at a page that doesn't exist. Log what you did, and tell me what you changed.
```

## What good looks like

- [ ] The agent ran `wiki_lint` and read its results before editing.
- [ ] The broken links caused by the deleted page were found (every page that linked to it is named in the agent's report).
- [ ] The deleted page was **recreated** from the raw sources with accurate facts and citations, or, if the agent removed the links instead, it said why and did so on every referring page.
- [ ] After repair, no `[[link]]` in the vault points to a missing page (check Obsidian's unresolved-links view or run `wiki_lint` again).
- [ ] Orphan pages (no inbound links), if any were reported, are now linked from the index or a relevant page, or deleted with reason.
- [ ] The recreated page matches the sources: spot-check three facts (for Tobias Calder: ironmonger of Tallow Bridge, co-founded Calder-Voss in 1869, hired Pell in 1871; his son Edmund became chairman in 1921).
- [ ] Existing Contradictions sections and unrelated pages were left intact.
- [ ] A `lint` entry appears in the log listing what was found and fixed.
- [ ] The agent re-ran lint at the end (or otherwise verified) and reported a clean or near-clean result honestly.
