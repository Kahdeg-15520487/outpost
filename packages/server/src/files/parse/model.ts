/**
 * The shape every parser produces: one structural model per format family, plus renderers that
 * turn it into Markdown (for the agent) and HTML (for the Files preview). Blocks keep enough
 * structure — styles, list levels, table spans, image sizes — that reading is not lossy.
 */

export interface Run {
	text: string;
	bold?: boolean;
	italic?: boolean;
	underline?: boolean;
	strike?: boolean;
	code?: boolean;
	sup?: boolean;
	sub?: boolean;
	size?: number;
	color?: string;
	font?: string;
	link?: string;
}

export interface ListInfo {
	level: number;
	ordered: boolean;
	marker?: string;
}

export interface TableCell {
	blocks: Block[];
	colSpan?: number;
	rowSpan?: number;
	header?: boolean;
}

export interface TableRow {
	cells: TableCell[];
	header?: boolean;
}

export type Align = "left" | "center" | "right" | "justify";

export type Block =
	| { type: "heading"; level: number; runs: Run[]; style?: string }
	| { type: "paragraph"; runs: Run[]; style?: string; align?: Align; list?: ListInfo; indent?: number }
	| { type: "table"; rows: TableRow[]; widths?: number[]; caption?: string }
	| { type: "image"; ref: string; alt?: string; width?: number; height?: number }
	| { type: "code"; text: string; language?: string }
	| { type: "quote"; blocks: Block[] }
	| { type: "break" };

export interface ParsedImage {
	/** Stable within one parse; used by blocks and by the image endpoint. */
	ref: string;
	name: string;
	mime: string;
	bytes: Buffer;
	width?: number;
	height?: number;
	alt?: string;
}

export interface TextItem {
	str: string;
	x: number;
	y: number;
	width?: number;
	height?: number;
	font?: string;
	size?: number;
}

export interface ParsedPage {
	index: number;
	width: number;
	height: number;
	rotation?: number;
	text: string;
	items?: TextItem[];
	images?: string[];
}

export interface SheetCell {
	ref: string;
	row: number;
	col: number;
	value: string | number | boolean | null;
	type: "string" | "number" | "boolean" | "date" | "error" | "empty";
	formula?: string;
	format?: string;
	link?: string;
}

export interface ParsedSheet {
	name: string;
	index: number;
	hidden?: boolean;
	rows: number;
	cols: number;
	cells: SheetCell[];
	merged: string[];
	widths?: number[];
	freeze?: string;
	autoFilter?: string;
}

export interface ParsedSlide {
	index: number;
	title?: string;
	layout?: string;
	blocks: Block[];
	notes?: string;
}

export interface ArchiveEntry {
	path: string;
	size: number;
	packed?: number;
	method?: string;
	crc?: string;
	modified?: string;
	dir?: boolean;
	encrypted?: boolean;
}

interface Base {
	name: string;
	size: number;
	format: string;
	/** Which engine produced the content (mammoth, exceljs, ooxml walker, pdf.js, …). */
	engine?: string;
	/** The look and feel, kept for output generation: theme, fonts, colours, styles, geometry. */
	design?: DesignInfo;
	/** Anything the parser had to skip, cap or approximate. Shown to the agent and the user. */
	notes?: string[];
}

export interface ParsedDocument extends Base {
	kind: "document";
	blocks: Block[];
	images: ParsedImage[];
	headings: { level: number; text: string }[];
	stats: { paragraphs: number; tables: number; images: number; words: number; footnotes?: number; headers?: string[] };
}

export interface ParsedSheets extends Base {
	kind: "sheets";
	sheets: ParsedSheet[];
	images: ParsedImage[];
	stats: { sheets: number; cells: number; formulas: number };
}

export interface ParsedSlides extends Base {
	kind: "slides";
	slides: ParsedSlide[];
	images: ParsedImage[];
	stats: { slides: number; images: number; notes: number };
}

export interface ParsedPages extends Base {
	kind: "pages";
	pages: ParsedPage[];
	images: ParsedImage[];
	stats: { pages: number; words: number; images: number };
}

