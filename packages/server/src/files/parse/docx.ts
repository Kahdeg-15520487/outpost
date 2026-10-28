/**
 * DOCX: paragraphs, runs and tables with their real formatting, numbering, hyperlinks,
 * headers/footers, footnotes, comments and the embedded images (sized, not just named).
 */

import { posix } from "node:path";
import type { Package } from "./ooxml.ts";
import type { Align, Block, ListInfo, ParsedDocument, ParsedImage, Run, TableCell, TableRow } from "./model.ts";
import { attr, childrenNamed, firstChild, isNode, localName, textContent, type XmlNode } from "./xml.ts";
import { openPackage } from "./ooxml.ts";
import { htmlToBlocks } from "./html.ts";
import { tally, type DesignInfo, type StyleSpec } from "./model.ts";
import { documentElement, findAll } from "./xml.ts";

const EMU_PER_PX = 9525;
const MAX_BLOCKS = 20_000;

const CONTAINERS = new Set(["hyperlink", "ins", "smartTag", "customXml", "sdt", "sdtContent", "fldSimple", "dir", "bdo", "moveTo"]);
const SKIP = new Set(["del", "moveFrom", "commentRangeStart", "commentRangeEnd", "bookmarkStart", "bookmarkEnd", "proofErr", "permStart", "permEnd"]);

interface StyleInfo {
	name?: string;
	basedOn?: string;
	outline?: number;
	bold?: boolean;
	italic?: boolean;
	font?: string;
	size?: number;
	color?: string;
}

interface NumberLevel {
	format: string;
	text: string;
	start: number;
}

export interface DocxOptions {
	name: string;
	size: number;
	data: Buffer;
}

