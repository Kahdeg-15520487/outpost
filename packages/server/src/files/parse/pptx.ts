/**
 * PPTX: no good reader library exists, so this walks the OOXML itself. It produces both halves
 * we need — readable content (titles, bullets, tables, chart data, notes) and the design model
 * (theme fonts/colours, slide size, per-shape geometry, fills, run formatting).
 */

import { posix } from "node:path";
import type { Package } from "./ooxml.ts";
import type { Align, Block, DesignInfo, ParsedImage, ParsedSlide, ParsedSlides, Run, ShapeInfo, TableCell, TableRow, ThemeInfo } from "./model.ts";
import { attr, childrenNamed, documentElement, findAll, firstChild, isNode, localName, textContent, type XmlNode } from "./xml.ts";

const findFirst = (node: XmlNode | undefined, name: string): XmlNode | undefined => (node ? findFirstDeep(node, name) : undefined);
import { mimeOf } from "./docx.ts";

const EMU = 9525;

export function parsePptx(pkg: Package, name: string, size: number): ParsedSlides {
	const notes: string[] = [];
	const images: ParsedImage[] = [];
	const theme = readTheme(pkg, "ppt/theme/theme1.xml");
	const presentation = documentElement(pkg.xml("ppt/presentation.xml"));
	const presRels = pkg.rels("ppt/presentation.xml");
	const slideSizeEl = firstChild(presentation, "sldSz");
	const slideW = Number(attr(slideSizeEl, "cx") ?? 0) / EMU || 960;
	const slideH = Number(attr(slideSizeEl, "cy") ?? 0) / EMU || 540;

	const slideParts = childrenNamed(firstChild(presentation, "sldIdLst"), "sldId")
		.map((s) => presRels.get(attr(s, "id") ?? "")?.part)
		.filter((p): p is string => Boolean(p));
	if (!slideParts.length) for (const p of pkg.names().filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort(numericCompare)) slideParts.push(p);

	const design: DesignInfo = { theme, page: { width: Math.round(slideW), height: Math.round(slideH), orient: slideW >= slideH ? "landscape" : "portrait" }, shapes: [], slides: [] };
	const slides: ParsedSlide[] = [];
	const colorUse: string[] = [];

	for (const [index, part] of slideParts.entries()) {
		const rels = pkg.rels(part);
		const slide = documentElement(pkg.xml(part));
		const cSld = firstChild(slide, "cSld");
		const background = backgroundOf(cSld, theme);
		const layout = layoutOf(pkg, part, rels);
		const blocks: Block[] = [];
		const shapeIdx: number[] = [];
		let title: string | undefined;

		const walk = (node: XmlNode, dx = 0, dy = 0, scale = 1) => {
			for (const child of node.children) {
				if (!isNode(child)) continue;
				const kind = localName(child.name);
				if (kind === "grpSp") {
					const grp = firstChild(child, "grpSpPr");
					const xfrm = firstChild(grp, "xfrm");
					const off = firstChild(xfrm, "off");
					const chOff = firstChild(xfrm, "chOff");
					const ext = firstChild(xfrm, "ext");
					const chExt = firstChild(xfrm, "chExt");
					const sx = Number(attr(ext, "cx") ?? 0) / (Number(attr(chExt, "cx") ?? 0) || 1) || 1;
					const sy = Number(attr(ext, "cy") ?? 0) / (Number(attr(chExt, "cy") ?? 0) || 1) || 1;
					walk(child, dx + (Number(attr(off, "x") ?? 0) - Number(attr(chOff, "x") ?? 0)) / EMU, dy + (Number(attr(off, "y") ?? 0) - Number(attr(chOff, "y") ?? 0)) / EMU, Math.min(sx, sy));
					continue;
				}
				if (kind !== "sp" && kind !== "pic" && kind !== "graphicFrame" && kind !== "cxnSp") continue;
				const spPr = firstChild(child, "spPr");
				const xfrm = firstChild(spPr, "xfrm");
				const off = firstChild(xfrm, "off");
				const ext = firstChild(xfrm, "ext");
				const x = Number(attr(off, "x") ?? 0) / EMU * scale + dx;
				const y = Number(attr(off, "y") ?? 0) / EMU * scale + dy;
				const w = Number(attr(ext, "cx") ?? 0) / EMU * scale;
				const h = Number(attr(ext, "cy") ?? 0) / EMU * scale;
				const fill = fillOf(spPr, theme);
				const line = lineOf(spPr, theme);
				const placeholder = attr(firstChild(firstChild(firstChild(child, "nvSpPr"), "nvPr"), "ph"), "type");
				const shapeName = attr(firstChild(firstChild(child, "nvSpPr"), "cNvPr"), "name", "descr") ?? attr(firstChild(firstChild(child, "nvPicPr"), "cNvPr"), "name", "descr");

				if (kind === "pic") {
					const blip = findFirstDeep(child, "blip");
					const embed = attr(blip, "embed");
					const imagePart = embed ? rels.get(embed)?.part : undefined;
					if (imagePart && pkg.has(imagePart)) {
						const ref = `img${images.length + 1}`;
						const bytes = pkg.bytes(imagePart);
						const mime = mimeOf(imagePart, bytes) ?? "application/octet-stream";
						images.push({ ref, name: posix.basename(imagePart), mime, bytes });
						blocks.push({ type: "image", ref, ...(shapeName ? { alt: shapeName } : {}), ...(w ? { width: Math.round(w) } : {}), ...(h ? { height: Math.round(h) } : {}) });
						const shape: ShapeInfo & { slide?: number } = { kind: "image", image: { ref }, x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h), ...(shapeName ? { name: shapeName } : {}) };
						design.shapes!.push(shape);
						shapeIdx.push(design.shapes!.length - 1);
					}
					continue;
				}

				if (kind === "graphicFrame") {
					const graphicData = findFirstDeep(child, "graphicData");
					const tbl = firstChild(graphicData, "tbl");
					if (tbl) {
						const rows = tableRows(tbl, theme);
						if (rows.length) blocks.push({ type: "table", rows });
						const widths = childrenNamed(firstChild(tbl, "tblGrid"), "gridCol").map((c) => Math.round(Number(attr(c, "w") ?? 0) / EMU));
						design.shapes!.push({ kind: "table", x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h), ...(shapeName ? { name: shapeName } : {}), table: { rows: rows.length, cols: Math.max(...rows.map((r) => r.cells.length)), ...(widths.length ? { widths } : {}) }, ...(fill ? { fill } : {}) });
						shapeIdx.push(design.shapes!.length - 1);
					}
					const chartRef = findFirstDeepOnly(child, "chart");
					const chartRid = attr(chartRef, "id");
					if (chartRid) {
						const chartPart = rels.get(chartRid)?.part;
						if (chartPart && pkg.has(chartPart)) {
							const chart = readChart(documentElement(pkg.xml(chartPart)), theme);
							design.shapes!.push({ kind: "chart", x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h), ...(shapeName ? { name: shapeName } : {}), chart });
							shapeIdx.push(design.shapes!.length - 1);
							for (const series of chart.series) {
								const values = series.values.join(", ");
								blocks.push({ type: "paragraph", runs: [{ text: `Chart ${chart.type}${series.name ? ` — ${series.name}` : ""}: ${values}${series.categories?.length ? ` (categories: ${series.categories.join(", ")})` : ""}` }] });
							}
						}
					}
					continue;
				}

				const txBody = firstChild(child, "txBody");
				if (!txBody) continue;
				const isTitle = placeholder === "title" || placeholder === "ctrTitle" || /^title/i.test(shapeName ?? "");
				const paragraphs = paragraphBlocks(txBody, theme, isTitle);
				if (isTitle) {
					const text = paragraphs.map((p) => ("runs" in p ? p.runs.map((r) => r.text).join("") : "")).join(" ").trim();
					if (text && !title) title = text;
					else blocks.push(...paragraphs);
				} else {
					blocks.push(...paragraphs);
				}
				const runFont = firstRunFont(txBody, theme);
				design.shapes!.push({
					kind: isTitle ? "title" : placeholder === "body" || placeholder === "subTitle" ? "body" : "text",
					...(shapeName ? { name: shapeName } : {}),
					...(placeholder ? { role: placeholder } : {}),
					x: Math.round(x),
					y: Math.round(y),
					w: Math.round(w),
					h: Math.round(h),
					...(fill ? { fill } : {}),
					...(line ? { line } : {}),
					...(runFont ? { font: runFont } : {}),
					text: textContent(txBody).slice(0, 200),
				});
				shapeIdx.push(design.shapes!.length - 1);
				for (const run of findAll(txBody, "rPr")) {
					const color = colorOfRun(run, theme);
					if (color) colorUse.push(color);
				}
			}
		};

		walk(firstChild(cSld, "spTree") ?? { name: "", attrs: {}, children: [] });

		const notesText = notesOf(pkg, part, rels);
		slides.push({ index: index + 1, ...(title ? { title } : {}), ...(layout ? { layout } : {}), blocks, ...(notesText ? { notes: notesText } : {}) });
		design.slides!.push({ index: index + 1, ...(layout ? { layout } : {}), ...(background ? { background } : {}), shapes: shapeIdx });
	}

	if (!slides.length) notes.push("no slides found");
	design.fonts = theme?.fonts?.major || theme?.fonts?.minor ? [{ name: theme.fonts.major ?? "", count: slides.length }, ...(theme.fonts.minor && theme.fonts.minor !== theme.fonts.major ? [{ name: theme.fonts.minor, count: slides.length }] : [])] : undefined;
	design.colors = [...new Set(colorUse)].slice(0, 12).map((value) => ({ value, count: colorUse.filter((c) => c === value).length }));

	return {
		kind: "slides",
		format: "pptx",
		name,
		size,
		engine: "ooxml",
		slides,
		images,
		stats: { slides: slides.length, images: images.length, notes: slides.filter((s) => s.notes).length },
		design,
		...(notes.length ? { notes } : {}),
	};
}