export interface ParsedArchive extends Base {
	kind: "archive";
	archive: "zip" | "rar" | "7z" | "tar" | "gz";
	entries: ArchiveEntry[];
	stats: { entries: number; bytes: number; files: number; folders: number };
}

export interface ParsedText extends Base {
	kind: "text";
	text: string;
	language?: string;
	lines: number;
}

export interface ParsedJson extends Base {
	kind: "json";
	value: unknown;
}

/** A file we recognised but cannot structurally parse (unknown binary, encrypted, damaged). */
export interface ParsedOpaque extends Base {
	kind: "opaque";
	reason: string;
}

export type Parsed = ParsedDocument | ParsedSheets | ParsedSlides | ParsedPages | ParsedArchive | ParsedText | ParsedJson | ParsedOpaque;
export type ParsedKind = Parsed["kind"];

// ---------------------------------------------------------------- the design model
// Kept separately from content: this is the raw material for producing documents later
// (fonts, colours, sizes, spacing, geometry), not something a reader needs.

export interface ThemeInfo {
	name?: string;
	fonts?: { major?: string; minor?: string; majorEastAsian?: string; minorEastAsian?: string };
	colors?: Record<string, string>;
}

export interface StyleSpec {
	id: string;
	name?: string;
	type?: string;
	basedOn?: string;
	font?: string;
	size?: number;
	bold?: boolean;
	italic?: boolean;
	color?: string;
	align?: Align;
	spaceBefore?: number;
	spaceAfter?: number;
	lineSpacing?: number;
	indent?: number;
}

export interface PageSetup {
	width?: number;
	height?: number;
	orient?: "portrait" | "landscape";
	margins?: { top?: number; right?: number; bottom?: number; left?: number };
}

export interface ShapeInfo {
	name?: string;
	kind: string;
	role?: string;
	/** Geometry in CSS pixels, so it can feed a renderer directly. */
	x?: number;
	y?: number;
	w?: number;
	h?: number;
	fill?: string;
	line?: string;
	font?: { name?: string; size?: number; color?: string; bold?: boolean; italic?: boolean; align?: Align };
	text?: string;
	table?: { rows: number; cols: number; widths?: number[] };
	chart?: { type: string; series: { name?: string; values: number[]; categories?: string[] }[] };
	image?: { ref: string };
}

export interface DesignInfo {
	theme?: ThemeInfo;
	page?: PageSetup;
	styles?: StyleSpec[];
	fonts?: { name: string; count: number; sizes?: number[] }[];
	colors?: { value: string; count: number }[];
	/** pptx: every shape of every slide, in document order. */
	shapes?: (ShapeInfo & { slide?: number })[];
	slides?: { index: number; layout?: string; background?: string; shapes: number[] }[];
	sheets?: { name: string; headerFill?: string; headerFont?: string; widths?: number[]; freeze?: string; autoFilter?: string }[];
}

/** Most frequent values first, capped, for palettes and font inventories. */
export function tally(values: (string | undefined)[], max = 12): { value: string; count: number }[] {
	const counts = new Map<string, number>();
	for (const v of values) if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
	return [...counts.entries()]
		.sort((a, b) => b[1] - a[1])
		.slice(0, max)
		.map(([value, count]) => ({ value, count }));
}

export const imageList = (p: Parsed): ParsedImage[] => ("images" in p ? p.images : []);

// ---------------------------------------------------------------- text helpers

export const runsText = (runs: Run[]) => runs.map((r) => r.text).join("");

const escapeHtml = (s: string) =>
	s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const mdInline = (s: string) => s.replace(/([\\`*_{}[\]()#+\-.!|>])/g, "\\$1");

export interface RenderOptions {
	/** URL (or data: URI) for a parsed image reference. */
	imgSrc?: (image: ParsedImage) => string;
	/** Cap on table rows / grid sizes and consecutive blank lines. */
	maxTableRows?: number;
	maxTableCols?: number;
	/** Include position data for PDF text. */
	includePositions?: boolean;
	/** HTML only: inline images as data URIs (default) or leave them to the caller's imgSrc. */
	inlineImages?: boolean;
}

function runsMarkdown(runs: Run[]): string {
	let out = "";
	for (const r of runs) {
		let t = r.text;
		if (r.code) t = `\`${t.replace(/`/g, "\\`")}\``;
		else {
			if (r.bold) t = `**${t}**`;
			if (r.italic) t = `*${t}*`;
			if (r.strike) t = `~~${t}~~`;
			if (r.sup) t = `<sup>${t}</sup>`;
			else if (r.sub) t = `<sub>${t}</sub>`;
		}
		if (r.underline && !r.code) t = `<u>${t}</u>`;
		if (r.link) t = `[${t.replace(/[[\]]/g, "\\$&")}](${r.link})`;
		out += t;
	}
	return out;
}

