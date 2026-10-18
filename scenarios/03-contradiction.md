# Scenario 3: Contradiction

Continues the sandbox. The pasted source gives Ingrid Halvorsen Pell's birth year as **1843**; the seed ("04 Ingrid Halvorsen Pell") says **1841**. This is a different conflict from the seed's railway-opening-year conflict.

## Prompt

```
Continue with sandbox <SANDBOX_ID>. I found another source about Ingrid Halvorsen Pell. Please add it to the wiki as a new source called "05 Pell Obituary Notice", ingest it, and update the relevant pages. If it disagrees with anything already in the wiki, don't pick a winner quietly; record the disagreement on the affected page, with both sources cited. Log what you did.

Here is the text:

Source: Tallow Bridge Courier, obituary notice (1912)

Mrs Ingrid Halvorsen Pell died at her home on Tanner's Hill on the 9th of November, aged sixty-nine. Born in Bergen in 1843, she came to this valley as a young widow-to-be and never left it. She was engineer to the Calder-Voss Mining Company for thirty-four years and the first woman in the north to hold a locomotive superintendent's post. The town owes her the Sable Gap switchback and the Gannet Bank rack. Her daughter Astrid, who attends today, will carry on the works at Tallow Bridge. The funeral will be held at St Oswin's, and the shops of Bridge Street are asked to close from noon.
```

## What good looks like

- [ ] `wiki_add_source` was used to store the pasted text under the name "05 Pell Obituary Notice", and a `raw/05 Pell Obituary Notice` file appears in the vault.
- [ ] A source page for it exists and links to `[[raw/05 Pell Obituary Notice]]`.
- [ ] The Ingrid Halvorsen Pell page has a `## Contradictions` section stating birth 1841 (source 04) versus 1843 (obituary), with both sources cited. It does not just overwrite 1841.
- [ ] The age at death is handled sensibly (1912 minus 1841 gives seventy-one, the obituary says sixty-nine) or at least not asserted as fact from one source; the agent does not invent a resolution.
- [ ] New, non-conflicting facts were merged (St Oswin's funeral, 9 November, "thirty-four years", first woman locomotive superintendent in the north) and attributed to the obituary.
- [ ] The original seed conflict is also recorded: the Harrow Valley Railway page (or the Calder-Voss page) has a Contradictions section noting 1874 (source 01) versus 1879 (source 02), both cited. If the agent only recorded it after being prompted by this scenario, note that.
- [ ] Other pages (Tallow Bridge, Calder-Voss Mining Company, Astrid Pell if present) were updated or linked where the new source adds information, and the index lists the new source.
- [ ] The log has an ingest entry for the new source that mentions the contradiction.
- [ ] No facts outside the documents appear (e.g. no invented cause of death).
