/**
 * HTML → blocks. mammoth gives docx content as semantic HTML; this turns that (and any HTML
 * file a user uploads) into the same block model the other parsers emit, keeping inline
 * formatting, list nesting, table spans, links and images.
 */

import { parseDocument } from "htmlparser2";
import type { Block, ParsedImage, Run, TableCell, TableRow } from "./model.ts";

interface Elem {
	type: string;
	name: string;
	attribs: Record<string, string>;
	children: DomNode[];
}
interface TextNode {
	type: "text";
	data: string;
}
type DomNode = Elem | TextNode | { type: string };

const isElem = (n: DomNode): n is Elem => typeof (n as Elem).name === "string";
const isText = (n: DomNode): n is TextNode => n.type === "text" && typeof (n as TextNode).data === "string";

const BLOCK_TAGS = new Set([
	"address", "article", "aside", "blockquote", "div", "dl", "fieldset", "figure", "footer", "form", "header", "main", "nav", "ol", "p", "pre", "section", "table", "ul", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "li",
]);

export interface HtmlParseOptions {
	images?: ParsedImage[];
	refPrefix?: string;
}

export function decodeDataUri(src: string): { mime: string; bytes: Buffer } | undefined {
	const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(src);
	if (!m) return undefined;
	const mime = m[1] || "application/octet-stream";
	const body = m[3] ?? "";
	return { mime, bytes: m[2] ? Buffer.from(body, "base64") : Buffer.from(decodeURIComponent(body), "binary") };
}

