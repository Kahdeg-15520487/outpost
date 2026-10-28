/**
 * The table view of a spreadsheet, delimited file or array of records: sort, filter, copy the
 * filtered rows, and chart a numeric column against any other. Rows are rendered in pages so a
 * 50 000-row CSV stays responsive.
 */

import { useMemo, useState } from "react";
import { fileUrl } from "../api";
import { toast } from "../toasts";
import { chartPoints, columnKinds, filterRows, formatCell, sortRows, ticks, tsvOf, type Cell, type Grid } from "./table";

const PAGE = 200;

export function DataTable({ grid, ws, fileId }: { grid: Grid; ws?: string; fileId: string }) {
	const kinds = useMemo(() => columnKinds(grid), [grid]);
	const numeric = kinds.map((k, i) => (k === "number" ? i : -1)).filter((i) => i >= 0);
	const [sort, setSort] = useState<{ col: number; dir: "asc" | "desc" }>();
	const [query, setQuery] = useState("");
	const [visible, setVisible] = useState(PAGE);
	const [mode, setMode] = useState<"table" | "chart">(numeric.length ? "table" : "table");
	const [kind, setKind] = useState<"bar" | "line">("bar");
	const [xCol, setXCol] = useState<number>(0);
	const [yCol, setYCol] = useState<number>(numeric[0] ?? -1);

	const rows = useMemo(() => {
		const filtered = filterRows(grid.rows, query);
		return sort ? sortRows({ ...grid, rows: filtered }, sort.col, sort.dir) : filtered;
	}, [grid, query, sort]);

	if (!grid.rows.length) return <div className="artifact-empty">The table is empty.</div>;

	const toggleSort = (col: number) =>
		setSort((s) => (s?.col !== col ? { col, dir: "asc" } : s.dir === "asc" ? { col, dir: "desc" } : undefined));

	const copy = async () => {
		const text = tsvOf(grid.header, rows);
		try {
			await navigator.clipboard.writeText(text);
			toast({ kind: "info", text: `Copied ${rows.length} row${rows.length === 1 ? "" : "s"} — paste into a spreadsheet` });
		} catch {
			toast({ text: "The clipboard is blocked in this browser" });
		}
	};

	return (
		<div className="artifact-data">
			<div className="artifact-tools">
				<input className="art-filter" placeholder="Filter rows…" value={query} onChange={(e) => (setQuery(e.target.value), setVisible(PAGE))} spellCheck={false} />
				<span className="mono muted art-count">
					{rows.length === grid.rows.length ? `${grid.rows.length} rows` : `${rows.length} of ${grid.rows.length} rows`} · {grid.header.length} cols
				</span>
				{grid.sheet && <span className="pill soft">{grid.sheet}</span>}
				<div className="art-spacer" />
				{numeric.length > 0 && (
					<button className={`btn ghost small${mode === "chart" ? " on" : ""}`} onClick={() => setMode(mode === "chart" ? "table" : "chart")} title="Chart a numeric column">
						{mode === "chart" ? "▦ Table" : "📈 Chart"}
					</button>
				)}
				<button className="btn ghost small" onClick={() => void copy()} title="Copy the visible rows as TSV">
					Copy
				</button>
				{ws && (
					<a className="btn ghost small" href={fileUrl(ws, fileId)} download>
						CSV
					</a>
				)}
			</div>

			{mode === "chart" ? (
				<Chart rows={rows} header={grid.header} kinds={kinds} numeric={numeric} kind={kind} setKind={setKind} xCol={xCol} setXCol={setXCol} yCol={yCol} setYCol={setYCol} />
			) : (
				<div className="art-table-wrap">
					<table className="art-table">
						<thead>
							<tr>
								<th className="art-idx" />
								{grid.header.map((h, i) => (
									<th key={i} className={kinds[i] === "number" ? "num" : ""} onClick={() => toggleSort(i)} title="Sort">
										<span className="art-th">
											{h}
											<span className={`art-sort${sort?.col === i ? " on" : ""}`}>{sort?.col === i ? (sort.dir === "asc" ? "↑" : "↓") : ""}</span>
										</span>
									</th>
								))}
							</tr>
						</thead>
						<tbody>
							{rows.slice(0, visible).map((row, r) => (
								<tr key={r}>
									<td className="art-idx mono">{r + 1}</td>
									{row.map((cell, c) => (
										<td key={c} className={kinds[c] === "number" ? "num" : kinds[c] === "text" ? "" : "mono"} title={cell === null ? "" : String(cell)}>
											{formatCell(cell, kinds[c]!)}
										</td>
									))}
								</tr>
							))}
						</tbody>
					</table>
					{rows.length > visible && (
						<button className="art-more" onClick={() => setVisible(visible + PAGE)}>
							Show {Math.min(PAGE, rows.length - visible)} more of {rows.length}
						</button>
					)}
				</div>
			)}
		</div>
	);
}