export function walkDocx(pkg: Package, opts: DocxOptions): ParsedDocument {
	const notes: string[] = [];
	const images: ParsedImage[] = [];
	const imageByPart = new Map<string, ParsedImage>();
	const bodyPart = [...pkg.rootRels().values()].find((r) => r.type.endsWith("/officeDocument"))?.part ?? "word/document.xml";
	const rels = pkg.rels(bodyPart);

	// ---- styles
	const styles = new Map<string, StyleInfo>();
	let defaultFont: string | undefined;
	let defaultSize: number | undefined;
	if (pkg.has("word/styles.xml")) {
		const root = documentElement(pkg.xml("word/styles.xml"));
		const docDefaults = firstChild(root, "docDefaults");
		const rPrDefault = firstChild(firstChild(docDefaults, "rPrDefault"), "rPr");
		defaultFont = attr(firstChild(rPrDefault, "rFonts"), "ascii", "hAnsi");
		const sz = attr(firstChild(rPrDefault, "sz"), "val");
		if (sz) defaultSize = Number(sz) / 2;
		for (const style of root.children) {
			if (typeof style === "string" || localName(style.name) !== "style") continue;
			const id = style.attrs["w:styleId"] ?? attr(style, "styleId");
			if (!id) continue;
			const pPr = firstChild(style, "pPr");
			styles.set(id, {
				name: attr(firstChild(style, "name"), "val"),
				basedOn: attr(firstChild(style, "basedOn"), "val"),
				outline: Number(attr(firstChild(pPr, "outlineLvl"), "val") ?? Number.NaN),
				bold: boolProp(firstChild(firstChild(style, "rPr"), "b")),
				italic: boolProp(firstChild(firstChild(style, "rPr"), "i")),
				font: attr(firstChild(firstChild(style, "rPr"), "rFonts"), "ascii", "hAnsi"),
				size: numberOr(firstChild(firstChild(style, "rPr"), "sz"), (v) => v / 2),
				color: attr(firstChild(firstChild(style, "rPr"), "color"), "val"),
			});
		}
	}

	const styleChain = (id: string | undefined, seen = new Set<string>()): StyleInfo => {
		if (!id || seen.has(id)) return {};
		seen.add(id);
		const own = styles.get(id);
		if (!own) return {};
		const base = styleChain(own.basedOn, seen);
		return {
			name: own.name ?? base.name,
			outline: own.outline ?? base.outline,
			bold: own.bold ?? base.bold,
			italic: own.italic ?? base.italic,
			font: own.font ?? base.font,
			size: own.size ?? base.size,
			color: own.color ?? base.color,
		};
	};

	// ---- numbering
	const abstractLevels = new Map<string, Map<number, NumberLevel>>();
	const numToAbstract = new Map<string, string>();
	if (pkg.has("word/numbering.xml")) {
		const root = documentElement(pkg.xml("word/numbering.xml"));
		for (const abs of childrenNamed(root, "abstractNum")) {
			const id = attr(abs, "abstractNumId");
			if (!id) continue;
			const levels = new Map<number, NumberLevel>();
			for (const lvl of childrenNamed(abs, "lvl")) {
				const ilvl = Number(attr(lvl, "ilvl") ?? 0);
				levels.set(ilvl, {
					format: attr(firstChild(lvl, "numFmt"), "val") ?? "decimal",
					text: attr(firstChild(lvl, "lvlText"), "val") ?? "",
					start: Number(attr(firstChild(lvl, "start"), "val") ?? 1),
				});
			}
			abstractLevels.set(id, levels);
		}
		for (const num of childrenNamed(root, "num")) {
			const id = attr(num, "numId");
			const abs = attr(firstChild(num, "abstractNumId"), "val");
			if (id && abs) numToAbstract.set(id, abs);
		}
	}
	const counters = new Map<string, number>();

	const listMarker = (numId: string, ilvl: number): { ordered: boolean; marker: string } => {
		const levels = abstractLevels.get(numToAbstract.get(numId) ?? "");
		const level = levels?.get(ilvl);
		if (!level) return { ordered: false, marker: "•" };
		if (level.format === "bullet") return { ordered: false, marker: level.text || "•" };
		if (level.format === "none") return { ordered: false, marker: "" };
		const keys = [...counters.keys()].filter((k) => k.startsWith(`${numId}:`));
		for (const key of keys) if (Number(key.split(":")[1]) > ilvl) counters.delete(key);
		const key = `${numId}:${ilvl}`;
		counters.set(key, (counters.get(key) ?? level.start - 1) + 1);
		const n = counters.get(key)!;
		const marker = level.text
			.replace(/%(\d)/g, (_m, d: string) => {
				const depth = Number(d) - 1;
				return String(counters.get(`${numId}:${depth}`) ?? level.start);
			})
			.replace(/\u0000/g, "");
		return { ordered: true, marker: marker || `${n}.` };
	};

	// ---- body
	const blocks: Block[] = [];
	const headings: { level: number; text: string }[] = [];
	let tableCount = 0;
	let paragraphCount = 0;
	let truncated = false;
	const footnotes: string[] = [];

	const addImage = (part: string | undefined, widthEmu?: number, heightEmu?: number, alt?: string): string | undefined => {
		if (!part || !pkg.has(part)) return undefined;
		const existing = imageByPart.get(part);
		if (existing) return existing.ref;
		const bytes = pkg.bytes(part);
		if (bytes.length > 24 << 20) return undefined;
		const mime = mimeOf(part, bytes);
		if (!mime) return undefined;
		const image: ParsedImage = {
			ref: `img${images.length + 1}`,
			name: posix.basename(part),
			mime,
			bytes,
			...(widthEmu ? { width: Math.round(widthEmu / EMU_PER_PX) } : {}),
			...(heightEmu ? { height: Math.round(heightEmu / EMU_PER_PX) } : {}),
			...(alt ? { alt } : {}),
		};
		images.push(image);
		imageByPart.set(part, image);
		return image.ref;
	};

	const runFromNode = (r: XmlNode, link?: string): Run | undefined => {
		const rPr = firstChild(r, "rPr");
		const style = styleChain(attr(firstChild(rPr, "rStyle"), "val"));
		const props: Run = { text: "" };
		if (boolProp(firstChild(rPr, "b")) ?? style.bold) props.bold = true;
		if (boolProp(firstChild(rPr, "i")) ?? style.italic) props.italic = true;
		const u = firstChild(rPr, "u");
		if (u && (attr(u, "val") ?? "single") !== "none") props.underline = true;
		if (boolProp(firstChild(rPr, "strike")) || boolProp(firstChild(rPr, "dstrike"))) props.strike = true;
		const vert = attr(firstChild(rPr, "vertAlign"), "val");
		if (vert === "superscript") props.sup = true;
		else if (vert === "subscript") props.sub = true;
		const sz = attr(firstChild(rPr, "sz"), "val");
		if (sz) props.size = Number(sz) / 2;
		else if (style.size) props.size = style.size;
		const color = attr(firstChild(rPr, "color"), "val");
		if (color && color !== "auto") props.color = `#${color.replace(/^#/, "")}`;
		else if (style.color && style.color !== "auto") props.color = `#${style.color}`;
		const font = attr(firstChild(rPr, "rFonts"), "ascii", "hAnsi");
		if (font) props.font = font;
		const mono = /consolas|courier|mono|menlo|code/i.test(font ?? style.font ?? "");
		if (mono) props.code = true;
		if (link) props.link = link;

		let text = "";
		for (const child of r.children) {
			if (!isNode(child)) continue;
			switch (localName(child.name)) {
				case "t":
					text += textContent(child);
					break;
				case "tab":
				case "ptab":
					text += "\t";
					break;
				case "br":
				case "cr":
					text += attr(child, "type") === "page" ? "\u0000PAGE\u0000" : "\n";
					break;
				case "noBreakHyphen":
					text += "-";
					break;
				case "sym":
					text += String.fromCodePoint(Number.parseInt(attr(child, "char") ?? "", 16) || 0x2022);
					break;
				case "drawing":
				case "pict":
				case "object": {
					const blip = findFirst(child, "blip") ?? findFirst(child, "imagedata");
					const embed = attr(blip, "embed", "id");
					const extent = findFirst(child, "extent");
					const cx = Number(attr(extent, "cx") ?? 0) || undefined;
					const cy = Number(attr(extent, "cy") ?? 0) || undefined;
					const docPr = findFirst(child, "docPr");
					const alt = attr(docPr, "descr", "title") ?? attr(blip, "name");
					const ref = addImage(embed ? rels.get(embed)?.part : undefined, cx, cy, alt);
					if (ref) text += `\u0000IMG:${ref}\u0000`;
					break;
				}
				case "instrText":
				case "delText":
					break;
				default:
					if (SKIP.has(localName(child.name))) break;
			}
		}
		props.text = text;
		return text ? props : undefined;
	};

	/** Walk a paragraph-ish container collecting runs (following hyperlinks and content controls). */
	const collectRuns = (node: XmlNode, link?: string, out: Run[] = []): Run[] => {
		for (const child of node.children) {
			if (!isNode(child)) continue;
			const name = localName(child.name);
			if (SKIP.has(name)) continue;
			if (name === "r") {
				const run = runFromNode(child, link);
				if (run) out.push(run);
			} else if (name === "hyperlink") {
				const id = attr(child, "id");
				const rel = id ? rels.get(id) : undefined;
				const target = rel?.external ? rel.target : attr(child, "anchor") ? `#${attr(child, "anchor")}` : undefined;
				collectRuns(child, target ?? link, out);
			} else if (CONTAINERS.has(name) || name === "sdtContent") {
				collectRuns(child, link, out);
			}
		}
		return out;
	};

	const paragraphBlock = (p: XmlNode): Block[] => {
		const pPr = firstChild(p, "pPr");
		const styleId = attr(firstChild(pPr, "pStyle"), "val");
		const style = styleChain(styleId);
		const numId = attr(firstChild(firstChild(pPr, "numPr"), "numId"), "val");
		const ilvl = Number(attr(firstChild(firstChild(pPr, "numPr"), "ilvl"), "val") ?? 0);
		const jc = attr(firstChild(pPr, "jc"), "val");
		const align: Align | undefined = jc === "both" ? "justify" : jc === "center" ? "center" : jc === "right" || jc === "end" ? "right" : jc === "left" || jc === "start" ? "left" : undefined;
		const indentTwips = Number(attr(firstChild(pPr, "ind"), "left", "start") ?? 0);

		const raw = collectRuns(p);
		// split out images and page breaks into their own blocks
		const blocksOut: Block[] = [];
		let buffer: Run[] = [];
		const flush = () => {
			if (buffer.some((r) => r.text.trim())) {
				paragraphCount++;
				const list: ListInfo | undefined = numId && numId !== "0" ? { level: ilvl, ...listMarkerOrNone(numId, ilvl) } : undefined;
				const headingLevel = headingLevelOf(styleId, style);
				if (headingLevel) {
					const text = buffer.map((r) => r.text).join("").trim();
					if (text) headings.push({ level: headingLevel, text });
					blocksOut.push({ type: "heading", level: headingLevel, runs: buffer, ...(styleId ? { style: style.name ?? styleId } : {}) });
				} else {
					blocksOut.push({ type: "paragraph", runs: buffer, ...(style.name ? { style: style.name } : {}), ...(align ? { align } : {}), ...(list ? { list } : {}), ...(indentTwips ? { indent: Math.round(indentTwips / 15) } : {}) });
				}
			} else if (buffer.length) {
				blocksOut.push({ type: "paragraph", runs: buffer });
			}
			buffer = [];
		};
		for (const run of raw) {
			const parts = run.text.split(/\u0000(IMG:[^\u0000]+|PAGE)\u0000/);
			for (const part of parts) {
				if (!part) continue;
				if (part === "PAGE") {
					flush();
					blocksOut.push({ type: "break" });
				} else if (part.startsWith("IMG:")) {
					flush();
					const image = images.find((i) => i.ref === part.slice(4));
					if (image) blocksOut.push({ type: "image", ref: image.ref, ...(image.alt ? { alt: image.alt } : {}), ...(image.width ? { width: image.width } : {}), ...(image.height ? { height: image.height } : {}) });
					else blocksOut.push({ type: "image", ref: part.slice(4) });
				} else {
					buffer.push({ ...run, text: part });
				}
			}
		}
		flush();
		return blocksOut;
	};

	const listMarkerOrNone = (numId: string, ilvl: number) => {
		const m = listMarker(numId, ilvl);
		return { ordered: m.ordered, marker: m.marker };
	};

	const cellBlocks = (tc: XmlNode): Block[] => {
		const out: Block[] = [];
		for (const child of tc.children) {
			if (!isNode(child)) continue;
			const name = localName(child.name);
			if (name === "p") out.push(...paragraphBlock(child));
			else if (name === "tbl") out.push(...tableBlock(child));
			else if (name === "sdt") out.push(...(firstChild(child, "sdtContent") ? cellBlocks(firstChild(child, "sdtContent")!) : []));
		}
		return out;
	};

	const tableBlock = (tbl: XmlNode): Block[] => {
		const tblPr = firstChild(tbl, "tblPr");
		const grid = childrenNamed(firstChild(tbl, "tblGrid"), "gridCol").map((c) => Math.round(Number(attr(c, "w") ?? 0) / 15));
		const rows: TableRow[] = [];
		for (const tr of childrenNamed(tbl, "tr")) {
			const trPr = firstChild(tr, "trPr");
			const isHeader = boolProp(firstChild(trPr, "tblHeader")) === true;
			const cells: TableCell[] = [];
			for (const tc of childrenNamed(tr, "tc")) {
				const tcPr = firstChild(tc, "tcPr");
				const span = Number(attr(firstChild(tcPr, "gridSpan"), "val") ?? 1);
				const vMerge = firstChild(tcPr, "vMerge");
				const vMergeVal = vMerge ? (attr(vMerge, "val") ?? "continue") : undefined;
				const blocks = cellBlocks(tc);
				cells.push({
					blocks: blocks.length ? blocks : [{ type: "paragraph", runs: [{ text: "" }] }],
					...(span > 1 ? { colSpan: span } : {}),
					// "continue" cells are merged upward: keep the marker so nothing is silently dropped
					...(vMergeVal === "continue" ? { rowSpan: 0 } : {}),
					...(isHeader ? { header: true } : {}),
				});
			}
			if (cells.length) rows.push({ cells, ...(isHeader ? { header: true } : {}) });
		}
		if (!rows.length) return [];
		tableCount++;
		return [{ type: "table", rows, ...(grid.length ? { widths: grid } : {}) }];
	};

	const body = documentElement(pkg.xml(bodyPart));
	const bodyEl = firstChild(body, "body");
	for (const child of bodyEl?.children ?? []) {
		if (!isNode(child)) continue;
		const name = localName(child.name);
		if (blocks.length >= MAX_BLOCKS) {
			truncated = true;
			break;
		}
		if (name === "p") blocks.push(...paragraphBlock(child));
		else if (name === "tbl") blocks.push(...tableBlock(child));
		else if (name === "sdt") {
			const content = firstChild(child, "sdtContent");
			if (content) for (const inner of content.children) {
				if (!isNode(inner)) continue;
				if (localName(inner.name) === "p") blocks.push(...paragraphBlock(inner));
				else if (localName(inner.name) === "tbl") blocks.push(...tableBlock(inner));
			}
		}
	}
	if (truncated) notes.push(`stopped after ${MAX_BLOCKS} blocks`);

	// ---- footnotes, comments, headers
	let footnoteCount = 0;
	if (pkg.has("word/footnotes.xml")) {
		const root = documentElement(pkg.xml("word/footnotes.xml"));
		for (const footnote of childrenNamed(root, "footnote")) {
			const id = Number(attr(footnote, "id") ?? 0);
			if (!id || attr(footnote, "type")) continue;
			const text = childrenNamed(footnote, "p").map((p) => textContent(p)).join("\n").trim();
			if (text) {
				footnotes.push(text);
				footnoteCount++;
			}
		}
	}
	if (pkg.has("word/comments.xml")) {
		const root = documentElement(pkg.xml("word/comments.xml"));
		const comments = childrenNamed(root, "comment")
			.map((c) => {
				const author = attr(c, "author") ?? "";
				const text = childrenNamed(c, "p").map((p) => textContent(p)).join(" ").trim();
				return text ? `${author ? `${author}: ` : ""}${text}` : "";
			})
			.filter(Boolean);
		if (comments.length) notes.push(`${comments.length} comments (${comments.slice(0, 5).join(" | ")}${comments.length > 5 ? "…" : ""})`);
	}
	const headerTexts: string[] = [];
	for (const name of pkg.names()) {
		if (!/^word\/(header|footer)\d*\.xml$/.test(name)) continue;
		const text = childrenNamed(documentElement(pkg.xml(name)), "p").map((p) => textContent(p)).join(" ").replace(/\s+/g, " ").trim();
		if (text) headerTexts.push(text);
	}

	const stats = {
		paragraphs: paragraphCount,
		tables: tableCount,
		images: images.length,
		words: countWords(blocks.map((b) => ("runs" in b ? textContent2(b.runs) : "")).join(" ")),
		...(footnoteCount ? { footnotes: footnoteCount } : {}),
		...(headerTexts.length ? { headers: headerTexts.slice(0, 6) } : {}),
	};
	if (footnotes.length) blocks.push({ type: "heading", level: 2, runs: [{ text: "Footnotes" }] }, ...footnotes.map((text, i) => ({ type: "paragraph" as const, runs: [{ text: `${i + 1}. ${text}`, size: 9 }] })));

	return { kind: "document", format: "docx", name: opts.name, size: opts.size, blocks, images, headings, stats, ...(notes.length ? { notes } : {}) };
}

