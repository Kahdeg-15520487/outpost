/**
 * Grids for the inline table view: dense rows out of the parsed sheet cells, column typing,
 * sorting, filtering, a copy-able TSV and the series behind the chart. No React, no DOM — so
 * the browser and the test suite run exactly the same code.
 */

export type Cell = string | number | boolean | null;
export type Grid = { header: string[]; rows: Cell[][]; sheet?: string };
export type ColKind = "number" | "date" | "boolean" | "text" | "empty";

type SheetCell = { row: number; col: number; value: Cell; type?: string };
type Sheet = { name?: string; rows: number; cols: number; cells: SheetCell[] };

const NUM = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;
const ISO = /^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2})?)?/;

const looksNumeric = (v: Cell) => (typeof v === "number" ? Number.isFinite(v) : typeof v === "string" ? NUM.test(v.trim()) : false);
const looksDate = (v: Cell) => typeof v === "string" && ISO.test(v.trim());

/** A dense grid from the sparse cells the parsers emit. The first row is the header when it reads like one. */
export function gridFromSheet(sheet: Sheet): Grid {
	const width = Math.max(1, sheet.cols);
	const grid: Cell[][] = Array.from({ length: Math.max(0, sheet.rows) }, () => Array<Cell>(width).fill(null));
	for (const cell of sheet.cells) {
		if (cell.row < 0 || cell.row >= grid.length || cell.col < 0 || cell.col >= width) continue;
		grid[cell.row]![cell.col] = cell.type === "empty" ? null : (cell.value ?? null);
	}
	const first = grid[0] ?? [];
	const filled = first.filter((v) => v !== null && String(v).trim() !== "");
	const headerish = filled.length > 0 && filled.every((v) => typeof v === "string" && !looksNumeric(v) && !looksDate(v));
	const header = headerish ? first.map((v, i) => (v === null || String(v).trim() === "" ? `Col ${i + 1}` : String(v))) : Array.from({ length: width }, (_, i) => `Col ${i + 1}`);
	const rows = headerish ? grid.slice(1) : grid;
	// drop trailing columns that are empty everywhere (trailing delimiters are common in CSV)
	let keep = width;
	while (keep > 1 && rows.every((r) => r[keep - 1] === null || String(r[keep - 1]).trim() === "")) keep--;
	return { header: header.slice(0, keep), rows: rows.map((r) => r.slice(0, keep)), ...(sheet.name ? { sheet: sheet.name } : {}) };
}

/** What a column mostly holds — drives alignment, sorting and which columns the chart offers. */
export function colKind(grid: Grid, col: number): ColKind {
	let seen = 0;
	let numeric = 0;
	let date = 0;
	let bool = 0;
	for (const row of grid.rows) {
		const v = row[col];
		if (v === null || String(v).trim() === "") continue;
		seen++;
		if (looksNumeric(v)) numeric++;
		else if (looksDate(v)) date++;
		else if (typeof v === "boolean" || /^(true|false|yes|no)$/i.test(String(v))) bool++;
	}
	if (!seen) return "empty";
	if (numeric / seen > 0.8) return "number";
	if (date / seen > 0.8) return "date";
	if (bool / seen > 0.8) return "boolean";
	return "text";
}

export function columnKinds(grid: Grid): ColKind[] {
	return grid.header.map((_, i) => colKind(grid, i));
}

const numericValue = (v: Cell): number | undefined => {
	if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
	if (typeof v === "string" && NUM.test(v.trim())) return Number(v);
	return undefined;
};

/** Stable sort; blanks always sink to the bottom, whichever direction is asked for. */
export function sortRows(grid: Grid, col: number, dir: "asc" | "desc"): Cell[][] {
	const kind = colKind(grid, col);
	const sign = dir === "asc" ? 1 : -1;
	const key = (row: Cell[]) => (kind === "number" ? numericValue(row[col]) : (row[col] ?? ""));
	return grid.rows
		.map((row, i) => ({ row, i }))
		.sort((a, b) => {
			const x = key(a.row);
			const y = key(b.row);
			const xBlank = x === null || x === undefined || x === "";
			const yBlank = y === null || y === undefined || y === "";
			if (xBlank || yBlank) return xBlank && yBlank ? a.i - b.i : xBlank ? 1 : -1;
			const cmp = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true, sensitivity: "base" });
			return cmp === 0 ? a.i - b.i : cmp * sign;
		})
		.map((e) => e.row);
}