// ---------------------------------------------------------------- pieces

function numericCompare(a: string, b: string) {
	const na = Number(/(\d+)\.xml$/.exec(a)?.[1] ?? 0);
	const nb = Number(/(\d+)\.xml$/.exec(b)?.[1] ?? 0);
	return na - nb;
}

function findFirstDeep(node: XmlNode | undefined, name: string): XmlNode | undefined {
	return findFirstDeepOnly(node, name);
}

/** First descendant with that local name, but never below another graphicData-ish boundary. */
function findFirstDeepOnly(node: XmlNode | undefined, name: string): XmlNode | undefined {
	if (!node) return undefined;
	for (const child of node.children) {
		if (!isNode(child)) continue;
		if (localName(child.name) === name) return child;
		const hit = findFirstDeepOnly(child, name);
		if (hit) return hit;
	}
	return undefined;
}

function readTheme(pkg: Package, part: string): ThemeInfo | undefined {
	if (!pkg.has(part)) return undefined;
	const theme = documentElement(pkg.xml(part));
	const elements = findFirstDeep(theme, "themeElements");
	const colors: Record<string, string> = {};
	const scheme = findFirstDeep(elements ?? theme, "clrScheme");
	for (const entry of scheme?.children ?? []) {
		if (!isNode(entry)) continue;
		const srgb = findFirstDeep(entry, "srgbClr") ?? findFirstDeep(entry, "sysClr");
		const value = attr(srgb, "val", "lastClr");
		if (value) colors[localName(entry.name)] = `#${value.replace(/^#/, "")}`;
	}
	const fontScheme = findFirstDeep(elements ?? theme, "fontScheme");
	const latin = (n: string) => attr(findFirstDeep(findFirstDeep(fontScheme, n), "latin"), "typeface");
	const name = attr(theme, "name") ?? attr(findFirstDeep(theme, "theme"), "name");
	return { ...(name ? { name } : {}), colors, fonts: { major: latin("majorFont"), minor: latin("minorFont") } };
}

