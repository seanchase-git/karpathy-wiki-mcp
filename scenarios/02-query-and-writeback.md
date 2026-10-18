# Scenario 2: Query and write-back

Continues the sandbox from scenario 1.

## Prompt

```
Continue with sandbox <SANDBOX_ID>. I have two questions and I want you to answer them using only what's in the wiki.

First: how did Ingrid Halvorsen Pell's engineering work change what the Calder-Voss Mining Company could do with the Dunmoor Mine, and how did the two techniques she used on the railway differ from each other? Cite the wiki pages you relied on, and then save your answer in the wiki as its own page so I can find it later, linked to the pages it draws on.

Second: what was the annual tonnage of ore carried by the Harrow Valley Railway at its peak?

If the wiki doesn't cover something, just tell me that.
```

## What good looks like

- [ ] The agent searched or read existing pages (`wiki_search` / `wiki_read`) before answering, rather than answering from memory.
- [ ] The first answer is correct and uses facts from at least two documents: Pell hired 1871 and chose narrow gauge; the Sable Gap switchback (zig-zag, reversing at spurs, slow but no special locomotives) versus the Gannet Bank rack section (1891, toothed rail, 1-in-6, cut about forty minutes); lower-grade seams became profitable and ore cost fell about two thirds.
- [ ] The answer cites wiki page names in `[[wikilink]]` form and the links resolve.
- [ ] A new page of type `synthesis` (or `comparison`) was created via `wiki_create_page` with a sensible title, and it links to the entity and concept pages used.
- [ ] The existing entity/concept pages (Ingrid Halvorsen Pell, Switchback grade, Rack railway, or similar) received a back-link or "see also" to the new page, and the index was updated.
- [ ] The second question gets an honest "the wiki doesn't cover this": no tonnage figure is stated, and no number is invented. The agent may say what related facts exist (400 wagons, eleven locomotives) but does not present them as the answer.
- [ ] The railway opening-year conflict is not hidden if the answer touches the date; if mentioned, both 1874 and 1879 appear with their sources.
- [ ] The log has an entry for the query and the filed synthesis page.
- [ ] No unrelated pages were deleted or rewritten.
