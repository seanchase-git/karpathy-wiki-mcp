# Scenario 1: Cold start and ingest

Creates the sandbox. Note the sandbox_id the agent reports; you need it for scenarios 2-5.

## Prompt

```
I'd like you to build a wiki from some source documents. Start a new wiki, then read the four source documents that came with it and ingest them one at a time. For each source, write a summary page, create or update pages for the people, places, companies and ideas it mentions, and link everything together so I can browse it. Keep a log of what you do. Only use facts that are in the documents; don't add anything from your own knowledge. When you're finished, tell me the sandbox id and what you created.
```

## What good looks like

- [ ] The agent called `wiki_get_info` first, then `wiki_start`, and reported a sandbox_id.
- [ ] Four raw sources exist in `raw/` (01 Harrow Valley Railway, 02 Calder-Voss Mining Company, 03 Tallow Bridge, 04 Ingrid Halvorsen Pell) and four source-type pages cite them with `[[raw/<file name>]]` links that resolve.
- [ ] Sources were ingested one at a time: the log shows a separate ingest entry per source, not one batch entry.
- [ ] Entity pages exist for at least: Harrow Valley Railway, Calder-Voss Mining Company, Tallow Bridge, Ingrid Halvorsen Pell. Bonus: Tobias Calder, Marek Voss, Dunmoor Mine, Sable Gap, Gannet Bank, Pell & Daughters.
- [ ] Concept pages exist for Switchback grade and Rack railway (the Pell rack), each linked from the entity pages that mention them. Bonus: Narrow-gauge railway.
- [ ] Entity pages are shared across sources: e.g. Ingrid Halvorsen Pell's page draws on at least three source documents and links back to each source page; Tobias Calder is not duplicated under several names.
- [ ] The seed conflict (railway opening 1874 vs 1879) is either recorded on the Harrow Valley Railway page with both sources cited, or at minimum not silently resolved to one year.
- [ ] An overview or index page exists and links to the main pages; graph view shows one connected cluster with no obvious orphans.
- [ ] Claims carry citations (source page or raw link). Spot-check five facts against the seed docs: no invented dates, names or numbers.
- [ ] Every page has a valid page type (source, entity, concept, comparison, synthesis, overview) and no `[[links]]` point to missing pages.