const schemeColor = (theme: ThemeInfo | undefined, val: string | undefined): string | undefined => {
	if (!val) return undefined;
	if (val === "tx1" || val === "dk1") return theme?.colors?.dk1;
	if (val === "bg1" || val === "lt1") return theme?.colors?.lt1;
	if (val === "tx2" || val === "dk2") return theme?.colors?.dk2;
	if (val === "bg2" || val === "lt2") return theme?.colors?.lt2;
	return theme?.colors?.[val];
};

function colorOfRun(node: XmlNode | undefined, theme: ThemeInfo | undefined): string | undefined {
	if (!node) return undefined;
	const srgb = findFirstDeep(node, "srgbClr");
	const hex = attr(srgb, "val");
	if (hex) return `#${hex}`;
	const scheme = findFirstDeep(node, "schemeClr");
	return schemeColor(theme, attr(scheme, "val"));
}

function fillOf(spPr: XmlNode | undefined, theme: ThemeInfo | undefined): string | undefined {
	if (!spPr) return undefined;
	const solid = firstChild(spPr, "solidFill");
	if (solid) return colorOfRun(solid, theme);
	const grad = firstChild(spPr, "gradFill");
	if (grad) {
		const stop = findFirstDeep(grad, "gs");
		return colorOfRun(stop, theme);
	}
	const noFill = firstChild(spPr, "noFill");
	return noFill ? "none" : undefined;
}