/** Rows containing the query, case-insensitively, in any cell. Empty query keeps everything. */
export function filterRows(rows: Cell[][], query: string): Cell[][] {
	const q = query.trim().toLowerCase();
	if (!q) return rows;
	const terms = q.split(/\s+/);
	return rows.filter((row) => {
		const text = row.map((c) => (c === null ? "" : String(c))).join("\u0001").toLowerCase();
		return terms.every((t) => text.includes(t));
	});
}

/** Cells joined by tabs, ready for the clipboard; a spreadsheet pastes it into columns. */
export function tsvOf(header: string[], rows: Cell[][]): string {
	const clean = (v: Cell) => (v === null ? "" : String(v).replace(/[\t\r\n]+/g, " "));
	return [header.map(clean).join("\t"), ...rows.map((r) => r.map(clean).join("\t"))].join("\n");
}

export const formatCell = (v: Cell, kind: ColKind): string => {
	if (v === null) return "";
	if (kind === "number") {
		const n = numericValue(v);
		if (n === undefined) return String(v);
		return Number.isInteger(n) ? n.toLocaleString() : n.toLocaleString(undefined, { maximumFractionDigits: 6 });
	}
	return String(v);
};

export type Point = { label: string; value: number };

/** One bar/line per row, skipping rows without a usable y; sampled evenly when there are too many. */
export function chartPoints(rows: Cell[][], xCol: number | undefined, yCol: number, max = 200): Point[] {
	const points: Point[] = [];
	rows.forEach((row, i) => {
		const y = numericValue(row[yCol]);
		if (y === undefined) return;
		const raw = xCol === undefined ? String(i + 1) : row[xCol];
		points.push({ label: raw === null || String(raw).trim() === "" ? String(i + 1) : String(raw), value: y });
	});
	if (points.length <= max) return points;
	const step = points.length / max;
	return Array.from({ length: max }, (_, i) => points[Math.floor(i * step)]!);
}

/** Round axis ticks (1, 2, 5 × 10ⁿ) covering the data. */
export function ticks(min: number, max: number, count = 4): number[] {
	if (!Number.isFinite(min) || !Number.isFinite(max)) return [0];
	if (min === max) return [min];
	const span = max - min;
	const rough = span / Math.max(1, count);
	const mag = 10 ** Math.floor(Math.log10(rough));
	const norm = rough / mag;
	const step = (norm >= 5 ? 10 : norm >= 2 ? 5 : norm >= 1 ? 2 : 1) * mag;
	const lo = Math.floor(min / step) * step;
	const hi = Math.ceil(max / step) * step;
	const out: number[] = [];
	for (let v = lo; v <= hi + step / 2; v += step) out.push(Math.round(v * 1e6) / 1e6);
	return out;
}

/** Flatten a JSON value into rows for the fallback table (objects of scalars, or an array of them). */
export function gridFromJson(value: unknown, name = "value"): Grid | undefined {
	const list = Array.isArray(value) ? value : [value];
	if (!list.length) return undefined;
	if (!list.every((v) => v && typeof v === "object" && !Array.isArray(v))) return undefined;
	const keys: string[] = [];
	for (const item of list as Record<string, unknown>[]) for (const k of Object.keys(item)) if (!keys.includes(k)) keys.push(k);
	if (!keys.length || keys.length > 40) return undefined;
	const cells: Cell[][] = (list as Record<string, unknown>[]).map((item) =>
		keys.map((k) => {
			const v = item[k];
			if (v === null || v === undefined) return null;
			if (typeof v === "object") return JSON.stringify(v);
			return v as Cell;
		}),
	);
	return { header: keys, rows: cells, sheet: name };
}
