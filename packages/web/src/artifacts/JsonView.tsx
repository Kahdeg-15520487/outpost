/**
 * JSON in a chat: a collapsible tree, a jq-lite query box, and — when the shape allows it — the
 * same table and chart views a spreadsheet gets.
 */

import { useMemo, useState } from "react";
import { toast } from "../toasts";
import { describeRun, runQuery } from "./jq";
import { gridFromJson } from "./table";
import { DataTable } from "./DataTable";

const CHILDREN = 200;

type Kind = "null" | "boolean" | "number" | "string" | "array" | "object";
const kindOf = (v: unknown): Kind => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v === "object" ? "object" : (typeof v as Kind));

const preview = (v: unknown): string => {
	const k = kindOf(v);
	if (k === "array") return `[${(v as unknown[]).length} item${(v as unknown[]).length === 1 ? "" : "s"}]`;
	if (k === "object") {
		const keys = Object.keys(v as object);
		return `{${keys.length} key${keys.length === 1 ? "" : "s"}}`;
	}
	return JSON.stringify(v) ?? "null";
};

export function JsonView({ value, ws, fileId, name }: { value: unknown; ws?: string; fileId: string; name: string }) {
	const [tab, setTab] = useState<"tree" | "table">("tree");
	const [expr, setExpr] = useState("");
	const grid = useMemo(() => gridFromJson(value, name), [value, name]);
	const run = useMemo(() => (expr.trim() ? runQuery(value, expr) : undefined), [value, expr]);
	const results = run && "values" in run ? run.values : undefined;

	return (
		<div className="artifact-json">
			<div className="artifact-tools">
				{grid && (
					<>
						<button className={`btn ghost small${tab === "tree" ? " on" : ""}`} onClick={() => setTab("tree")}>
							Tree
						</button>
						<button className={`btn ghost small${tab === "table" ? " on" : ""}`} onClick={() => setTab("table")}>
							Table
						</button>
					</>
				)}
				<input className="art-filter art-query" placeholder='Query — .items[].name | length' value={expr} onChange={(e) => setExpr(e.target.value)} spellCheck={false} />
				<span className={`mono art-count${run && "error" in run ? " bad" : " muted"}`}>{run ? describeRun(run) : "jq-lite"}</span>
			</div>

			{tab === "table" && grid ? (
				<DataTable grid={grid} ws={ws} fileId={fileId} />
			) : (
				<div className="art-tree">
					{run && "error" in run && <div className="artifact-error">{run.error}</div>}
					{run && "values" in run && !run.values.length ? <div className="artifact-empty">No results.</div> : null}
					{results && results.length === 1 ? <JsonNode v={results[0]} name="result" depth={0} open /> : null}
					{results && results.length > 1
						? results.map((v, i) => <JsonNode key={i} v={v} name={`[${i}]`} depth={0} open={i < 20} />)
						: null}
					{!run ? <JsonNode v={value} name={name} depth={0} open /> : null}
				</div>
			)}
		</div>
	);
}

function JsonNode({ v, name, depth, open: initially }: { v: unknown; name: string; depth: number; open?: boolean }) {
	const [open, setOpen] = useState(initially ?? depth < 1);
	const [limit, setLimit] = useState(CHILDREN);
	const kind = kindOf(v);
	const branch = kind === "array" || kind === "object";
	const entries: [string, unknown][] = useMemo(() => {
		if (kind === "array") return (v as unknown[]).map((item, i) => [String(i), item]);
		if (kind === "object") return Object.entries(v as Record<string, unknown>);
		return [];
	}, [v, kind]);

	const copy = async () => {
		try {
			await navigator.clipboard.writeText(JSON.stringify(v, null, 2));
			toast({ kind: "info", text: `Copied ${name}` });
		} catch {
			toast({ text: "The clipboard is blocked in this browser" });
		}
	};

	return (
		<div className={`jn jn-${kind}`}>
			<div className="jn-row" style={{ paddingLeft: depth * 14 }}>
				{branch ? (
					<button className={`jn-caret${open ? " open" : ""}`} onClick={() => setOpen(!open)} title={open ? "Collapse" : "Expand"}>
						▸
					</button>
				) : (
					<span className="jn-caret blank" />
				)}
				<span className="jn-key">{name}</span>
				<span className="jn-colon">:</span>
				{branch ? (
					<button className="jn-preview" onClick={() => setOpen(!open)}>
						{preview(v)}
					</button>
				) : (
					<span className={`jn-value jn-${kind}`}>{kind === "string" ? `"${String(v)}"` : preview(v)}</span>
				)}
				<button className="jn-copy" onClick={() => void copy()} title="Copy this value">
					⧉
				</button>
			</div>
			{open && branch ? (
				<div className="jn-children">
					{entries.slice(0, limit).map(([k, child]) => (
						<JsonNode key={k} v={child} name={k} depth={depth + 1} />
					))}
					{entries.length > limit && (
						<button className="art-more" style={{ marginLeft: (depth + 1) * 14 }} onClick={() => setLimit(limit + CHILDREN)}>
							Show {Math.min(CHILDREN, entries.length - limit)} more of {entries.length}
						</button>
					)}
					{!entries.length ? <div className="jn-row muted" style={{ paddingLeft: (depth + 1) * 14 }}>empty</div> : null}
				</div>
			) : null}
		</div>
	);
}
