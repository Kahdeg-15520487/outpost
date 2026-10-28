/**
 * One entry point for ingestion. Each format's library is imported on first use (nothing is
 * loaded at boot), results are cached in memory and on disk by content hash, and every parser
 * failure degrades to a readable explanation instead of an error page.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FileMeta } from "../../kernel/docs.ts";
import { looksLikeText } from "../store.ts";
import { decodeDataUri, htmlToBlocks } from "./html.ts";
import {
	htmlOf,
	imageList,
	markdownOf,
	sheetToCsv,
	summaryOf,
	textOf,
	type Parsed,
	type ParsedImage,
	type ParsedOpaque,
	type RenderOptions,
} from "./model.ts";

/** Bump when a parser changes shape, so caches from older builds are ignored. */
export const PARSE_VERSION = 2;

const MEMORY_MAX = 20;
const memory = new Map<string, Parsed>();

const parseCacheDir = (filesDir: string) => join(filesDir, "parsed");

function cachePaths(filesDir: string, sha: string) {
	const dir = join(parseCacheDir(filesDir), sha.slice(0, 2));
	return { json: join(dir, `${sha}.json`), images: join(dir, sha) };
}

function readDiskCache(filesDir: string, sha: string): Parsed | undefined {
	const paths = cachePaths(filesDir, sha);
	if (!existsSync(paths.json)) return undefined;
	try {
		const stored = JSON.parse(readFileSync(paths.json, "utf8")) as { version: number; parsed: Parsed; images: (Omit<ParsedImage, "bytes"> & { file: string })[] };
		if (stored.version !== PARSE_VERSION) return undefined;
		const images = stored.images.map((img) => {
			const file = join(paths.images, img.file);
			return { ...img, bytes: existsSync(file) ? readFileSync(file) : Buffer.alloc(0) } as ParsedImage;
		});
		const parsed = { ...stored.parsed, ...("images" in stored.parsed ? { images } : {}) } as Parsed;
		return parsed;
	} catch {
		return undefined;
	}
}

function writeDiskCache(filesDir: string, sha: string, parsed: Parsed): void {
	const paths = cachePaths(filesDir, sha);
	try {
		const images = imageList(parsed);
		if (images.length) mkdirSync(paths.images, { recursive: true });
		const trimmed = images.map((img, i) => {
			const file = `${i}-${img.name.replace(/[^\w.-]+/g, "_").slice(0, 40) || "image"}`;
			writeFileSync(join(paths.images, file), img.bytes);
			const { bytes, ...rest } = img;
			void bytes;
			return { ...rest, file };
		});
		mkdirSync(join(parseCacheDir(filesDir), sha.slice(0, 2)), { recursive: true });
		writeFileSync(paths.json, JSON.stringify({ version: PARSE_VERSION, parsed, images: trimmed }));
	} catch {
		// a cache miss next time is fine
	}
}

function remember(sha: string, parsed: Parsed) {
	memory.delete(sha);
	memory.set(sha, parsed);
	while (memory.size > MEMORY_MAX) {
		const oldest = memory.keys().next().value;
		if (oldest) memory.delete(oldest);
	}
}

export function clearParseCache(filesDir: string, sha?: string): void {
	if (sha) {
		memory.delete(sha);
		const paths = cachePaths(filesDir, sha);
		rmSync(paths.json, { force: true });
		rmSync(paths.images, { recursive: true, force: true });
		return;
	}
	memory.clear();
	const dir = parseCacheDir(filesDir);
	try {
		for (const sub of readdirSync(dir)) rmSync(join(dir, sub), { recursive: true, force: true });
	} catch {
		/* nothing cached */
	}
}

const ARCHIVE_KINDS: Record<string, "zip" | "rar" | "7z" | "tar" | "gz"> = { zip: "zip", rar: "rar", "7z": "7z", tar: "tar", gzip: "gz", gz: "gz" };

const TEXTUAL = /^(text|json|xml|html|svg|csv|tsv|markdown|yaml)/;

export async function parseFile(meta: FileMeta, bytes: Buffer, opts: { filesDir?: string; refresh?: boolean } = {}): Promise<Parsed> {
	const sha = meta.sha256;
	if (!opts.refresh) {
		const hit = memory.get(sha);
		if (hit) return hit;
		if (opts.filesDir) {
			const disk = readDiskCache(opts.filesDir, sha);
			if (disk) {
				remember(sha, disk);
				return disk;
			}
		}
	}
	let parsed: Parsed;
	try {
		parsed = await dispatch(meta, bytes);
	} catch (error) {
		parsed = opaque(meta, (error as Error).message);
	}
	remember(sha, parsed);
	if (opts.filesDir) writeDiskCache(opts.filesDir, sha, parsed);
	return parsed;
}

function opaque(meta: FileMeta, reason: string): ParsedOpaque {
	return { kind: "opaque", format: meta.kind, name: meta.name, size: meta.size, reason };
}

