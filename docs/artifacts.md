# Artifacts: interactive output in a chat

An agent that produces something the user should look at puts it **in the conversation**, not in a
sentence about it. It writes the file, then writes a line of its own:

```
![[f_1a2b3c4d5e6f]]                  the file, rendered
![[f_1a2b3c4d5e6f|Q3 by region]]     …with a caption
```

The client renders that file inline, live, in a card with its name, size and engine. The marker has
to be on a line by itself; anything else is ordinary text, and a half-written marker mid-stream stays
text until it is complete.

## What each kind becomes

| Kind | The card |
|---|---|
| csv, tsv, xlsx | a table: column sorting, a filter box, typed columns (numbers right-aligned, dates and text as they are), 200 rows per page, copy the visible rows as TSV, download the file, and a **chart** — bars or a line, any numeric column against any other |
| json | a collapsible tree, a **jq-lite** query box, and the same table and chart when the value is a list of records |
| md | rendered Markdown with a contents list; GFM task checkboxes are clickable and **write back to the file** |
| html | the page itself, running in a sandboxed frame (see below) |
| docx, pptx, pdf | a summary with **View rendered** (the Markdown rendering of the parse) |
| zip, tar, rar, 7z | the entry list as a table |
| images | the picture |

Everything else falls back to the parse summary plus a download link.

## jq-lite

Enough jq to query a JSON artifact without teaching anyone jq's corners:

```
.items[].name                 fan out over an array
.items[0].id  .items[-1]      index, negative from the end
.team["odd key"]              quoted keys
.items | map(.score) | add    pipelines, map
sort_by(.score) | .[0].name   sort_by
keys  values  length  type    the usual
sort  unique  min  max  add   aggregates
flatten  reverse  first  last  tostring  tonumber  join(", ")
```

`map(…)` returns an array, as in jq. A missing key yields nothing rather than `null`, so `.[] | .nope`
is empty instead of a list of nulls. A field access on an array maps over its elements. Errors are
shown in the toolbar ("unknown function `flip()`", "unclosed `[`") rather than silently returning
nothing, and a query that would produce more than 5000 values is refused.

## Markdown that writes back

Ticking a task in a Markdown artifact is a real edit: the client rewrites the file through
`PUT /api/w/:ws/files/:id/content`, which keeps the id, name and shares, drops the old parse cache and
re-parses on the next read. Binary files refuse the write. Only editors and owners can tick.

## HTML runs, but cannot leave

A `.html` artifact is a page, even though the parser reads it as a document — the card keeps the raw
bytes for the frame and the parsed blocks for everything else.

The frame is `sandbox="allow-scripts allow-forms allow-modals"` with **no** `allow-same-origin`, so it
has an opaque origin: no cookies, no storage, no access to the app. A CSP injected at the top of the
document blocks the network (`default-src 'none'`, `connect-src 'none'`, `form-action 'none'`) while
allowing inline styles, scripts and data-URI images, so the page can be interactive but cannot phone
home. The frame reports its height back so the card fits it, and links inside it open in a new tab
instead of navigating the app away. **Source** shows the bytes; **↻ Run** reloads the frame.

## Where the agent learns this

`FILES_GUIDE` (in `packages/server/src/files/tools.ts`) is part of the agent's system prompt and
describes the marker, the caption form and what each kind renders. `file_write` returns the id to use;
`file_parse` and `file_list` show ids of files that already exist. The offline demo model answers a
prompt containing a file id with a marker, so the feature is usable and testable without a key.

## Limits

- The marker is line-based and takes one file per line; embeds don't nest (a Markdown artifact renders
  its own task lines but not other artifacts).
- Charts need a numeric column; rows without a number are skipped, and a series longer than 200 points
  is sampled evenly.
- The jq subset above is the whole language: no `select`, `group_by`, `reduce`, `if/then`, or object
  construction.
- A document's **View rendered** fetches the Markdown rendering; editing is limited to Markdown files.
- The card fetches what it shows and caches it (memory + Cache API, 10 minutes); ↻ re-parses.
