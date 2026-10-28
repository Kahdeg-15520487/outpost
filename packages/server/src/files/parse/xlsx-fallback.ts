/**
 * Fallback workbook reader. ExcelJS is the normal path, but it rejects some real-world files
 * ("Unexpected xml node in parseOpen" on certain workbook parts). This reads the same package
 * directly: shared strings, styles (for dates), cell types, formulas, merges and widths.
 */

import type { Package } from "./ooxml.ts";
import type { ParsedSheet, ParsedSheets, SheetCell } from "./model.ts";
import { attr, childrenNamed, documentElement, firstChild, isNode, localName, textContent } from "./xml.ts";
import { serialToIso } from "./xlsx.ts";

const DATE_FORMAT_IDS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 30, 36, 45, 46, 47, 50, 57]);
const colIndex = (ref: string): number => {
	const letters = /^([A-Z]+)/.exec(ref)?.[1] ?? "A";
	let n = 0;
	for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
	return n - 1;
};
const rowIndex = (ref: string): number => Number(/(\d+)$/.exec(ref)?.[1] ?? 1) - 1;

export function readXlsxFallback(pkg: Package, name: string, size: number, reason: string): ParsedSheets {
	const workbookPart = [...pkg.rootRels().values()].find((r) => r.type.endsWith("/officeDocument"))?.part ?? "xl/workbook.xml";
	const workbook = documentElement(pkg.xml(workbookPart));
	const rels = pkg.rels(workbookPart);
	const notes = [`ExcelJS could not read this workbook (${reason}); parsed with the OOXML reader`];

	// shared strings
	const shared: string[] = [];
	if (pkg.has("xl/sharedStrings.xml")) {
		for (const si of childrenNamed(documentElement(pkg.xml("xl/sharedStrings.xml")), "si")) {
			shared.push(childrenNamed(si, "t").map((t) => textContent(t)).join("") || textContent(si));
		}
	}

	// styles: which xf indexes are dates
	const dateXf = new Set<number>();
	const customFormats = new Map<number, string>();
	if (pkg.has("xl/styles.xml")) {
		const styles = documentElement(pkg.xml("xl/styles.xml"));
		for (const fmt of childrenNamed(firstChild(styles, "numFmts"), "numFmt")) {
			const id = Number(attr(fmt, "numFmtId") ?? 0);
			const code = attr(fmt, "formatCode") ?? "";
			if (id) customFormats.set(id, code);
		}
		childrenNamed(firstChild(styles, "cellXfs"), "xf").forEach((xf, i) => {
			const id = Number(attr(xf, "numFmtId") ?? 0);
			const code = customFormats.get(id);
			const isDate = DATE_FORMAT_IDS.has(id) || (code ? /[ymd]/i.test(code.replace(/\[[^\]]*\]/g, "").replace(/"[^"]*"/g, "")) && !/^[#0.,%]+$/.test(code) : false);
			if (isDate) dateXf.add(i);
		});
	}

	const date1904 = attr(firstChild(documentElement(pkg.xml(workbookPart)), "workbookPr"), "date1904") === "1";
	const sheets: ParsedSheet[] = [];
	const entry = childrenNamed(workbook, "sheets")[0];
	for (const [index, sheet] of childrenNamed(entry, "sheet").entries()) {
		const sheetName = attr(sheet, "name") ?? `Sheet${index + 1}`;
		const relId = attr(sheet, "id");
		const part = relId ? rels.get(relId)?.part : undefined;
		const state = attr(sheet, "state");
		if (!part || !pkg.has(part)) {
			sheets.push({ name: sheetName, index, rows: 0, cols: 0, cells: [], merged: [], ...(state && state !== "visible" ? { hidden: true } : {}) });
			continue;
		}
		const ws = documentElement(pkg.xml(part));
		const cells: SheetCell[] = [];
		const merged = childrenNamed(firstChild(ws, "mergeCells"), "mergeCell").map((m) => attr(m, "ref") ?? "").filter(Boolean);
		const widths = childrenNamed(firstChild(ws, "cols"), "col")
			.map((c) => Number(attr(c, "width") ?? 0))
			.filter((w) => w > 0);
		let maxRow = 0;
		let maxCol = 0;
		for (const row of childrenNamed(firstChild(ws, "sheetData"), "row")) {
			for (const c of childrenNamed(row, "c")) {
				const ref = attr(c, "r") ?? "";
				if (!ref) continue;
				const r = rowIndex(ref);
				const col = colIndex(ref);
				maxRow = Math.max(maxRow, r);
				maxCol = Math.max(maxCol, col);
				const type = attr(c, "t");
				const styleIndex = Number(attr(c, "s") ?? 0);
				const formula = textContent(firstChild(c, "f")) || undefined;
				const raw = firstChild(c, "v") !== undefined ? textContent(firstChild(c, "v")) : undefined;
				const inline = firstChild(c, "is") ? textContent(firstChild(c, "is")) : undefined;
				let value: SheetCell["value"] = null;
				let cellType: SheetCell["type"] = "empty";
				if (type === "s" && raw !== undefined) {
					value = shared[Number(raw)] ?? "";
					cellType = "string";
				} else if (type === "inlineStr") {
					value = inline ?? "";
					cellType = "string";
				} else if (type === "str") {
					value = raw ?? "";
					cellType = "string";
				} else if (type === "b") {
					value = raw === "1";
					cellType = "boolean";
				} else if (type === "e") {
					value = raw ?? "";
					cellType = "error";
				} else if (raw !== undefined && raw !== "") {
					const num = Number(raw);
					if (dateXf.has(styleIndex) && Number.isFinite(num)) {
						value = serialToIso(num, date1904);
						cellType = "date";
					} else if (Number.isFinite(num)) {
						value = num;
						cellType = "number";
					} else {
						value = raw;
						cellType = "string";
					}
				}
				if (cellType === "empty" && !formula) continue;
				const fmt = customFormats.get(Number(attr(firstChild(c, "extLst") ?? c, "numFmtId") ?? 0));
				cells.push({ ref, row: r, col, value, type: cellType, ...(formula ? { formula } : {}), ...(fmt ? { format: fmt } : {}) });
			}
		}
		const dimension = attr(firstChild(ws, "dimension"), "ref");
		const dim = dimension?.split(":")[1];
		sheets.push({
			name: sheetName,
			index,
			...(state && state !== "visible" ? { hidden: true } : {}),
			rows: dim ? rowIndex(dim) + 1 : maxRow + 1,
			cols: dim ? colIndex(dim) + 1 : maxCol + 1,
			cells,
			merged,
			...(widths.length ? { widths } : {}),
		});
	}

	return {
		kind: "sheets",
		format: "xlsx",
		name,
		size,
		engine: "ooxml",
		sheets,
		images: [],
		stats: { sheets: sheets.length, cells: sheets.reduce((a, s) => a + s.cells.length, 0), formulas: sheets.reduce((a, s) => a + s.cells.filter((c) => c.formula).length, 0) },
		notes,
	};
}