async function dispatch(meta: FileMeta, bytes: Buffer): Promise<Parsed> {
	const kind = meta.kind.toLowerCase();
	const ext = /\.([a-z0-9]+)$/i.exec(meta.name)?.[1]?.toLowerCase() ?? "";
	const base = { name: meta.name, size: meta.size };

	// A real package starts with a zip local-file header. Office parts saved on their own
	// (e.g. a stray [Content_Types].xml renamed to .xlsx) are common enough to explain clearly.
	if (["docx", "xlsx", "pptx"].includes(kind) || ["docx", "xlsx", "pptx"].includes(ext)) {
		if (bytes.subarray(0, 4).toString("hex") !== "504b0304") {
			const head = bytes.subarray(0, 400).toString("utf8").trimStart();
			const looksXml = head.startsWith("<?xml") || head.startsWith("<");
			return opaque(meta, looksXml ? `not a ${kind || ext} package — this is a single XML part, not a zip container` : `not a readable ${kind || ext} package (the file is ${bytes.length} bytes, starting ${bytes.subarray(0, 8).toString("hex")})`);
		}
	}

	// office + pdf
	if (kind === "docx" || ext === "docx") {
		const { parseDocx } = await import("./docx.ts");
		return parseDocx(bytes, meta.name, meta.size);
	}
	if (kind === "xlsx" || ext === "xlsx" || ext === "xlsm") {
		const { parseXlsx } = await import("./xlsx.ts");
		return parseXlsx(bytes, meta.name, meta.size);
	}
	if (kind === "pptx" || ext === "pptx") {
		const { openPackage } = await import("./ooxml.ts");
		const { parsePptx } = await import("./pptx.ts");
		return parsePptx(openPackage(bytes), meta.name, meta.size);
	}
	if (kind === "pdf" || ext === "pdf") {
		const { parsePdf } = await import("./pdf.ts");
		return parsePdf(bytes, meta.name, meta.size);
	}

	// archives
	const archiveFormat = ARCHIVE_KINDS[kind] ?? (["zip", "rar", "7z", "tar", "tgz"].includes(ext) ? (ext === "tgz" ? "gz" : (ext as "zip" | "rar" | "7z" | "tar")) : undefined);
	if (archiveFormat) {
		const archive = await import("./archive.ts");
		// a .tar.gz is a gzip of a tar: describe the tar
		if (archiveFormat === "gz") {
			const { gunzipSync } = await import("node:zlib");
			const inner = gunzipSync(bytes, { maxOutputLength: 256 << 20 });
			if (inner.length > 265 && inner.toString("latin1", 257, 263).startsWith("ustar")) return archive.listArchive("tar", inner, meta.name.replace(/\.(gz|tgz)$/i, ""), meta.size);
			return archive.listArchive("gz", bytes, meta.name, meta.size);
		}
		return archive.listArchive(archiveFormat, bytes, meta.name, meta.size);
	}

	// delimited text
	if (kind === "csv" || kind === "tsv") {
		const { parseDelimited } = await import("./xlsx.ts");
		return parseDelimited(bytes.toString("utf8"), meta.name, meta.size, kind === "tsv" ? "\t" : ",");
	}

	// html: keep the block model so it can become markdown
	if (kind === "html" || ext === "html" || ext === "htm") {
		const { blocks, images } = htmlToBlocks(bytes.toString("utf8"));
		return {
			kind: "document",
			format: "html",
			...base,
			engine: "htmlparser2",
			blocks,
			images,
			headings: blocks.filter((b) => b.type === "heading").map((b) => ({ level: (b as Extract<typeof b, { type: "heading" }>).level, text: "runs" in b ? b.runs.map((r) => r.text).join("") : "" })),
			stats: { paragraphs: blocks.filter((b) => b.type === "paragraph").length, tables: blocks.filter((b) => b.type === "table").length, images: images.length, words: (blocks.map((b) => ("runs" in b ? b.runs.map((r) => r.text).join(" ") : "")).join(" ").match(/\S+/g) ?? []).length },
		};
	}

	if (kind === "json" || ext === "json" || ext === "geojson") {
		try {
			return { kind: "json", format: "json", ...base, value: JSON.parse(bytes.toString("utf8")) };
		} catch (error) {
			return { kind: "text", format: "json", ...base, engine: "raw", text: bytes.toString("utf8"), lines: bytes.toString("utf8").split("\n").length, notes: [`invalid JSON: ${(error as Error).message}`] };
		}
	}

	// everything textual
	if (TEXTUAL.test(kind) || looksLikeText(bytes.subarray(0, 8192))) {
		const text = bytes.toString("utf8");
		if (text.length > 8 << 20) {
			return { kind: "text", format: meta.kind, ...base, engine: "raw", text: text.slice(0, 8 << 20), lines: text.slice(0, 8 << 20).split("\n").length, notes: ["truncated to the first 8 MB"] };
		}
		const language = /\.(md|markdown)$/i.test(meta.name) ? "markdown" : /\.(xml)$/i.test(meta.name) ? "xml" : /\.(ya?ml)$/i.test(meta.name) ? "yaml" : /\.(ts|js|mjs|tsx|py|sh|ps1)$/i.test(meta.name) ? ext : undefined;
		// markdown files are already rendered content: keep them as text with the language set
		return { kind: "text", format: meta.kind, ...base, engine: "raw", text, lines: text.split("\n").length, ...(language ? { language } : {}) };
	}

	// images: describe, do not pretend to parse
	if (/^image\//.test(meta.mime)) {
		return { kind: "opaque", format: meta.kind, ...base, reason: `${meta.kind} image — look at it with file_view, or share it with a module` };
	}

	return { kind: "opaque", format: meta.kind, ...base, reason: `no built-in parser for ${meta.kind}. The file tools can still read it byte by byte.` };
}

