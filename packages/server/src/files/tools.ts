import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";
import { modules as moduleDb } from "../kernel/system-db.ts";
import type { Workspace } from "../kernel/workspace.ts";
import type { FileMeta } from "../kernel/docs.ts";
import { formatBytes, hexdump, inflate, looksLikeText, zipEntries, zipRead, type InflateFormat } from "../files/store.ts";

const text = (value: unknown) => ({ output: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] });
const summary = (f: FileMeta) => ({ id: f.id, name: f.name, kind: f.kind, mime: f.mime, size: formatBytes(f.size), bytes: f.size, from: `${f.source} by ${f.createdBy}`, ...(f.parent ? { parent: f.parent } : {}), ...(f.modules.length ? { modules: f.modules } : {}) });

const MAX_TEXT = 60_000;
const MAX_HEX = 4096;
const MAX_B64 = 48_000;

export const FILES_GUIDE = `# Files
Workspace files (uploads, your outputs, module outputs) are listed in the user's Files panel. An attachment arrives as \`[Attached file f_…: "name" — kind, mime, size]\`; images and small text files are inlined, everything else is a handle.

Documents and archives have native parsers — prefer them over byte work:
- \`file_parse\` reads docx, xlsx, pptx, pdf, zip/tar/gz/rar/7z, csv, html, json and markdown as structure (Markdown, or the full JSON model with \`view: "json"\`). It keeps the design too: theme fonts and colours, styles, page setup, shape geometry.
- \`file_convert\` writes Markdown, HTML (self-contained), text, per-sheet CSV or JSON next to the original; \`file_extract\` unpacks archive entries into Files.
- Attachments of those kinds already arrive parsed in the chat, so you rarely need to ask for them again.

You can still make sense of **any other** format with byte-level primitives, so never answer "I can't open this":
- \`file_info\` first: sniffed kind, magic bytes, a text or hex preview, and the entry list for zip containers.
- \`file_read\` (text / hex / base64, by offset and length) and \`file_search\` (text or hex patterns → offsets) for walking structures.
- Containers: docx/xlsx/pptx/odt/epub/jar are zips → \`file_unzip\`, then read the XML parts (e.g. word/document.xml, xl/sharedStrings.xml + xl/worksheets/sheet1.xml).
- Compressed streams (gzip, zlib, PDF FlateDecode between \`stream\` and \`endstream\`) → \`file_inflate\` on the byte range.
- Images → \`file_view\` to look at them.
- Save what you derive (extracted text, CSV, JSON, reports) with \`file_write\` so the user gets it in Files.

## Showing a file in the chat
To put a file in front of the user instead of describing it, write a line of its own:

    ![[f_1a2b3c4d5e6f]]

Add a caption with a pipe — \`![[f_1a2b3c4d5e6f|Q3 revenue]]\`. The client renders the file inline, interactive:

- csv/tsv/xlsx → a table they can sort, filter, copy and chart, with the numbers right-aligned and typed.
- json → a collapsible tree, a jq-lite query box (\`.items[].name\`, \`. | length\`, \`map(.x)\`), and a table when the shape allows it.
- md → rendered prose with a contents list; task checkboxes are clickable and write back to the file.
- html → the document runs in a sandboxed frame (scripts allowed, network blocked, no access to the app).
- docx/pptx/pdf and archives → a summary with a rendered view or the entry list.

Embed the artifacts you produce — a CSV report, a dataset, a JSON extract, a checklist, a small HTML tool — not the whole working set. One card per file per reply is enough; the file stays in Files either way.

**Build your own tooling.** When a format needs real parsing, repeated access or an interactive view (spreadsheets, logs, datasets, binary records), write a module whose server parses the file with \`ctx.files\`, share the file with it (\`file_share_with_module\`), and then use \`module_call\` as your tool. Its client can visualize the data for the user. Improve the module as you learn the format. Inside a module server: \`ctx.files.list()\`, \`ctx.files.info(id)\`, \`ctx.files.text(id, offset?, length?)\`, \`ctx.files.bytes(id, offset?, length?)\` → Uint8Array (≤16 MB per read), \`await ctx.files.write(name, stringOrUint8Array, mime?)\` → {id}. A module sees only files shared with it, plus files it wrote.`;