function runsHtml(runs: Run[]): string {
	let out = "";
	for (const r of runs) {
		let t = escapeHtml(r.text);
		if (r.code) t = `<code>${t}</code>`;
		if (r.bold) t = `<strong>${t}</strong>`;
		if (r.italic) t = `<em>${t}</em>`;
		if (r.strike) t = `<s>${t}</s>`;
		if (r.underline) t = `<u>${t}</u>`;
		if (r.sup) t = `<sup>${t}</sup>`;
		else if (r.sub) t = `<sub>${t}</sub>`;
		if (r.color) t = `<span style="color:${escapeHtml(r.color)}">${t}</span>`;
		if (r.link) t = `<a href="${escapeHtml(r.link)}" target="_blank" rel="noreferrer">${t}</a>`;
		out += t;
	}
	return out;
}

// ---------------------------------------------------------------- markdown

function tableMarkdown(block: Extract<Block, { type: "table" }>, opts: RenderOptions): string {
	const maxRows = opts.maxTableRows ?? 200;
	const maxCols = opts.maxTableCols ?? 24;
	const rows = block.rows.slice(0, maxRows);
	const cols = Math.max(1, Math.min(maxCols, ...rows.map((r) => r.cells.length)));
	const lines: string[] = [];
	const cellText = (c: TableCell | undefined) =>
		(c?.blocks ?? [])
			.map((b) => ("runs" in b ? runsMarkdown(b.runs) : b.type === "image" ? `![${b.alt ?? "image"}](${b.ref})` : ""))
			.join(" ")
			.replace(/\|/g, "\\|")
			.replace(/\s*\n\s*/g, "<br>")
			.trim();
	const rowLine = (r: TableRow) => `| ${Array.from({ length: cols }, (_, i) => cellText(r.cells[i])).join(" | ")} |`;
	rows.forEach((r, i) => {
		lines.push(rowLine(r));
		if (i === 0) lines.push(`| ${Array.from({ length: cols }, () => "---").join(" | ")} |`);
	});
	if (block.rows.length > maxRows) lines.push(`| … ${block.rows.length - maxRows} more rows |`);
	return lines.join("\n");
}

function blocksMarkdown(blocks: Block[], opts: RenderOptions, depth = 0): string {
	const parts: string[] = [];
	let list: { ordered: boolean } | undefined;
	const endList = () => {
		if (list) parts.push("");
		list = undefined;
	};
	for (const b of blocks) {
		if (b.type !== "paragraph" || !b.list) endList();
		switch (b.type) {
			case "heading":
				parts.push(`${"#".repeat(Math.max(1, Math.min(6, b.level)))} ${runsMarkdown(b.runs)}`);
				break;
			case "paragraph": {
				const body = runsMarkdown(b.runs);
				if (b.list) {
					if (!list || list.ordered !== b.list.ordered) {
						list = { ordered: b.list.ordered };
					}
					const indent = "  ".repeat(Math.max(0, b.list.level));
					const marker = b.list.ordered ? `${b.list.marker ?? "1"}.` : "-";
					parts.push(`${indent}${marker} ${body}`.trimEnd());
				} else if (b.align === "center" && body) parts.push(`<p align="center">${body}</p>`);
				else if (body) parts.push(body);
				break;
			}
			case "table":
				parts.push(tableMarkdown(b, opts));
				break;
			case "image":
				parts.push(`![${b.alt ?? b.ref}](${opts.imgSrc ? opts.imgSrc({ ref: b.ref } as ParsedImage) : b.ref})`);
				break;
			case "code":
				parts.push(`\`\`\`${b.language ?? ""}\n${b.text}\n\`\`\``);
				break;
			case "quote":
				parts.push(
					blocksMarkdown(b.blocks, opts, depth + 1)
						.split("\n")
						.map((l) => `> ${l}`)
						.join("\n"),
				);
				break;
			case "break":
				parts.push("---");
				break;
		}
	}
	endList();
	return parts.join("\n\n").replace(/\n{3,}/g, "\n\n").trim();
}