// ---------------------------------------------------------------- rendering + conversion

const dataUri = (image: ParsedImage) =>
	image.mime === "text/uri-list" ? image.bytes.toString("utf8") : `data:${image.mime};base64,${image.bytes.toString("base64")}`;

export const renderOptions = (parsed: Parsed): RenderOptions => ({ imgSrc: (image) => imageList(parsed).find((i) => i.ref === image.ref) ? dataUri(imageList(parsed).find((i) => i.ref === image.ref)!) : image.ref });

/** Markdown never inlines image bytes: an image is a ref the agent (or the UI) can fetch. */
export function markdownFor(parsed: Parsed): string {
	return markdownOf(parsed);
}

/**
 * HTML either inlines images (self-contained, for downloaded conversions) or points them at the
 * image endpoint (for the preview, which keeps the payload small).
 */
export function htmlFor(parsed: Parsed, opts: RenderOptions = { inlineImages: true }): string {
	return htmlOf(parsed, { ...(opts.inlineImages === false ? {} : renderOptions(parsed)), ...opts, maxTableRows: 2000 });
}

export function textFor(parsed: Parsed): string {
	return textOf(parsed);
}

export type ConvertTarget = "markdown" | "html" | "text" | "csv" | "json";

export interface Conversion {
	name: string;
	bytes: Buffer;
	mime: string;
}

/** Produce derived files for a parsed document. Pure: the caller stores them. */
export function convert(parsed: Parsed, target: ConvertTarget): Conversion[] {
	const stem = parsed.name.replace(/\.[^.]+$/, "");
	switch (target) {
		case "markdown":
			return [{ name: `${stem}.md`, bytes: Buffer.from(`${markdownFor(parsed)}\n`), mime: "text/markdown" }];
		case "html": {
			const body = htmlFor(parsed);
			const html = `<!doctype html>\n<html lang="en">\n<meta charset="utf-8">\n<title>${escapeText(parsed.name)}</title>\n<style>body{font:16px/1.6 Georgia,serif;max-width:52rem;margin:2.5rem auto;padding:0 1.25rem;color:#1f1b2e}table{border-collapse:collapse;width:100%;margin:1rem 0}td,th{border:1px solid #d8d2c4;padding:6px 8px;text-align:left;vertical-align:top}th{background:#f3efe4}img{max-width:100%;height:auto}h1,h2,h3{line-height:1.25}pre{background:#f3efe4;padding:12px;overflow:auto}</style>\n<body>\n${body}\n</body>\n</html>\n`;
			return [{ name: `${stem}.html`, bytes: Buffer.from(html), mime: "text/html" }];
		}
		case "text":
			return [{ name: `${stem}.txt`, bytes: Buffer.from(`${textFor(parsed)}\n`), mime: "text/plain" }];
		case "csv": {
			if (parsed.kind !== "sheets") return [];
			return parsed.sheets.map((sheet) => ({
				name: parsed.sheets.length > 1 ? `${stem}.${sheet.name.replace(/[^\w.-]+/g, "_")}.csv` : `${stem}.csv`,
				bytes: Buffer.from(sheetToCsv(sheet, { maxTableRows: 1_000_000, maxTableCols: 1000 })),
				mime: "text/csv",
			}));
		}
		case "json":
			return [{ name: `${stem}.json`, bytes: Buffer.from(JSON.stringify(publicParsed(parsed), null, 2)), mime: "application/json" }];
	}
}

const escapeText = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);


/** JSON-safe view: image bytes replaced by their refs (the endpoint serves them separately). */
export function publicParsed(parsed: Parsed): unknown {
	const clone = { ...parsed } as Record<string, unknown>;
	if ("images" in parsed) clone.images = parsed.images.map(({ bytes, ...rest }) => ({ ...rest, bytes: bytes.length }));
	return clone;
}

// ---------------------------------------------------------------- agent-facing helpers

/** Short structural line plus a bounded excerpt, for attaching a file to a chat. */
export function inlineFor(parsed: Parsed, limit = 6000): string {
	const summary = summaryOf(parsed);
	const body = markdownFor(parsed);
	const clipped = body.length > limit ? `${body.slice(0, limit)}\n…[${body.length - limit} more characters — use file_parse for the rest]` : body;
	const notes = parsed.notes?.length ? `\nNotes: ${parsed.notes.join("; ")}` : "";
	return `${summary}${notes}\n\n${clipped}`;
}


export { imageList, decodeDataUri };
