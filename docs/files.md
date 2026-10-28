# Files

Uploads are content-addressed and parsed natively; the parsed model and the design model both survive.

Attach files to a message with 📎, drag-and-drop, or paste (Ctrl+V a screenshot), or drop them on the **Files** page. Any format is accepted, up to `files.maxUploadMB` (default 100). Bytes are stored content-addressed in `<dataDir>/workspaces/<id>.files/`. The index lives in the durable `outpost.files` document.

- **What the model sees:** images are sent inline (resized with Photon when large), small text files are inlined verbatim, and documents are **ingested**: a docx, xlsx, pptx, pdf, csv or archive attached to a message arrives as its parsed content (a structural summary plus bounded Markdown), not as a handle. Unknown formats fall back to a handle.
- **Ingestion, natively:** docx through [mammoth](https://github.com/mwilliamson/mammoth.js) with an OOXML fallback, xlsx through [ExcelJS](https://github.com/exceljs/exceljs) with an OOXML fallback, pdf through the vendored [pdf.js](https://mozilla.github.io/pdf.js/), PPTX through a purpose-built OOXML reader (no library preserves shapes and charts), and archives through `yauzl` (zip, zip64), `tar-stream`, `node:zlib`, plus vendored WASM builds of unrar (RAR4/5) and 7-Zip (7z, including LZMA2). Each library is imported **on first use** — nothing heavy loads at boot.
- **Nothing is thrown away:** the parse keeps a block model (headings, lists with levels, tables with spans, images, notes) *and* a design model — theme fonts and colours, the style catalogue, page setup, per-shape geometry, fills and run formatting — for output generation later. Conversions produce Markdown, self-contained HTML, plain text, per-sheet CSV, or the full JSON structure; archives extract with their paths.
- **In the browser:** the Files preview has **Content / Structure / Design** tabs. Each tab fetches only what it shows and caches it (memory + Cache API), so reopening a file does not re-download it.
- **Also scriptable:** `file_parse` (structure, Markdown or JSON), `file_convert`, `file_extract`, plus byte-level primitives for anything unsupported: `file_info`, `file_read` (text/hex/base64 ranges), `file_search`, `file_unzip`, `file_inflate`, `file_view` and `file_write`.
- **Tooling it builds itself:** when a format needs real parsing or an interactive view, the agent writes a module whose server parses the file and then uses the module's API as its tool. Module servers use `ctx.files.list/info/text/bytes/write`. Files are capabilities: a module reads only files shared with it (`file_share_with_module`, or the checkboxes in the Files preview) and files it wrote itself.
- **Safe serving:** downloads are always sent with `sandbox` CSP and `nosniff`. Only images, plain text and PDF render inline; HTML and SVG are always downloaded.


## Derived files

Anything Outpost makes *from* a file you already have is a file in its own right, recorded with a
`parent` (the file it came from) and the source `extract`:

- **Conversions** — Markdown, self-contained HTML, plain text, per-sheet CSV or the full JSON
  structure written next to the original (`file_convert`, or the buttons in the Files preview).
- **Archive entries** — every extracted path, named `<archive>/<path>` (`file_extract`, `file_unzip`).
- **Decompressed payloads** — `file_inflate` output, e.g. a PDF's FlateDecode stream or a `.gz`.
- **Anything the agent writes from a file it read**, by passing `parent` to `file_write`.

The Files page groups them under their source: the parent row carries **▸ N derived files**, collapsed
by default and sorted by name, and each one gets a full row of its own — open it, download it, ask the
agent about it, share it with a module, delete it. Rows show only the part of the name after the first
`/`, so a deep archive path stays readable; the full name is in the tooltip and the download.

They are ordinary files, not children in a lifecycle sense:

- **Deleting the parent leaves them.** The confirm dialog says so ("Its 2 derived files stay"), and
  their `parent` link is cleared so they list at the top level instead of hanging under nothing. Bytes
  are content-addressed, so a file still used elsewhere isn't removed either.
- **Deleting one leaves its parent and siblings.** A conversion can be redone; a hand-edited output is
  gone like any other file.
- **Sharing is per file.** A derived file starts unshared; give it to a module, or attach it to a
  chat, on its own.
- **Derivation nests.** Convert a converted file, or extract an archive found inside another, and the
  chain keeps going; expand each level to see the next.
- **Filtering promotes them.** When a search hides the parent, its derived files are listed at the top
  level rather than disappearing with it.

The agent sees the link too: file summaries from `file_list` and `file_parse` include `parent`, which
is how it knows a converted CSV belongs to the sheet it read.