function blocksHtml(blocks: Block[], opts: RenderOptions): string {
	const out: string[] = [];
	let list: { ordered: boolean; level: number } | undefined;
	const closeList = () => {
		if (list) out.push(list.ordered ? "</ol>" : "</ul>");
		list = undefined;
	};
	for (const b of blocks) {
		if (b.type !== "paragraph" || !b.list) closeList();
		switch (b.type) {
			case "heading": {
				const level = Math.max(1, Math.min(6, b.level));
				out.push(`<h${level}>${runsHtml(b.runs)}</h${level}>`);
				break;
			}
			case "paragraph": {
				if (b.list) {
					const level = b.list.level;
					if (!list || list.ordered !== b.list.ordered || list.level > level) closeList();
					while (!list || list.level < level) {
						out.push(list?.ordered ? "<ol>" : "<ul>");
						list = { ordered: b.list.ordered, level: list ? list.level + 1 : level };
					}
					out.push(`<li>${runsHtml(b.runs)}</li>`);
				} else {
					const style = [b.align && b.align !== "left" ? `text-align:${b.align}` : "", b.indent ? `margin-left:${b.indent}px` : ""].filter(Boolean).join(";");
					out.push(`<p${style ? ` style="${style}"` : ""}>${runsHtml(b.runs) || "<br>"}</p>`);
				}
				break;
			}
			case "table": {
				const maxRows = opts.maxTableRows ?? 500;
				const rows = b.rows.slice(0, maxRows);
				const body = rows
					.map((r) => {
						const cells = r.cells
							.map((c) => {
								const tag = r.header || c.header ? "th" : "td";
								const span = [c.colSpan && c.colSpan > 1 ? ` colspan="${c.colSpan}"` : "", c.rowSpan && c.rowSpan > 1 ? ` rowspan="${c.rowSpan}"` : ""].join("");
								return `<${tag}${span}>${blocksHtml(c.blocks, opts) || "&nbsp;"}</${tag}>`;
							})
							.join("");
						return `<tr>${cells}</tr>`;
					})
					.join("");
				out.push(`<table>${body}</table>`);
				if (b.rows.length > maxRows) out.push(`<p class="muted">… ${b.rows.length - maxRows} more rows</p>`);
				break;
			}
			case "image": {
				const src = opts.imgSrc?.({ ref: b.ref } as ParsedImage) ?? b.ref;
				const size = [b.width ? `width:${Math.round(b.width)}px` : "", b.height ? `max-height:${Math.round(b.height)}px` : ""].filter(Boolean).join(";");
				out.push(`<img src="${escapeHtml(src)}" alt="${escapeHtml(b.alt ?? "")}"${size ? ` style="${size}"` : ""} />`);
				break;
			}
			case "code":
				out.push(`<pre><code>${escapeHtml(b.text)}</code></pre>`);
				break;
			case "quote":
				out.push(`<blockquote>${blocksHtml(b.blocks, opts)}</blockquote>`);
				break;
			case "break":
				out.push("<hr />");
				break;
		}
	}
	closeList();
	return out.join("\n");
}

export function sheetGrid(sheet: ParsedSheet, opts: RenderOptions = {}): (string | number | boolean | null)[][] {
	const maxRows = opts.maxTableRows ?? 500;
	const maxCols = opts.maxTableCols ?? 40;
	const rows: (string | number | boolean | null)[][] = [];
	for (const cell of sheet.cells) {
		if (cell.row >= maxRows || cell.col >= maxCols) continue;
		while (rows.length <= cell.row) rows.push([]);
		rows[cell.row][cell.col] = cell.formula ? `=${cell.formula}` : cell.value;
	}
	return rows;
}

const cellOut = (v: string | number | boolean | null) => (v === null || v === undefined ? "" : String(v));