function lineOf(spPr: XmlNode | undefined, theme: ThemeInfo | undefined): string | undefined {
	const ln = firstChild(spPr, "ln");
	if (!ln) return undefined;
	if (firstChild(ln, "noFill")) return "none";
	return colorOfRun(ln, theme);
}

function backgroundOf(cSld: XmlNode | undefined, theme: ThemeInfo | undefined): string | undefined {
	const bg = firstChild(cSld, "bg");
	if (!bg) return undefined;
	return colorOfRun(firstChild(bg, "bgPr") ?? bg, theme);
}

function paragraphBlocks(txBody: XmlNode, theme: ThemeInfo | undefined, isTitle: boolean): Block[] {
	const blocks: Block[] = [];
	for (const p of childrenNamed(txBody, "p")) {
		const pPr = firstChild(p, "pPr");
		const lvl = Number(attr(pPr, "lvl") ?? 0);
		const algn = attr(pPr, "algn");
		const bullet = firstChild(pPr, "buChar") ?? firstChild(pPr, "buAutoNum");
		const runs: Run[] = [];
		for (const child of p.children) {
			if (!isNode(child)) continue;
			const kind = localName(child.name);
			if (kind === "r") {
				const rPr = firstChild(child, "rPr");
				const text = textContent(firstChild(child, "t"));
				if (!text) continue;
				const sz = attr(rPr, "sz");
				const color = colorOfRun(rPr, theme);
				const font = attr(firstChild(rPr, "latin"), "typeface");
				runs.push({
					text,
					...(attr(rPr, "b") === "1" ? { bold: true } : {}),
					...(attr(rPr, "i") === "1" ? { italic: true } : {}),
					...(attr(rPr, "u") && attr(rPr, "u") !== "none" ? { underline: true } : {}),
					...(attr(rPr, "strike") && attr(rPr, "strike") !== "noStrike" ? { strike: true } : {}),
					...(sz ? { size: Number(sz) / 100 } : {}),
					...(color ? { color } : {}),
					...(font ? { font } : {}),
				});
			} else if (kind === "br") runs.push({ text: "\n" });
			else if (kind === "fld") {
				const t = textContent(firstChild(child, "t"));
				if (t) runs.push({ text: t });
			}
		}
		if (!runs.length) continue;
		const text = runs.map((r) => r.text).join("");
		if (isTitle) {
			blocks.push({ type: "heading", level: 2, runs });
			continue;
		}
		if (bullet) blocks.push({ type: "paragraph", runs, list: { level: lvl, ordered: Boolean(firstChild(pPr, "buAutoNum")), ...(firstChild(pPr, "buChar") ? { marker: attr(firstChild(pPr, "buChar"), "char") ?? "•" } : {}) } });
		else blocks.push({ type: "paragraph", runs, ...(algn ? { align: (algn === "ctr" ? "center" : algn === "r" ? "right" : algn === "just" ? "justify" : "left") as Align } : {}), ...(lvl ? { indent: lvl * 18 } : {}) });
		void text;
	}
	return blocks;
}

function tableRows(tbl: XmlNode, theme: ThemeInfo | undefined): TableRow[] {
	const rows: TableRow[] = [];
	for (const tr of childrenNamed(tbl, "tr")) {
		const cells: TableCell[] = [];
		for (const tc of childrenNamed(tr, "tc")) {
			const blocks = paragraphBlocks(firstChild(tc, "txBody") ?? { name: "", attrs: {}, children: [] }, theme, false);
			const fill = fillOf(firstChild(tc, "tcPr"), theme);
			cells.push({ blocks: blocks.length ? blocks : [{ type: "paragraph", runs: [{ text: "" }] }], ...(fill && fill !== "none" ? { header: true } : {}) });
		}
		if (cells.length) rows.push({ cells, ...(cells.every((c) => c.header) ? { header: true } : {}) });
	}
	return rows;
}