function Chart(props: {
	rows: Cell[][];
	header: string[];
	kinds: ReturnType<typeof columnKinds>;
	numeric: number[];
	kind: "bar" | "line";
	setKind: (k: "bar" | "line") => void;
	xCol: number;
	setXCol: (i: number) => void;
	yCol: number;
	setYCol: (i: number) => void;
}) {
	const { rows, header, kinds, numeric, kind, setKind, xCol, setXCol, yCol, setYCol } = props;
	const points = useMemo(() => chartPoints(rows, xCol, yCol, 200), [rows, xCol, yCol]);
	const W = 720;
	const H = 260;
	const M = { t: 14, r: 12, b: 34, l: 56 };
	const values = points.map((p) => p.value);
	const lo = Math.min(0, ...values);
	const hi = Math.max(0, ...values);
	const marks = ticks(lo, hi, 5);
	const yMin = marks[0] ?? 0;
	const yMax = marks[marks.length - 1] ?? 1;
	const y = (v: number) => M.t + (1 - (v - yMin) / (yMax - yMin || 1)) * (H - M.t - M.b);
	const innerW = W - M.l - M.r;
	const x = (i: number) => M.l + (points.length === 1 ? innerW / 2 : (i / (points.length - 1)) * innerW);
	const color = "var(--signal)";
	const labelEvery = Math.max(1, Math.ceil(points.length / 14));

	if (!points.length || yCol < 0) {
		return (
			<div className="artifact-empty">
				No numeric values to chart{header.length ? "" : ""}.{" "}
				<button className="btn ghost small" onClick={() => setKind("bar")}>
					Back
				</button>
			</div>
		);
	}

	return (
		<div className="art-chart">
			<div className="artifact-tools">
				<label className="art-field">
					<span>X</span>
					<select value={xCol} onChange={(e) => setXCol(Number(e.target.value))}>
						{header.map((h, i) => (
							<option key={i} value={i}>
								{h}
							</option>
						))}
					</select>
				</label>
				<label className="art-field">
					<span>Y</span>
					<select value={yCol} onChange={(e) => setYCol(Number(e.target.value))}>
						{numeric.map((i) => (
							<option key={i} value={i}>
								{header[i]}
							</option>
						))}
					</select>
				</label>
				<div className="art-spacer" />
				<button className={`btn ghost small${kind === "bar" ? " on" : ""}`} onClick={() => setKind("bar")}>
					Bars
				</button>
				<button className={`btn ghost small${kind === "line" ? " on" : ""}`} onClick={() => setKind("line")}>
					Line
				</button>
			</div>
			<svg className="art-svg" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${header[yCol]} by ${header[xCol]}`}>
				{marks.map((m) => (
					<g key={m}>
						<line x1={M.l} x2={W - M.r} y1={y(m)} y2={y(m)} className="art-grid" />
						<text x={M.l - 8} y={y(m) + 4} textAnchor="end" className="art-axis">
							{Math.abs(m) >= 1000 ? m.toLocaleString(undefined, { notation: "compact" }) : m}
						</text>
					</g>
				))}
				{kind === "bar"
					? points.map((p, i) => {
							const w = Math.max(2, (innerW / points.length) * 0.72);
							const top = y(Math.max(p.value, 0));
							const bottom = y(Math.min(p.value, 0));
							return (
								<rect key={i} x={x(i) - w / 2} y={top} width={w} height={Math.max(1, bottom - top)} fill={color} rx={2} className="art-bar">
									<title>{`${p.label}: ${p.value}`}</title>
								</rect>
							);
						})
					: (() => {
							const d = points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(" ");
							return (
								<>
									<path d={d} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" />
									{points.map((p, i) => (
										<circle key={i} cx={x(i)} cy={y(p.value)} r={points.length > 60 ? 1.5 : 3} fill={color}>
											<title>{`${p.label}: ${p.value}`}</title>
										</circle>
									))}
								</>
							);
						})()}
				<line x1={M.l} x2={W - M.r} y1={y(Math.max(0, yMin))} y2={y(Math.max(0, yMin))} className="art-base" />
				{points.map((p, i) =>
					i % labelEvery === 0 ? (
						<text key={i} x={x(i)} y={H - M.b + 16} textAnchor="middle" className="art-axis">
							{p.label.length > 12 ? `${p.label.slice(0, 11)}…` : p.label}
						</text>
					) : null,
				)}
			</svg>
			<div className="mono muted art-count">
				{header[yCol]} by {header[xCol]} · {points.length} point{points.length === 1 ? "" : "s"}
				{points.length < rows.length ? ` (${rows.length - points.length} rows without a number skipped)` : ""}
			</div>
		</div>
	);
}