const textContent2 = (runs: Run[]) => runs.map((r) => r.text).join("");

export const countWords = (text: string) => (text.match(/[\p{L}\p{N}][\p{L}\p{N}'’\-]*/gu) ?? []).length;

const numberOr = (node: XmlNode | undefined, map: (v: number) => number): number | undefined => {
	const v = attr(node, "val");
	if (!v) return undefined;
	const n = Number(v);
	return Number.isFinite(n) ? map(n) : undefined;
};

const boolProp = (node: XmlNode | undefined): boolean | undefined => {
	if (!node) return undefined;
	const v = attr(node, "val");
	return v === undefined ? true : !["0", "false", "off", "none"].includes(v);
};

function findFirst(node: XmlNode | undefined, name: string): XmlNode | undefined {
	if (!node) return undefined;
	for (const child of node.children) {
		if (!isNode(child)) continue;
		if (localName(child.name) === name) return child;
	}
	for (const child of node.children) {
		if (!isNode(child)) continue;
		const hit = findFirst(child, name);
		if (hit) return hit;
	}
	return undefined;
}

function headingLevelOf(styleId: string | undefined, style: StyleInfo): number | undefined {
	const name = (style.name ?? styleId ?? "").toLowerCase().replace(/\s+/g, " ").trim();
	if (!name) return undefined;
	if (name === "title") return 1;
	const heading = /^heading (\d)$/.exec(name) ?? /^heading(\d)$/.exec(name);
	if (heading) return Math.min(6, Number(heading[1]));
	if (style.outline !== undefined && Number.isFinite(style.outline) && style.outline >= 0 && style.outline < 6) return style.outline + 1;
	return undefined;
}

export function mimeOf(part: string, bytes: Buffer): string | undefined {
	const ext = posix.extname(part).toLowerCase();
	const map: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".bmp": "image/bmp", ".webp": "image/webp", ".svg": "image/svg+xml", ".tif": "image/tiff", ".tiff": "image/tiff", ".emf": "image/emf", ".wmf": "image/wmf" };
	if (map[ext]) return map[ext];
	if (bytes.subarray(0, 8).toString("hex") === "89504e470d0a1a0a") return "image/png";
	if (bytes.subarray(0, 3).toString("hex") === "ffd8ff") return "image/jpeg";
	return undefined;
}

// ---------------------------------------------------------------- the library path

export interface DocxResult extends ParsedDocument {}

/**
 * Content comes from mammoth (semantic HTML, footnotes, lists, tables, images). The OOXML
 * walker still runs: it supplies the design model (theme, styles, fonts, page setup) and is the
 * fallback for the documents mammoth cannot map.
 */
export async function parseDocx(data: Buffer, name: string, size: number): Promise<ParsedDocument> {
	const pkg = openPackage(data);
	const design = docxDesign(pkg);
	const notes: string[] = [];
	let walked: ParsedDocument | undefined;
	try {
		walked = walkDocx(pkg, { name, size, data });
	} catch (error) {
		notes.push(`style walk failed: ${(error as Error).message}`);
	}

	let content: { blocks: Block[]; images: ParsedImage[] } | undefined;
	let engine = "mammoth";
	try {
		const mammoth = (await import("mammoth")).default;
		const html = await mammoth.convertToHtml({ buffer: data });
		content = htmlToBlocks(html.value);
		if (html.messages?.length) {
			const warnings = html.messages.filter((m: { type: string }) => m.type === "warning").length;
			if (warnings) notes.push(`${warnings} mammoth warnings`);
		}
	} catch (error) {
		notes.push(`mammoth could not map this document (${(error as Error).message}); used the OOXML walker`);
		engine = "ooxml";
	}

	const base = walked ?? { headingless: true };
	const blocks = content?.blocks?.length ? content.blocks : (walked?.blocks ?? []);
	if (content?.images?.length) {
		// images decoded from mammoth's data URIs
		for (const image of content.images) content.images[content.images.indexOf(image)] = image;
	}
	const images = content?.images?.length ? content.images : (walked?.images ?? []);
	if (!blocks.length) notes.push("no readable content found");

	const headings = blocks.filter((b): b is Extract<Block, { type: "heading" }> => b.type === "heading").map((b) => ({ level: b.level, text: b.runs.map((r) => r.text).join("") }));
	const text = blocks.map((b) => ("runs" in b ? b.runs.map((r) => r.text).join(" ") : "")).join(" ");
	const tables = blocks.filter((b) => b.type === "table").length;
	const kept = walked?.stats.headers;
	return {
		kind: "document",
		format: "docx",
		name,
		size,
		engine,
		blocks,
		images,
		headings,
		stats: {
			paragraphs: blocks.filter((b) => b.type === "paragraph").length,
			tables,
			images: images.length,
			words: countWords(text),
			...(walked?.stats.footnotes ? { footnotes: walked.stats.footnotes } : {}),
			...(kept?.length ? { headers: kept } : {}),
		},
		design: {
			...design,
			fonts: fontTally(walked?.blocks?.length ? walked.blocks : blocks, design.styles),
			colors: tally((walked?.blocks ?? blocks).flatMap((b) => ("runs" in b ? b.runs.map((r) => r.color) : [])), 10),
		},
		...(notes.length ? { notes: [...notes, ...(walked?.notes ?? [])] } : walked?.notes ? { notes: walked.notes } : {}),
	};
	// `base` only exists to keep the walker's type honest when it failed
	void base;
}

/** Everything about how the document looks: theme, style catalog, page setup, headers. */
function docxDesign(pkg: Package) {
	const design: DesignInfo = {};
	// theme
	if (pkg.has("word/theme/theme1.xml")) {
		const theme = documentElement(pkg.xml("word/theme/theme1.xml"));
		const elements = findFirst(theme, "themeElements");
		const colors: Record<string, string> = {};
		const clrScheme = findFirst(elements ?? theme, "clrScheme");
		for (const entry of clrScheme?.children ?? []) {
			if (!isNode(entry)) continue;
			const srgb = findFirst(entry, "srgbClr") ?? findFirst(entry, "sysClr");
			const value = attr(srgb, "val", "lastClr");
			if (value) colors[localName(entry.name)] = value.startsWith("#") ? value : `#${value}`;
		}
		const fontScheme = findFirst(elements ?? theme, "fontScheme");
		const latin = (n: string) => attr(findFirst(findFirst(fontScheme, n), "latin"), "typeface");
		design.theme = {
			name: attr(theme.attrs ? { name: "", attrs: theme.attrs, children: [] } : undefined, "name") ?? undefined,
			colors,
			fonts: { major: latin("majorFont"), minor: latin("minorFont") },
		};
	}
	// page setup from the last sectPr
	if (pkg.has("word/document.xml")) {
		const body = findFirst(documentElement(pkg.xml("word/document.xml")), "body");
		const sect = findAll(body ?? { name: "", attrs: {}, children: [] }, "sectPr").pop();
		const pgSz = sect ? findFirst(sect, "pgSz") : undefined;
		const pgMar = sect ? findFirst(sect, "pgMar") : undefined;
		if (pgSz) {
			const w = Number(attr(pgSz, "w") ?? 0);
			const h = Number(attr(pgSz, "h") ?? 0);
			design.page = {
				...(w ? { width: Math.round(w / 15) } : {}),
				...(h ? { height: Math.round(h / 15) } : {}),
				...(attr(pgSz, "orient") === "landscape" ? { orient: "landscape" as const } : { orient: "portrait" as const }),
				...(pgMar
					? {
							margins: {
								top: Math.round(Number(attr(pgMar, "top") ?? 0) / 15),
								right: Math.round(Number(attr(pgMar, "right") ?? 0) / 15),
								bottom: Math.round(Number(attr(pgMar, "bottom") ?? 0) / 15),
								left: Math.round(Number(attr(pgMar, "left") ?? 0) / 15),
							},
						}
					: {}),
			};
		}
	}
	// style catalogue
	if (pkg.has("word/styles.xml")) {
		const styles: StyleSpec[] = [];
		for (const style of childrenNamed(documentElement(pkg.xml("word/styles.xml")), "style")) {
			const id = attr(style, "styleId");
			if (!id) continue;
			const pPr = firstChild(style, "pPr");
			const rPr = firstChild(style, "rPr");
			const sz = attr(firstChild(rPr, "sz"), "val");
			const spacing = firstChild(pPr, "spacing");
			const color = attr(firstChild(rPr, "color"), "val");
			const jc = attr(firstChild(pPr, "jc"), "val");
			styles.push({
				id,
				name: attr(firstChild(style, "name"), "val"),
				type: attr(style, "type"),
				basedOn: attr(firstChild(style, "basedOn"), "val"),
				font: attr(firstChild(rPr, "rFonts"), "ascii", "hAnsi"),
				...(sz ? { size: Number(sz) / 2 } : {}),
				...(boolProp(firstChild(rPr, "b")) ? { bold: true } : {}),
				...(boolProp(firstChild(rPr, "i")) ? { italic: true } : {}),
				...(color && color !== "auto" ? { color: `#${color}` } : {}),
				...(jc ? { align: (jc === "both" ? "justify" : jc) as Align } : {}),
				...(spacing ? { spaceBefore: Number(attr(spacing, "before") ?? 0) / 15, spaceAfter: Number(attr(spacing, "after") ?? 0) / 15, lineSpacing: Number(attr(spacing, "line") ?? 0) / 240 } : {}),
			});
		}
		design.styles = styles;
	}
	return design;
}

/** Font usage with the sizes it appears at, so generated output can reuse the mix. */
function fontTally(blocks: Block[], styles: StyleSpec[] = []): { name: string; count: number; sizes?: number[] }[] {
	const counts = new Map<string, { count: number; sizes: Set<number> }>();
	const add = (name: string | undefined, size: number | undefined) => {
		if (!name) return;
		const hit = counts.get(name) ?? { count: 0, sizes: new Set<number>() };
		hit.count++;
		if (size) hit.sizes.add(Math.round(size * 2) / 2);
		counts.set(name, hit);
	};
	for (const b of blocks) if ("runs" in b) for (const r of b.runs) add(r.font, r.size);
	for (const s of styles) add(s.font, s.size);
	return [...counts.entries()]
		.sort((a, b) => b[1].count - a[1].count)
		.slice(0, 10)
		.map(([name, info]) => ({ name, count: info.count, ...(info.sizes.size ? { sizes: [...info.sizes].sort((x, y) => y - x).slice(0, 6) } : {}) }));
}