function firstRunFont(txBody: XmlNode, theme: ThemeInfo | undefined): ShapeInfo["font"] {
	const rPr = findFirstDeep(txBody, "rPr");
	if (!rPr) return undefined;
	const sz = attr(rPr, "sz");
	const color = colorOfRun(rPr, theme);
	const font = attr(firstChild(rPr, "latin"), "typeface");
	const align = attr(firstChild(txBody, "pPr"), "algn");
	return {
		...(font ? { name: font } : {}),
		...(sz ? { size: Number(sz) / 100 } : {}),
		...(color ? { color } : {}),
		...(attr(rPr, "b") === "1" ? { bold: true } : {}),
		...(attr(rPr, "i") === "1" ? { italic: true } : {}),
		...(align ? { align: (align === "ctr" ? "center" : align === "r" ? "right" : "left") as Align } : {}),
	};
}

function readChart(chart: XmlNode, theme: ThemeInfo | undefined): NonNullable<ShapeInfo["chart"]> {
	const plot = findFirstDeep(chart, "plotArea");
	const typeEl = (plot?.children ?? []).find((c): c is XmlNode => isNode(c) && /chart$/i.test(localName(c.name)) && localName(c.name) !== "chart");
	const type = typeEl ? localName(typeEl.name).replace(/Chart$/, "") : "chart";
	const series: NonNullable<ShapeInfo["chart"]>["series"] = [];
	for (const ser of childrenNamed(typeEl, "ser")) {
		const nameText = textContent(findFirstDeep(firstChild(ser, "tx") ?? ser, "v"));
		const values = childrenNamed(findFirstDeep(firstChild(ser, "val") ?? ser, "numCache"), "pt")
			.map((pt) => Number(textContent(firstChild(pt, "v"))))
			.filter((n) => Number.isFinite(n));
		const cat = firstChild(ser, "cat") ?? ser;
		const cache = findFirstDeep(cat, "multiLvlStrCache") ?? findFirstDeep(cat, "strCache") ?? findFirstDeep(cat, "numCache") ?? findFirstDeep(cat, "strLit") ?? findFirstDeep(cat, "numLit") ?? cat;
		const categories = [...findAll(cache, "pt")]
			.map((pt) => textContent(firstChild(pt, "v")))
			.filter(Boolean);
		series.push({ ...(nameText ? { name: nameText } : {}), values, ...(categories.length ? { categories } : {}) });
	}
	void theme;
	return { type, series };
}

function layoutOf(pkg: Package, slidePart: string, rels: Map<string, { type: string; part?: string }>): string | undefined {
	for (const rel of rels.values()) {
		if (!rel.type.endsWith("/slideLayout") || !rel.part || !pkg.has(rel.part)) continue;
		const layout = documentElement(pkg.xml(rel.part));
		const name = attr(firstChild(layout, "cSld"), "name");
		if (name) return name;
	}
	return undefined;
}

function notesOf(pkg: Package, slidePart: string, rels: Map<string, { type: string; part?: string }>): string | undefined {
	for (const rel of rels.values()) {
		if (!rel.type.endsWith("/notesSlide") || !rel.part || !pkg.has(rel.part)) continue;
		const notes = documentElement(pkg.xml(rel.part));
		const texts: string[] = [];
		for (const sp of findAll(notes, "sp")) {
			const ph = attr(firstChild(firstChild(sp, "nvSpPr"), "nvPr"), "type");
			if (ph === "sldNum" || ph === "hdr" || ph === "ftr" || ph === "dt") continue;
			const text = textContent(firstChild(sp, "txBody")).trim();
			if (text) texts.push(text);
		}
		const joined = texts
			.filter((t) => !/^\s*\d+\s*$/.test(t))
			.join("\n")
			.replace(/\n\s*\d+\s*$/, "")
			.trim();
		if (joined) return joined;
	}
	return undefined;
}

/** Kept for tests: the shape tree can be large, so cap what we expose as design data. */
export const MAX_SHAPES = 5_000;