export function sheetToCsv(sheet: ParsedSheet, opts: RenderOptions = {}): string {
	const rows = sheetGrid(sheet, opts);
	return rows
		.map((r) =>
			Array.from({ length: sheet.cols || r.length }, (_, i) => {
				const v = cellOut(r[i]);
				return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
			}).join(","),
		)
		.join("\n");
}

export function sheetToMarkdown(sheet: ParsedSheet, opts: RenderOptions = {}): string {
	const rows = sheetGrid(sheet, opts);
	const cols = Math.max(1, ...rows.map((r) => r.length));
	const line = (r: (string | number | boolean | null)[]) => `| ${Array.from({ length: cols }, (_, i) => cellOut(r[i]).replace(/\|/g, "\\|").replace(/\n/g, " ")).join(" | ")} |`;
	const out = rows.slice(0, opts.maxTableRows ?? 100).map(line);
	if (out.length) out.splice(1, 0, `| ${Array.from({ length: cols }, () => "---").join(" | ")} |`);
	return out.join("\n");
}

export function sheetToJson(sheet: ParsedSheet, opts: RenderOptions = {}): unknown[] {
	const rows = sheetGrid(sheet, opts);
	const header = (rows[0] ?? []).map((v, i) => (cellOut(v) || `col${i + 1}`).toString());
	return rows.slice(1).map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? null])));
}

export function markdownOf(p: Parsed, opts: RenderOptions = {}): string {
	switch (p.kind) {
		case "document":
			return blocksMarkdown(p.blocks, opts);
		case "sheets":
			return p.sheets
				.map((s) => `## Sheet: ${s.name}${s.hidden ? " (hidden)" : ""} — ${s.rows} rows × ${s.cols} columns\n\n${sheetToMarkdown(s, opts)}${s.merged.length ? `\n\nMerged: ${s.merged.slice(0, 40).join(", ")}` : ""}`)
				.join("\n\n");
		case "slides":
			return p.slides
				.map((s) => {
					const head = `## Slide ${s.index}${s.title ? ` — ${s.title}` : ""}`;
					const body = blocksMarkdown(s.blocks, opts);
					const notes = s.notes ? `\n\n**Notes:** ${s.notes}` : "";
					return `${head}\n\n${body}${notes}`;
				})
				.join("\n\n");
		case "pages":
			return p.pages.map((pg) => `## Page ${pg.index} (${Math.round(pg.width)}×${Math.round(pg.height)})\n\n${pg.text}`).join("\n\n");
		case "archive":
			return archiveMarkdown(p);
		case "text":
			return p.language ? `\`\`\`${p.language}\n${p.text}\n\`\`\`` : p.text;
		case "json":
			return `\`\`\`json\n${JSON.stringify(p.value, null, 2)}\n\`\`\``;
		case "opaque":
			return `_${p.reason}_`;
	}
}

export function htmlOf(p: Parsed, opts: RenderOptions = {}): string {
	switch (p.kind) {
		case "document":
			return blocksHtml(p.blocks, opts);
		case "sheets":
			return p.sheets
				.map(
					(s) =>
						`<h2>${escapeHtml(s.name)}${s.hidden ? " <em>(hidden)</em>" : ""}</h2><p class="muted">${s.rows} rows × ${s.cols} columns</p>${blocksHtml(
							[{ type: "table", rows: sheetGrid(s, opts).map((r) => ({ cells: r.map((v) => ({ blocks: [{ type: "paragraph", runs: [{ text: cellOut(v) }] }] })) })) }],
							opts,
						)}`,
				)
				.join("\n");
		case "slides":
			return p.slides
				.map((s) => `<section class="slide"><h2>Slide ${s.index}${s.title ? ` — ${escapeHtml(s.title)}` : ""}</h2>${blocksHtml(s.blocks, opts)}${s.notes ? `<p class="notes"><b>Notes:</b> ${escapeHtml(s.notes)}</p>` : ""}</section>`)
				.join("\n");
		case "pages":
			return p.pages.map((pg) => `<section class="page"><h3>Page ${pg.index}</h3><div class="pdf-text">${escapeHtml(pg.text).replace(/\n/g, "<br />")}</div></section>`).join("\n");
		case "archive":
			return `<table>${p.entries
				.slice(0, 2000)
				.map((e) => `<tr><td>${escapeHtml(e.path)}</td><td>${e.size}</td><td>${escapeHtml(e.method ?? "")}</td><td>${escapeHtml(e.modified ?? "")}</td></tr>`)
				.join("")}</table>`;
		case "text":
			return `<pre>${escapeHtml(p.text)}</pre>`;
		case "json":
			return `<pre>${escapeHtml(JSON.stringify(p.value, null, 2))}</pre>`;
		case "opaque":
			return `<p class="muted">${escapeHtml(p.reason)}</p>`;
	}
}

