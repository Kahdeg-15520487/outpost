/**
 * XLSX via ExcelJS: every sheet with its real values, formulas, number formats, merges, widths,
 * freeze panes and hidden state, plus the workbook's visual style (header fills, fonts) so a
 * later generator can reproduce the look. CSV/TSV come through the same sheet model.
 */

import type ExcelJS from "exceljs";
import { tally, type DesignInfo, type ParsedImage, type ParsedSheets, type SheetCell } from "./model.ts";

const MAX_SHEETS = 60;
const MAX_CELLS = 400_000;

/** Excel serial date → ISO, honouring the 1900 leap-year bug and the 1904 system flag. */
export function serialToIso(serial: number, date1904 = false): string {
	const epoch = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
	const ms = epoch + Math.round(serial * 86_400_000);
	return new Date(ms).toISOString();
}

const isDateFormat = (fmt: string | undefined): boolean => {
	if (!fmt) return false;
	if (/^\[?-?h{1,2}:mm/.test(fmt)) return false;
	const cleaned = fmt.replace(/\[[^\]]*\]/g, "").replace(/"[^"]*"/g, "");
	return /[ymd]/i.test(cleaned) && !/^[#0.,%]+$/.test(cleaned);
};

type CellValue = string | number | boolean | null;

function cellOf(cell: ExcelJS.Cell, date1904: boolean): SheetCell | undefined {
	const row = Number(cell.row) - 1;
	const col = Number(cell.col) - 1;
	const ref = cell.address;
	const raw = cell.value as unknown;
	let value: CellValue = null;
	let type: SheetCell["type"] = "empty";
	let formula: string | undefined;
	let link: string | undefined;

	const asText = (v: unknown): string => {
		if (v === null || v === undefined) return "";
		if (typeof v === "string") return v;
		if (typeof v === "number" || typeof v === "boolean") return String(v);
		if (v instanceof Date) return v.toISOString();
		if (typeof v === "object") {
			const o = v as Record<string, unknown>;
			if (Array.isArray(o.richText)) return (o.richText as { text?: string }[]).map((t) => t.text ?? "").join("");
			if (typeof o.text === "string") return o.text;
			if (typeof o.error === "string") return o.error;
			if ("result" in o) return asText(o.result);
		}
		return String(v);
	};

	if (raw === null || raw === undefined) {
		if (!cell.formula) return undefined;
	}
	if (raw && typeof raw === "object") {
		const o = raw as Record<string, unknown>;
		if (typeof o.formula === "string") formula = o.formula;
		else if (typeof o.sharedFormula === "string") formula = o.sharedFormula;
		if (typeof o.hyperlink === "string") {
			link = o.hyperlink;
			value = asText(o.text ?? o.hyperlink);
			type = "string";
		} else if (typeof o.error === "string") {
			value = o.error;
			type = "error";
		} else if (Array.isArray(o.richText)) {
			value = asText(o);
			type = "string";
		} else if (formula) {
			value = asText(o.result);
			type = typeof o.result === "boolean" ? "boolean" : typeof o.result === "number" ? "number" : "string";
		} else if (raw instanceof Date) {
			value = raw.toISOString();
			type = "date";
		} else {
			value = asText(raw);
			type = "string";
		}
	} else if (raw instanceof Date) {
		value = raw.toISOString();
		type = "date";
	} else if (typeof raw === "number") {
		if (isDateFormat(cell.numFmt)) {
			value = serialToIso(raw, date1904);
			type = "date";
		} else {
			value = raw;
			type = "number";
		}
	} else if (typeof raw === "boolean") {
		value = raw;
		type = "boolean";
	} else if (typeof raw === "string") {
		value = raw;
		type = "string";
	}

	if (type === "empty" && formula) type = "string";
	if (type === "empty" && (value === null || value === "")) {
		if (!formula) return undefined;
	}
	const fmt = cell.numFmt ?? undefined;
	return { ref, row, col, value, type, ...(formula ? { formula } : {}), ...(fmt ? { format: fmt } : {}), ...(link ? { link } : {}) };
}

export async function parseXlsx(data: Buffer, name: string, size: number): Promise<ParsedSheets> {
	let wb: ExcelJS.Workbook;
	try {
		const ExcelJSmod = (await import("exceljs")).default;
		wb = new ExcelJSmod.Workbook();
		await wb.xlsx.load(data as unknown as ExcelJS.Buffer);
	} catch (error) {
		// ExcelJS rejects some real-world packages; the OOXML reader still gets the data out.
		const { openPackage } = await import("./ooxml.ts");
		const { readXlsxFallback } = await import("./xlsx-fallback.ts");
		return readXlsxFallback(openPackage(data), name, size, (error as Error).message);
	}

	const notes: string[] = [];
	const images: ParsedImage[] = [];
	const sheets: ParsedSheets["sheets"] = [];
	const design: DesignInfo = { sheets: [] };
	let cellBudget = MAX_CELLS;
	let date1904 = false;
	try {
		// workbook properties expose the date system on the model (`properties.date1904`)
		date1904 = Boolean((wb as unknown as { properties?: { date1904?: boolean } }).properties?.date1904);
	} catch {
		/* not exposed in every version */
	}

	for (const [index, ws] of wb.worksheets.entries()) {
		if (index >= MAX_SHEETS) {
			notes.push(`only the first ${MAX_SHEETS} sheets were parsed`);
			break;
		}
		const cells: SheetCell[] = [];
		const fonts: string[] = [];
		const fills: string[] = [];
		const sizes: number[] = [];
		let formulas = 0;
		let capped = false;
		ws.eachRow({ includeEmpty: false }, (row) => {
			if (capped) return;
			row.eachCell({ includeEmpty: false }, (cell) => {
				if (capped) return;
				if (cellBudget-- <= 0) {
					capped = true;
					return;
				}
				const parsed = cellOf(cell, date1904);
				if (parsed) {
					if (parsed.formula) formulas++;
					cells.push(parsed);
				}
				if (row.number <= 3) {
					const font = cell.font?.name;
					if (font) fonts.push(font);
					const fill = cell.fill as { fgColor?: { argb?: string } } | undefined;
					if (fill?.fgColor?.argb) fills.push(`#${fill.fgColor.argb.slice(-6)}`);
					if (cell.font?.size) sizes.push(cell.font.size);
				}
			});
		});
		if (capped) notes.push(`${ws.name}: stopped at ${MAX_CELLS} cells across the workbook`);

		const merges = (ws as unknown as { model?: { merges?: string[] } }).model?.merges ?? [];
		const widths = ws.columns?.map((c) => c.width ?? 0).filter((w) => w > 0);
		const view = ws.views?.[0];
		const freeze = view && view.state === "frozen" && typeof view.ySplit === "number" && view.ySplit > 0 ? `A${view.ySplit + 1}` : undefined;
		const autoFilter = typeof ws.autoFilter === "string" ? ws.autoFilter : undefined;

		// images anchored in this sheet
		for (const image of ws.getImages()) {
			const media = wb.getImage(Number(image.imageId));
			if (!media?.buffer) continue;
			const ext = media.extension ?? "png";
			const bytes = Buffer.from(media.buffer as ArrayBuffer);
			const ref = `img${images.length + 1}`;
			const tl = image.range.tl;
			images.push({ ref, name: `${ws.name}!image${images.length + 1}.${ext}`, mime: `image/${ext}`, bytes });
			design.shapes = design.shapes ?? [];
			design.shapes.push({ kind: "image", name: `${ws.name} image`, image: { ref }, ...(tl?.nativeCol !== undefined ? { x: tl.nativeCol * 60, y: (tl.nativeRow ?? 0) * 20 } : {}) });
		}

		sheets.push({
			name: ws.name,
			index,
			...(ws.state && ws.state !== "visible" ? { hidden: true } : {}),
			rows: ws.rowCount ?? 0,
			cols: ws.columnCount ?? Math.max(0, ...cells.map((c) => c.col + 1)),
			cells,
			merged: merges,
			...(widths?.length ? { widths } : {}),
			...(freeze ? { freeze } : {}),
			...(autoFilter ? { autoFilter } : {}),
		});
		design.sheets!.push({
			name: ws.name,
			...(fills.length ? { headerFill: tally(fills, 1)[0]?.value } : {}),
			...(fonts.length ? { headerFont: tally(fonts, 1)[0]?.value } : {}),
			...(widths?.length ? { widths } : {}),
			...(freeze ? { freeze } : {}),
			...(autoFilter ? { autoFilter } : {}),
		});
		design.fonts = mergeFonts(design.fonts, tally(fonts, 6), sizes);
		design.colors = tally([...(design.colors ?? []).map((c) => c.value), ...fills], 10);
	}

	if (!sheets.length) notes.push("workbook has no visible sheets");

	return {
		kind: "sheets",
		format: "xlsx",
		name,
		size,
		engine: "exceljs",
		sheets,
		images,
		stats: { sheets: sheets.length, cells: sheets.reduce((a, s) => a + s.cells.length, 0), formulas: sheets.reduce((a, s) => a + s.cells.filter((c) => c.formula).length, 0) },
		design,
		...(notes.length ? { notes } : {}),
	};
}

function mergeFonts(existing: DesignInfo["fonts"], add: { value: string; count: number }[], sizes: number[]) {
	const map = new Map<string, { count: number; sizes: Set<number> }>();
	for (const f of existing ?? []) map.set(f.name, { count: f.count, sizes: new Set(f.sizes ?? []) });
	for (const f of add) {
		const hit = map.get(f.value) ?? { count: 0, sizes: new Set<number>() };
		hit.count += f.count;
		for (const s of sizes) hit.sizes.add(s);
		map.set(f.value, hit);
	}
	return [...map.entries()].map(([name, info]) => ({ name, count: info.count, ...(info.sizes.size ? { sizes: [...info.sizes].sort((a, b) => b - a).slice(0, 6) } : {}) }));
}

/** Delimited text as a one-sheet workbook, so CSV gets the same tools as XLSX. */
export function parseDelimited(text: string, name: string, size: number, delimiter: "," | "\t"): ParsedSheets {
	const rows = splitDelimited(text, delimiter);
	const cells: SheetCell[] = [];
	let cols = 0;
	rows.forEach((row, r) => {
		cols = Math.max(cols, row.length);
		row.forEach((raw, c) => {
			if (raw === "") return;
			const numeric = /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(raw);
			const date = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?)?$/.test(raw);
			cells.push({
				ref: `${colName(c)}${r + 1}`,
				row: r,
				col: c,
				value: date ? raw : numeric ? Number(raw) : raw,
				type: date ? "date" : numeric ? "number" : "string",
			});
		});
	});
	return {
		kind: "sheets",
		format: delimiter === "\t" ? "tsv" : "csv",
		name,
		size,
		engine: "delimited",
		sheets: [{ name: name.replace(/\.[^.]+$/, "").slice(0, 30) || "Sheet1", index: 0, rows: rows.length, cols, cells, merged: [] }],
		images: [],
		stats: { sheets: 1, cells: cells.length, formulas: 0 },
	};
}

export const colName = (index: number): string => {
	let n = index + 1;
	let out = "";
	while (n > 0) {
		const rem = (n - 1) % 26;
		out = String.fromCharCode(65 + rem) + out;
		n = Math.floor((n - 1) / 26);
	}
	return out;
};

function splitDelimited(text: string, delimiter: string): string[][] {
	const rows: string[][] = [];
	let row: string[] = [];
	let field = "";
	let quoted = false;
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (quoted) {
			if (c === '"') {
				if (text[i + 1] === '"') {
					field += '"';
					i++;
				} else quoted = false;
			} else field += c;
			continue;
		}
		if (c === '"') quoted = true;
		else if (c === delimiter) {
			row.push(field);
			field = "";
		} else if (c === "\n" || c === "\r") {
			if (c === "\r" && text[i + 1] === "\n") i++;
			row.push(field);
			rows.push(row);
			row = [];
			field = "";
		} else field += c;
	}
	if (field || row.length) {
		row.push(field);
		rows.push(row);
	}
	return rows;
}
