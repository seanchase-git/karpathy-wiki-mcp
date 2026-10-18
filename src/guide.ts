/**
 * The manual returned by wiki_get_info and written to each sandbox as SCHEMA.md. Written for
 * 26–31B local models: short sentences, numbered recipes, one complete worked example, and
 * explicit "done when" criteria. Keep tool names and argument names in sync with server.ts.
 */
export const GUIDE = `# How this wiki works (read this first)

## 1. The idea in five lines
You are building a **persistent wiki** from source documents. It is not search done at question time.
When a source arrives, you read it once and work what it says into wiki pages: a summary page for the source, plus pages for the people, places, things and ideas it mentions. You link those pages to each other.
The wiki grows with each source. Later questions are answered from the wiki, and good answers are saved back into it.
**You are the maintainer.** The user supplies sources and asks questions. You do the summarizing, the cross-linking and the bookkeeping.
Every fact in the wiki must come from a source. Never invent facts.

## 2. The three layers
- \`raw/\`: the source documents. **Read-only.** You may add a new source with wiki_add_source, but you can never edit one.
- \`wiki/\`: your pages. You create, edit and delete them.
- \`SCHEMA.md\`: this guide, the rules. \`index.md\` is a catalog of every page, rebuilt by the server automatically. \`log.md\` is the history of what happened.

## 3. Your sandbox
Every tool except wiki_get_info and wiki_start needs \`sandbox_id\`.
1. **If the user gave you a sandbox_id** (in the system prompt or the chat), use it and call **wiki_status** first. Do NOT call wiki_start.
2. **If the user asked for a new wiki**, call **wiki_start** with your model id as the user or system prompt gave it. If nobody told you your model id, ask the user. Never guess it or copy an example.
3. **If neither is clear, ask the user before calling any tool:** "Do you have a sandbox_id for an existing wiki, or should I start a new one?" Wait for the answer. Never guess or invent an id.

Once you have a sandbox_id, pass it on every call for the rest of the conversation.

## 4. Page rules
- **Page types** (\`type\`):
  - \`source\`: the summary of ONE raw source;
  - \`entity\`: a person, place, organization, object or event;
  - \`concept\`: an idea, technique or term;
  - \`comparison\`: X compared with Y;
  - \`synthesis\`: an answer or analysis built from several pages;
  - \`overview\`: the top-level map of the topic.
- **One subject per page.** The title is the subject's name, e.g. "Analytical Engine", not "Notes about the engine".
- **summary**: one sentence saying what the page is about. It appears in index.md.
- **Links**:
  - link a wiki page with \`[[Exact Page Title]]\`;
  - link a raw source with \`[[raw/Source Name]]\`;
  - link every entity or concept you mention that has, or should have, its own page;
  - a link to a page that doesn't exist yet is a TODO: create the page, or remove the link.
- **sources**: a list of the raw sources a page's facts come from, e.g. \`sources: ["raw/Example Article"]\`. Every source, entity and concept page needs at least one.
- **Body**: use \`## Section\` headings. Don't repeat the title as \`# Title\`, and don't write frontmatter: the server writes it from your arguments.
- **Contradictions**: when two sources disagree, keep both claims. Add or extend a \`## Contradictions\` section on the affected page, with a line like:
  \`- Year built: 1837 per [[raw/Source A]], 1842 per [[raw/Source B]].\`
  Do not silently choose one.
- **Keep each write small**: one page per call. If a page gets long, grow it with \`mode="append"\` instead of sending one huge block.

## 5. INGEST: add one source to the wiki
Do one source at a time and finish it before starting the next.
1. \`wiki_status\` shows which raw sources are not ingested yet.
2. \`wiki_read name="raw/<source>"\`. If the reply says "continue with offset=N", call it again with that offset until you have read the whole source.
3. For each important entity and concept in the source, call \`wiki_search\` with its name, to see whether a page already exists.
4. Create the source page with \`wiki_create_page type="source"\`: the source's key points, plus links to the entity and concept pages.
5. For each important entity or concept:
   - if a page exists, use \`wiki_edit_page\` (\`append\` new facts, or \`replace_section\`) and add this source to \`sources\`;
   - if not, \`wiki_create_page\`.

   Create only pages the source really supports. There is no page quota.
6. If the source contradicts an existing page, record it in that page's \`## Contradictions\` section.
7. Every create or edit reply lists **missing links**. Create those pages, or remove the links.
8. \`wiki_log operation="ingest"\`: one line on what the source was, and the pages you created and updated.

**An ingest is done when** the source page exists and cites the raw source, each important entity or concept has a page that links back, no missing links are left from this ingest, and the log entry is written.

## 6. QUERY: answer a question from the wiki
1. \`wiki_read name="index"\` shows which pages exist.
2. \`wiki_search query="<key words>"\`, then \`wiki_read\` the best pages. Read raw sources only if the wiki is missing detail.
3. Answer using only what you read, with citations such as "([[Analytical Engine]])".
4. If the wiki does not contain the answer, say so plainly. Do not guess and do not use outside knowledge.
5. If the answer is worth keeping, for example because it combines several pages, save it with \`wiki_create_page type="synthesis"\` (or \`comparison\`), linking the pages it is built on. Then call \`wiki_log operation="query"\`.

## 7. LINT: health-check the wiki
1. \`wiki_lint\`. Fix issues from the top: broken links, then frontmatter, uningested sources, missing sources, duplicates, orphans, stubs.
2. **Semantic pass.** Lint only checks structure. Reread the pages changed recently (see \`wiki_read name="log"\`) and look for:
   - claims that contradict each other with no \`## Contradictions\` entry;
   - facts that no source supports;
   - pages that should link to each other but don't.
3. \`wiki_log operation="lint"\`: what you found and what you fixed.

## 8. Worked example: ingesting one source
This example uses a made-up source called "raw/Example Article". Follow the pattern, but use the real source names and facts from YOUR sandbox; never copy these example facts into the wiki.

\`\`\`
wiki_status    sandbox_id="20261018-143005-my-model"
wiki_read      sandbox_id="20261018-143005-my-model" name="raw/Example Article"
wiki_search    sandbox_id="20261018-143005-my-model" query="Ada Lovelace"
               → no results, so a new page is needed
wiki_create_page sandbox_id="20261018-143005-my-model" title="Example Article" type="source"
    summary="Short biography of Ada Lovelace and her notes on the Analytical Engine."
    sources=["raw/Example Article"]
    content="## Key points\\n- [[Ada Lovelace]] wrote notes on [[Charles Babbage]]'s [[Analytical Engine]] in 1843.\\n- The notes include the first published algorithm.\\n\\n## Entities\\n[[Ada Lovelace]], [[Charles Babbage]], [[Analytical Engine]]"
    → reply lists missing links: Ada Lovelace, Charles Babbage, Analytical Engine
wiki_create_page sandbox_id="20261018-143005-my-model" title="Ada Lovelace" type="entity"
    summary="English mathematician known for her notes on the Analytical Engine."
    sources=["raw/Example Article"]
    content="## Overview\\nAda Lovelace wrote notes on the [[Analytical Engine]] designed by [[Charles Babbage]] (1843).\\n\\n## Mentioned in\\n- [[Example Article]]"
... create "Charles Babbage" and "Analytical Engine" the same way ...
wiki_edit_page sandbox_id="20261018-143005-my-model" title="Analytical Engine" mode="append"
    content="## Later sources\\n- ..." sources=["raw/Another Article"]
    → when a later source adds facts to a page that already exists
wiki_log sandbox_id="20261018-143005-my-model" operation="ingest" title="Example Article"
    details="Created: Example Article, Ada Lovelace, Charles Babbage, Analytical Engine."
\`\`\`
\\n inside content means a new line.

## 9. Common mistakes (avoid these)
- Editing or rewriting a raw source. Sources are read-only.
- Creating a page without searching first, which produces duplicates such as "Engine" next to "Analytical Engine".
- One giant page about everything. Split it into one page per subject.
- Links that point to nothing, or pages that nothing links to.
- Forgetting the \`sources\` field, or forgetting the log entry.
- Facts that are not in any source, including "common knowledge".
- Re-reading the same page many times. Read it once, then write.

## 10. Tool cheat sheet
- **wiki_get_info**: this guide.
- **wiki_start** \`model\` (your model id): creates your sandbox and returns its sandbox_id.
- **wiki_status**: where things stand. Shows sources still to ingest, page counts, recent log entries and lint counts.
- **wiki_list** \`folder\`: \`"wiki"\` or \`"raw"\`. Lists names and summaries.
- **wiki_read** \`name\`: a page title, \`raw/<source>\`, \`index\`, \`log\` or \`SCHEMA\`. Add \`offset\` to continue a long file.
- **wiki_search** \`query\`, \`scope\` (\`"wiki"\` by default, or \`"raw"\` or \`"all"\`): ranked matches with line numbers.
- **wiki_create_page** \`title\` \`type\` \`summary\` \`content\` \`sources\` \`tags\`: a new page. Fails if the page exists.
- **wiki_edit_page** \`title\` \`mode\` \`content\`:
  - \`mode\` is \`"append"\`, \`"replace_section"\` (also give \`section\`, the heading text) or \`"replace_all"\`;
  - optional \`summary\` and \`type\` replace the old values;
  - optional \`sources\` and \`tags\` are added to the existing lists (with \`mode="replace_all"\`, \`sources\` replaces the list);
  - optional \`remove_sources\` removes entries from the sources list.
- **wiki_delete_page** \`title\` \`reason\`: deletes a page and reports which pages now have broken links.
- **wiki_add_source** \`title\` \`content\`: saves text the user pasted as a new raw source.
- **wiki_lint**: structural problems, each with a fix.
- **wiki_log** \`operation\` \`title\` \`details\`: \`operation\` is \`"ingest"\`, \`"query"\`, \`"lint"\` or \`"note"\`. Records what you did.
`;

export const SCHEMA_MD = `${GUIDE}
---
*Note for the human evaluator: index.md is rebuilt by the server, so index upkeep is assisted. "Ingested" means a source page cites the raw file. That is a proxy, not proof that the agent read or integrated it.*
`;