export function createFileTools(ws: Workspace) {
	const get = (ref: string) => ws.files.get(ref);
	return [
		defineTool({
			name: "file_list",
			description: "List workspace files (uploads, agent and module outputs, extracted parts).",
			parameters: Type.Object({ query: Type.Optional(Type.String({ description: "substring filter on name or kind" })) }),
			execute: async (args) => {
				const q = args.query?.toLowerCase();
				const list = (await ws.files.list()).filter((f) => !q || f.name.toLowerCase().includes(q) || f.kind.toLowerCase().includes(q));
				return text(list.slice(0, 200).map(summary));
			},
		}),
		defineTool({
			name: "file_info",
			description: "Identify a file: metadata, sniffed kind, magic bytes, a preview (text or hex), and zip entries for containers. Start here for any file.",
			parameters: Type.Object({ file: Type.String({ description: "file id or name" }) }),
			execute: async (args) => {
				const f = await get(args.file);
				const head = ws.files.bytes(f, 0, 4096);
				const info: Record<string, unknown> = { ...summary(f), magic: head.subarray(0, 16).toString("hex") };
				if (looksLikeText(head)) {
					const sample = ws.files.bytes(f, 0, 3000).toString("utf8");
					info.preview = sample;
					info.lines = f.size <= 2_000_000 ? ws.files.all(f).toString("utf8").split("\n").length : "large — read by ranges";
				} else info.hexPreview = hexdump(head.subarray(0, 256));
				if (/zip|docx|xlsx|pptx|odt|ods|odp|epub|jar|apk|whl|vsix|ipa/.test(f.kind) && f.size <= 512 << 20) {
					try {
						const entries = zipEntries(ws.files.all(f));
						info.zipEntries = entries.slice(0, 300).map((e) => `${e.name} (${formatBytes(e.size)})`);
						if (entries.length > 300) info.zipEntriesTruncated = entries.length;
					} catch (error) {
						info.zipError = (error as Error).message;
					}
				}
				if (f.kind === "pdf") info.hint = "PDF: text usually lives in FlateDecode streams. file_search for 'stream' / 'endstream', then file_inflate the bytes between them (skip the CRLF after 'stream').";
				return text(info);
			},
		}),
		defineTool({
			name: "file_read",
			description: `Read a byte range of a file as text (utf8, ≤${MAX_TEXT} chars), hex dump (≤${MAX_HEX} bytes) or base64 (≤${MAX_B64} bytes). Default: text for text files, hex otherwise.`,
			parameters: Type.Object({
				file: Type.String(),
				offset: Type.Optional(Type.Number()),
				length: Type.Optional(Type.Number()),
				as: Type.Optional(Type.Union([Type.Literal("text"), Type.Literal("hex"), Type.Literal("base64")])),
			}),
			execute: async (args) => {
				const f = await get(args.file);
				const offset = Math.max(0, args.offset ?? 0);
				const mode = args.as ?? (looksLikeText(ws.files.bytes(f, 0, 4096)) ? "text" : "hex");
				const cap = mode === "text" ? MAX_TEXT : mode === "hex" ? MAX_HEX : MAX_B64;
				const length = Math.min(args.length ?? cap, cap);
				const buf = ws.files.bytes(f, offset, length);
				const end = offset + buf.length;
				const more = end < f.size ? `\n…[bytes ${offset}-${end} of ${f.size}; continue with offset ${end}]` : `\n[bytes ${offset}-${end} of ${f.size}, end of file]`;
				const body = mode === "text" ? buf.toString("utf8") : mode === "hex" ? hexdump(buf, offset) : buf.toString("base64");
				return text(body + more);
			},
		}),
		defineTool({
			name: "file_search",
			description: "Find byte offsets of a text or hex pattern in a file (with a little context). Use to locate structures in binary formats.",
			parameters: Type.Object({
				file: Type.String(),
				text: Type.Optional(Type.String()),
				hex: Type.Optional(Type.String({ description: "e.g. 504b0304" })),
				from: Type.Optional(Type.Number()),
				max: Type.Optional(Type.Number()),
			}),
			execute: async (args) => {
				const f = await get(args.file);
				const pattern = args.hex ? Buffer.from(args.hex.replace(/\s+/g, ""), "hex") : Buffer.from(args.text ?? "", "utf8");
				if (!pattern.length) throw new Error("Give text or hex");
				const hits = ws.files.search(f, pattern, args.from ?? 0, Math.min(args.max ?? 50, 500));
				return text({
					count: hits.length,
					hits: hits.slice(0, 50).map((o) => ({ offset: o, context: JSON.stringify(ws.files.bytes(f, Math.max(0, o - 16), pattern.length + 48).toString("latin1")) })),
				});
			},
		}),
		defineTool({
			name: "file_parse",
			description:
				"Read a document properly instead of byte by byte: docx, xlsx, pptx, pdf, zip/tar/gz/rar/7z, csv, html, json, markdown. Returns a structural summary plus Markdown, or the full structure with view=json (including the design model: theme, fonts, colours, page setup, shape geometry).",
			parameters: Type.Object({
				file: Type.String({ description: "file id or name" }),
				view: Type.Optional(Type.Union([Type.Literal("markdown"), Type.Literal("json"), Type.Literal("summary")], { description: "markdown (default), json = full structure, summary = one line" })),
				limit: Type.Optional(Type.Number({ description: "max characters of Markdown, default 40000" })),
			}),
			execute: async (args) => {
				const f = await get(args.file);
				const parsed = await ws.parsed(f);
				const { summaryOf } = await import("./parse/model.ts");
				const { markdownFor, publicParsed } = await import("./parse/index.ts");
				const summary = summaryOf(parsed);
				if (parsed.kind === "opaque") return text({ file: f.id, kind: parsed.kind, reason: parsed.reason, hint: "Use file_info/file_read, or build a module for this format." });
				if (args.view === "summary") return text({ file: f.id, summary, notes: parsed.notes ?? [] });
				if (args.view === "json") return text({ file: f.id, summary, notes: parsed.notes ?? [], parsed: publicParsed(parsed) });
				const markdown = markdownFor(parsed);
				const limit = Math.min(Math.max(args.limit ?? 40_000, 500), 200_000);
				return text(`${summary}${parsed.notes?.length ? `
Notes: ${parsed.notes.join("; ")}` : ""}

${markdown.length > limit ? `${markdown.slice(0, limit)}
…[${markdown.length - limit} more characters; raise limit or use view=json]` : markdown}`);
			},
		}),
		defineTool({
			name: "file_convert",
			description: "Convert a file to a derived workspace file: markdown, html (self-contained with images), text, csv (one per sheet) or json (the full structure). The result appears in Files.",
			parameters: Type.Object({
				file: Type.String(),
				to: Type.Union([Type.Literal("markdown"), Type.Literal("html"), Type.Literal("text"), Type.Literal("csv"), Type.Literal("json")]),
			}),
			replay: "safe",
			execute: async (args, api, context) => {
				const done = await api.memo<any[]>("converted", context);
				if (done) return text(done);
				const f = await get(args.file);
				const created = await ws.convertFile(f, args.to, "Agent");
				if (!created.length) throw new Error(`Nothing to convert for ${f.kind} → ${args.to}`);
				const out = created.map(summary);
				await api.memo("converted", out as any, context);
				return text(out);
			},
		}),
		defineTool({
			name: "file_extract",
			description: "Extract the entries of an archive (zip, tar, gz, rar, 7z) into workspace files, keeping their paths.",
			parameters: Type.Object({
				file: Type.String(),
				match: Type.Optional(Type.String({ description: "regex on entry paths" })),
				max: Type.Optional(Type.Number({ description: "max entries, default 200" })),
			}),
			replay: "safe",
			execute: async (args, api, context) => {
				const done = await api.memo<any[]>("extracted", context);
				if (done) return text(done);
				const f = await get(args.file);
				const parsed = await ws.parsed(f);
				if (parsed.kind !== "archive") throw new Error(`${f.name} is not an archive (${parsed.kind})`);
				const { extractArchive } = await import("./parse/archive.ts");
				const entries = await extractArchive(parsed.archive, ws.files.all(f), args.match ? new RegExp(args.match) : undefined);
				const out: unknown[] = [];
				for (const entry of entries.slice(0, Math.min(args.max ?? 200, 1000))) {
					if (entry.bytes.length > 48 << 20) {
						out.push({ entry: entry.path, error: "larger than 48 MB" });
						continue;
					}
					const meta = await ws.files.put(entry.bytes, { name: `${f.name}/${entry.path}`, createdBy: "Agent", source: "extract", parent: f.id });
					out.push({ id: meta.id, entry: entry.path, kind: meta.kind, size: formatBytes(meta.size) });
				}
				await api.memo("extracted", out as any, context);
				return text(out);
			},
		}),
		defineTool({
			name: "file_view",
			description: "Look at an image file (png, jpeg, gif, webp, bmp). Large images are resized to fit.",
			parameters: Type.Object({ file: Type.String() }),
			execute: async (args) => {
				const f = await get(args.file);
				const image = await ws.files.image(f);
				if (!image) throw new Error(`${f.name} (${f.kind}) is not a viewable image`);
				return { output: [{ type: "text" as const, text: `${f.name}${image.note ? ` (${image.note})` : ""}` }, { type: "image" as const, data: image.data, mimeType: image.mimeType }] };
			},
		}),
		defineTool({
			name: "file_write",
			description: "Create a workspace file (e.g. extracted text, a CSV, a report). It shows up in the user's Files panel.",
			parameters: Type.Object({
				name: Type.String(),
				content: Type.String(),
				encoding: Type.Optional(Type.Union([Type.Literal("utf8"), Type.Literal("base64")])),
				mime: Type.Optional(Type.String()),
				parent: Type.Optional(Type.String({ description: "id of the file this was derived from" })),
			}),
			replay: "safe",
			execute: async (args, api, context) => {
				const existing = await api.memo<FileMeta>("file", context);
				if (existing) return text(summary(existing));
				const meta = await ws.files.put(Buffer.from(args.content, args.encoding === "base64" ? "base64" : "utf8"), {
					name: args.name,
					mime: args.mime,
					createdBy: "Agent",
					source: "agent",
					parent: args.parent ? (await get(args.parent)).id : undefined,
				});
				await api.memo("file", meta, context);
				return text(summary(meta));
			},
		}),
		defineTool({
			name: "file_unzip",
			description: "Extract entries of a zip-based file (zip, docx, xlsx, pptx, odt, epub, jar…) as new workspace files named '<archive>/<entry>'.",
			parameters: Type.Object({
				file: Type.String(),
				match: Type.Optional(Type.String({ description: "regex on entry paths; default: all" })),
				max: Type.Optional(Type.Number({ description: "max entries, default 200" })),
			}),
			replay: "safe",
			execute: async (args, api, context) => {
				const done = await api.memo<any>("extracted", context);
				if (done) return text(done);
				const f = await get(args.file);
				const data = ws.files.all(f);
				const re = args.match ? new RegExp(args.match) : undefined;
				const entries = zipEntries(data).filter((e) => !e.name.endsWith("/") && (!re || re.test(e.name)));
				const max = Math.min(args.max ?? 200, 1000);
				const out: unknown[] = [];
				let total = 0;
				for (const e of entries.slice(0, max)) {
					try {
						const bytes = zipRead(data, e);
						total += bytes.length;
						if (total > 512 << 20) break;
						const meta = await ws.files.put(bytes, { name: `${f.name}/${e.name}`, createdBy: "Agent", source: "extract", parent: f.id });
						out.push({ id: meta.id, entry: e.name, kind: meta.kind, size: formatBytes(meta.size) });
					} catch (error) {
						out.push({ entry: e.name, error: (error as Error).message });
					}
				}
				if (entries.length > max) out.push({ note: `${entries.length - max} more entries not extracted; narrow with match or raise max` });
				await api.memo("extracted", out as any, context);
				return text(out);
			},
		}),
		defineTool({
			name: "file_inflate",
			description: "Decompress a file or a byte range of it (gzip, zlib, raw deflate; 'auto' tries all). Returns a preview, or saves the result as a new file when save_as is given.",
			parameters: Type.Object({
				file: Type.String(),
				offset: Type.Optional(Type.Number()),
				length: Type.Optional(Type.Number()),
				format: Type.Optional(Type.Union([Type.Literal("auto"), Type.Literal("zlib"), Type.Literal("deflate-raw"), Type.Literal("gzip")])),
				save_as: Type.Optional(Type.String()),
			}),
			execute: async (args) => {
				const f = await get(args.file);
				const offset = args.offset ?? 0;
				const { out, format } = inflate(ws.files.bytes(f, offset, args.length ?? f.size - offset), (args.format ?? "auto") as InflateFormat);
				if (args.save_as) {
					const meta = await ws.files.put(out, { name: args.save_as, createdBy: "Agent", source: "extract", parent: f.id });
					return text({ format, saved: summary(meta) });
				}
				const preview = looksLikeText(out) ? out.subarray(0, 20_000).toString("utf8") : hexdump(out.subarray(0, 512));
				return text(`format=${format}, ${out.length} bytes${out.length > 20_000 ? " (preview truncated; use save_as to keep it all)" : ""}\n${preview}`);
			},
		}),
		defineTool({
			name: "file_share_with_module",
			description: "Let a module's server read a file through ctx.files (files are capabilities, like grants).",
			parameters: Type.Object({ file: Type.String(), module: Type.String({ description: "module id or name" }) }),
			execute: async (args, api) => {
				const f = await get(args.file);
				const g = moduleDb.get(args.module) ?? moduleDb.inWorkspace(ws.id).find((x) => x.name.toLowerCase() === args.module.toLowerCase());
				if (!g || g.workspaceId !== ws.id) throw new Error(`Unknown module ${args.module}`);
				if (!f.modules.includes(g.id)) await ws.files.update(f.id, (m) => void m.modules.push(g.id));
				await ws.linkModuleChat(String(api.conversationId), g.id);
				return text({ ok: true, file: f.id, module: g.id, note: `In the module server: ctx.files.bytes("${f.id}") / ctx.files.text("${f.id}")` });
			},
		}),
	];
}