export function htmlToBlocks(html: string, opts: HtmlParseOptions = {}): { blocks: Block[]; images: ParsedImage[] } {
	const images = opts.images ?? [];
	const refPrefix = opts.refPrefix ?? "img";
	const doc = parseDocument(html, { decodeEntities: true }) as unknown as { children: DomNode[] };

	const imageFrom = (src: string, alt?: string, width?: number, height?: number): string | undefined => {
		if (!src) return undefined;
		const data = src.startsWith("data:") ? decodeDataUri(src) : undefined;
		const ref = `${refPrefix}${images.length + 1}`;
		if (!data) {
			images.push({ ref, name: src.slice(0, 200), mime: "text/uri-list", bytes: Buffer.from(src), ...(alt ? { alt } : {}) });
			return ref;
		}
		const ext = data.mime.split("/")[1]?.replace("+xml", "") ?? "bin";
		images.push({ ref, name: `${ref}.${ext}`, mime: data.mime, bytes: data.bytes, ...(width ? { width } : {}), ...(height ? { height } : {}), ...(alt ? { alt } : {}) });
		return ref;
	};

	const inline = (nodes: DomNode[], style: Partial<Run> = {}): Run[] => {
		const runs: Run[] = [];
		for (const node of nodes) {
			if (isText(node)) {
				const text = node.data.replace(/\s+/g, " ");
				if (text) runs.push({ ...style, text });
				continue;
			}
			if (!isElem(node)) continue;
			const name = node.name.toLowerCase();
			const attrs = node.attribs ?? {};
			if (name === "br") {
				runs.push({ text: "\n" });
				continue;
			}
			if (name === "img") {
				const ref = imageFrom(attrs.src ?? "", attrs.alt, attrs.width ? Number(attrs.width) : undefined, attrs.height ? Number(attrs.height) : undefined);
				if (ref) runs.push({ text: `\u0000IMG:${ref}\u0000` });
				continue;
			}
			const next: Partial<Run> = { ...style };
			if (name === "strong" || name === "b") next.bold = true;
			if (name === "em" || name === "i") next.italic = true;
			if (name === "u" || name === "ins") next.underline = true;
			if (name === "s" || name === "strike" || name === "del") next.strike = true;
			if (name === "code" || name === "kbd" || name === "samp" || name === "tt") next.code = true;
			if (name === "sup") next.sup = true;
			if (name === "sub") next.sub = true;
			if (name === "a" && attrs.href) next.link = attrs.href;
			const color = /color:\s*([^;]+)/i.exec(attrs.style ?? "")?.[1]?.trim();
			if (color) next.color = color;
			runs.push(...inline(node.children ?? [], next));
		}
		return mergeRuns(runs);
	};

	const blocksFrom = (nodes: DomNode[], listLevel = 0): Block[] => {
		const out: Block[] = [];
		for (const node of nodes) {
			if (isText(node)) {
				const text = node.data.replace(/\s+/g, " ").trim();
				if (text) out.push({ type: "paragraph", runs: [{ text }] });
				continue;
			}
			if (!isElem(node)) continue;
			const name = node.name.toLowerCase();
			const attrs = node.attribs ?? {};
			const kids = node.children ?? [];
			if (/^h[1-6]$/.test(name)) {
				out.push({ type: "heading", level: Number(name[1]), runs: inline(kids) });
			} else if (name === "p") {
				const runs = inline(kids);
				if (runs.length) out.push({ type: "paragraph", runs });
			} else if (name === "ul" || name === "ol") {
				const ordered = name === "ol";
				for (const child of kids) {
					if (!isElem(child) || child.name.toLowerCase() !== "li") continue;
					const liKids = child.children ?? [];
					const nested = liKids.filter((c) => isElem(c) && ["ul", "ol"].includes(c.name.toLowerCase()));
					const rest = liKids.filter((c) => !(isElem(c) && ["ul", "ol"].includes(c.name.toLowerCase())));
					const runs = inline(rest);
					if (runs.length || !nested.length) {
						const list = { level: listLevel, ordered, ...(ordered ? {} : { marker: "•" }) };
						out.push({ type: "paragraph", runs: runs.length ? runs : [{ text: "" }], list });
					}
					for (const n of nested) if (isElem(n)) out.push(...blocksFrom([n], listLevel + 1));
				}
			} else if (name === "table") {
				const rows: TableRow[] = [];
				const collectRows = (n: Elem): void => {
					for (const c of n.children ?? []) {
						if (!isElem(c)) continue;
						const childName = c.name.toLowerCase();
						if (childName === "tr") {
							const cells: TableCell[] = [];
							for (const cell of c.children ?? []) {
								if (!isElem(cell) || !["td", "th"].includes(cell.name.toLowerCase())) continue;
								const span = Number(cell.attribs?.colspan ?? 1);
								const rowSpan = Number(cell.attribs?.rowspan ?? 1);
								cells.push({
									blocks: blocksFrom(cell.children ?? [], listLevel),
									...(span > 1 ? { colSpan: span } : {}),
									...(rowSpan > 1 ? { rowSpan } : {}),
									...(cell.name.toLowerCase() === "th" ? { header: true } : {}),
								});
							}
							if (cells.length) rows.push({ cells, ...(cells.some((c) => c.header) ? { header: true } : {}) });
						} else if (["thead", "tbody", "tfoot"].includes(childName)) collectRows(c);
					}
				};
				collectRows(node);
				if (rows.length) out.push({ type: "table", rows });
			} else if (name === "pre") {
				out.push({ type: "code", text: textOf(kids).replace(/\n$/, "") });
			} else if (name === "blockquote") {
				out.push({ type: "quote", blocks: blocksFrom(kids, listLevel) });
			} else if (name === "hr") {
				out.push({ type: "break" });
			} else if (name === "img") {
				const ref = imageFrom(attrs.src ?? "", attrs.alt);
				if (ref) out.push({ type: "image", ref, ...(attrs.alt ? { alt: attrs.alt } : {}) });
			} else if (BLOCK_TAGS.has(name)) {
				out.push(...blocksFrom(kids, listLevel));
			} else {
				const runs = inline([node]);
				if (runs.length) out.push({ type: "paragraph", runs });
			}
		}
		return splitImages(out);
	};

	/** Paragraphs that contain an embedded image become separate image blocks. */
	const splitImages = (blocks: Block[]): Block[] =>
		blocks.flatMap((block) => {
			if (block.type !== "paragraph") return [block];
			const parts: Block[] = [];
			let buffer: Run[] = [];
			const flush = () => {
				if (buffer.some((r) => r.text.trim())) parts.push({ ...block, runs: mergeRuns(buffer) });
				buffer = [];
			};
			for (const run of block.runs) {
				const pieces = run.text.split(/\u0000IMG:([^\u0000]+)\u0000/);
				for (const piece of pieces) {
					if (!piece) continue;
					const image = images.find((i) => i.ref === piece);
					if (image) {
						flush();
						parts.push({ type: "image", ref: image.ref, ...(image.alt ? { alt: image.alt } : {}), ...(image.width ? { width: image.width } : {}), ...(image.height ? { height: image.height } : {}) });
					} else buffer.push({ ...run, text: piece });
				}
			}
			flush();
			return parts;
		});

	return { blocks: blocksFrom(doc.children ?? []), images };
}

function textOf(nodes: DomNode[]): string {
	let out = "";
	for (const node of nodes) {
		if (isText(node)) out += node.data;
		else if (isElem(node)) out += textOf(node.children ?? []);
	}
	return out;
}

function mergeRuns(runs: Run[]): Run[] {
	const out: Run[] = [];
	for (const run of runs) {
		const last = out[out.length - 1];
		if (last && sameStyle(last, run)) last.text += run.text;
		else out.push({ ...run });
	}
	return out;
}

const sameStyle = (a: Run, b: Run) =>
	a.bold === b.bold && a.italic === b.italic && a.underline === b.underline && a.strike === b.strike && a.code === b.code && a.sup === b.sup && a.sub === b.sub && a.link === b.link && a.color === b.color;
