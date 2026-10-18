# Scenario 5: Resume session

Continues the sandbox, ideally after a gap: start a brand-new chat so the model has no memory of earlier scenarios. Optionally, before starting, drop one extra file into `raw/` (any short invented note about Harrow Valley) without ingesting it, to check the agent notices it.

## Prompt

```
Continue working on sandbox <SANDBOX_ID>.
```

## What good looks like

- [ ] The agent called `wiki_get_info` first, then `wiki_status` to reorient, and did not call `wiki_start` (no new sandbox was created).
- [ ] It read the recent log and index (via `wiki_log` / `wiki_list` / `wiki_read`) to learn what had already been done.
- [ ] It identified concrete gaps: for example uningested raw sources (the extra file, if you added one), thin pages, missing entity pages (Marek Voss, Dunmoor Mine, Gannet Bank, Pell & Daughters, the Preservation Society, "Mirren"), or concept pages not yet created (Narrow-gauge railway).
- [ ] It actually improved the wiki: at least three pages created or meaningfully extended with facts from the sources, each with citations and links.
- [ ] Newly created pages are linked from existing pages and the index; no new orphans.
- [ ] Existing Contradictions sections (Pell's birth year, railway opening year) were preserved and not "resolved" without evidence.
- [ ] It ran `wiki_lint` at some point and addressed what it reported.
- [ ] A log entry records the session's work.
- [ ] The final message summarizes what changed and suggests sensible next steps, without inventing facts or claiming work it did not do. Compare the claims with the vault.