export function textOf(p: Parsed): string {
	switch (p.kind) {
		case "document":
			return blocksText(p.blocks);
		case "sheets":
			return p.sheets.map((s) => `${s.name}\n${sheetToCsv(s, { maxRows: 10_000, maxCols: 100 } as RenderOptions)}`).join("\n\n");
		case "slides":
			return p.slides.map((s) => `Slide ${s.index}${s.title ? ` — ${s.title}` : ""}\n${blocksText(s.blocks)}${s.notes ? `\nNotes: ${s.notes}` : ""}`).join("\n\n");
		case "pages":
			return p.pages.map((pg) => pg.text).join("\n\n");
		case "archive":
			return p.entries.map((e) => `${e.path}\t${e.size}`).join("\n");
		case "text":
			return p.text;
		case "json":
			return JSON.stringify(p.value, null, 2);
		case "opaque":
			return p.reason;
	}
}

export const blocksText = (blocks: Block[]): string =>
	blocks
		.map((b) => {
			if (b.type === "paragraph" || b.type === "heading") return runsText(b.runs);
			if (b.type === "table") return b.rows.map((r) => r.cells.map((c) => blocksText(c.blocks)).join("\t")).join("\n");
			if (b.type === "code") return b.text;
			if (b.type === "quote") return blocksText(b.blocks);
			return "";
		})
		.filter(Boolean)
		.join("\n");

export function archiveMarkdown(p: ParsedArchive): string {
	const head = `## ${p.archive.toUpperCase()} archive — ${p.stats.files} files, ${p.stats.folders} folders`;
	const rows = p.entries.slice(0, 500).map((e) => `| ${e.path} | ${e.dir ? "dir" : e.size} | ${e.method ?? ""} | ${e.modified ?? ""} |`);
	const table = rows.length ? ["| Path | Size | Method | Modified |", "| --- | --- | --- | --- |", ...rows].join("\n") : "";
	return `${head}\n\n${table}${p.entries.length > 500 ? `\n\n… ${p.entries.length - 500} more entries` : ""}`;
}

/** A compact, token-frugal description for the agent's attachment inlining. */
export function summaryOf(p: Parsed): string {
	switch (p.kind) {
		case "document":
			return `document: ${p.stats.paragraphs} paragraphs, ${p.stats.tables} tables, ${p.stats.images} images, ${p.stats.words} words${p.headings.length ? `; headings: ${p.headings.slice(0, 12).map((h) => h.text).join(" / ")}` : ""}`;
		case "sheets":
			return `workbook: ${p.sheets.map((s) => `${s.name} (${s.rows}×${s.cols}${s.hidden ? ", hidden" : ""})`).join(", ")}; ${p.stats.cells} cells, ${p.stats.formulas} formulas`;
		case "slides":
			return `presentation: ${p.stats.slides} slides${p.slides.some((s) => s.title) ? ` (${p.slides.map((s) => s.title ?? "untitled").slice(0, 10).join(" / ")})` : ""}; ${p.stats.images} images`;
		case "pages":
			return `pdf: ${p.stats.pages} pages, ${p.stats.words} words, ${p.stats.images} images`;
		case "archive":
			return `${p.archive}: ${p.stats.files} files, ${p.stats.folders} folders, ${p.stats.bytes} bytes uncompressed`;
		case "text":
			return `text: ${p.lines} lines`;
		case "json":
			return "json";
		case "opaque":
			return `unparsed: ${p.reason}`;
	}
}
