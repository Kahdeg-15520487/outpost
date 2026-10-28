/**
 * A small jq: enough to query a JSON artifact in a chat without teaching anyone jq's corners.
 * Supported: `.a.b`, `["odd key"]`, `[0]` / `[-1]`, `[]` and `[*]` iteration, `|` pipelines,
 * `map(…)`, `sort_by(…)`, `join("…")`, `keys`, `values`, `length`, `type`, `sort`, `unique`,
 * `add`, `min`, `max`, `flatten`, `reverse`, `first`, `last`, `tostring`, `tonumber`, `count`.
 * Pure: the browser and the tests share it.
 */

export type Run = { values: unknown[] } | { error: string };

type Op =
	| { t: "field"; name: string }
	| { t: "index"; i: number }
	| { t: "iter" }
	| { t: "fn"; name: string; arg?: string };

const CAP = 5000;

/** Split on `|` at the top level, leaving quoted and bracketed text alone. */
function pipes(expr: string): string[] {
	const out: string[] = [];
	let depth = 0;
	let quote: string | undefined;
	let start = 0;
	for (let i = 0; i < expr.length; i++) {
		const c = expr[i]!;
		if (quote) {
			if (c === "\\") i++;
			else if (c === quote) quote = undefined;
			continue;
		}
		if (c === '"' || c === "'") quote = c;
		else if (c === "[" || c === "(") depth++;
		else if (c === "]" || c === ")") depth--;
		else if (c === "|" && depth === 0) {
			out.push(expr.slice(start, i));
			start = i + 1;
		}
	}
	out.push(expr.slice(start));
	return out.map((s) => s.trim()).filter(Boolean);
}

const unquote = (raw: string) => {
	const s = raw.trim();
	if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) return s.slice(1, -1).replace(/\\(.)/g, "$1");
	return s;
};

function parseStage(stage: string): Op[] | { error: string } {
	const ops: Op[] = [];
	let i = 0;
	const text = stage.trim();
	if (text === "." || text === "") return ops;
	while (i < text.length) {
		const c = text[i]!;
		if (/\s/.test(c)) {
			i++;
			continue;
		}
		if (c === "?") {
			i++;
			continue;
		}
		if (c === "." && text[i + 1] === "[") {
			i++;
			continue;
		}
		if (c === ".") {
			i++;
			let name = "";
			while (i < text.length && /[A-Za-z0-9_$]/.test(text[i]!)) name += text[i++]!;
			if (name) ops.push({ t: "field", name });
			continue;
		}
		if (c === "[") {
			// [0] [-1] ["key"] [*] []
			const close = text.indexOf("]", i);
			if (close < 0) return { error: "unclosed [" };
			const inner = text.slice(i + 1, close).trim();
			i = close + 1;
			if (inner === "" || inner === "*") ops.push({ t: "iter" });
			else if (/^-?\d+$/.test(inner)) ops.push({ t: "index", i: Number(inner) });
			else if (/^["']/.test(inner)) ops.push({ t: "field", name: unquote(inner) });
			else return { error: `cannot read [${inner}] — use an index, a quoted key, * or nothing` };
			continue;
		}
		if (/[A-Za-z_]/.test(c)) {
			let name = "";
			while (i < text.length && /[A-Za-z0-9_]/.test(text[i]!)) name += text[i++]!;
			if (text[i] === "(") {
				let depth = 0;
				let quote: string | undefined;
				const from = i;
				for (; i < text.length; i++) {
					const d = text[i]!;
					if (quote) {
						if (d === "\\") i++;
						else if (d === quote) quote = undefined;
						continue;
					}
					if (d === '"' || d === "'") quote = d;
					else if (d === "(") depth++;
					else if (d === ")" && --depth === 0) break;
				}
				if (depth !== 0) return { error: `unclosed ( after ${name}` };
				ops.push({ t: "fn", name, arg: text.slice(from + 1, i) });
				i++;
			} else ops.push({ t: "fn", name });
			continue;
		}
		return { error: `unexpected "${c}" at ${i + 1}` };
	}
	return ops;
}

const typeOf = (v: unknown) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v === "object" ? "object" : typeof v);

const compare = (a: unknown, b: unknown): number => {
	const rank = (v: unknown) => ["null", "boolean", "number", "string", "array", "object"].indexOf(typeOf(v));
	if (rank(a) !== rank(b)) return rank(a) - rank(b);
	if (typeof a === "number" && typeof b === "number") return a - b;
	if (typeof a === "boolean" && typeof b === "boolean") return Number(a) - Number(b);
	if (typeof a === "string" && typeof b === "string") return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
	return JSON.stringify(a).localeCompare(JSON.stringify(b));
};

/** Apply one stage to one value. Returns every value it produces. */
function applyOp(value: unknown, op: Op): unknown[] {
	switch (op.t) {
		case "field": {
			if (Array.isArray(value)) return value.flatMap((v) => applyOp(v, op));
			if (value && typeof value === "object" && Object.prototype.hasOwnProperty.call(value, op.name)) return [(value as Record<string, unknown>)[op.name]];
			return [];
		}
		case "index": {
			if (!Array.isArray(value)) return [];
			const i = op.i < 0 ? value.length + op.i : op.i;
			return i >= 0 && i < value.length ? [value[i]] : [];
		}
		case "iter": {
			if (Array.isArray(value)) return value;
			if (value && typeof value === "object") return Object.values(value as Record<string, unknown>);
			return [];
		}
		case "fn": {
			const sub = op.arg?.trim();
			switch (op.name) {
				case "keys":
					return [Array.isArray(value) ? value.map((_, i) => i) : value && typeof value === "object" ? Object.keys(value as object) : []];
				case "values":
					return [Array.isArray(value) ? value : value && typeof value === "object" ? Object.values(value as object) : []];
				case "length":
				case "count":
					return [Array.isArray(value) ? value.length : typeof value === "string" ? value.length : value && typeof value === "object" ? Object.keys(value as object).length : value === null ? 0 : Math.abs(Number(value)) || 0];
				case "type":
					return [typeOf(value)];
				case "sort":
					return [Array.isArray(value) ? [...value].sort(compare) : value];
				case "unique":
					if (!Array.isArray(value)) return [value];
					return [value.filter((v, i) => value.findIndex((o) => JSON.stringify(o) === JSON.stringify(v)) === i)];
				case "add":
					if (!Array.isArray(value)) return [value];
					if (!value.length) return [null];
					if (value.every((v) => typeof v === "number")) return [value.reduce((a, b) => a + (b as number), 0)];
					if (value.every((v) => typeof v === "string")) return [value.join("")];
					if (value.every((v) => Array.isArray(v))) return [value.flat()];
					if (value.every((v) => v && typeof v === "object" && !Array.isArray(v))) return [Object.assign({}, ...value)];
					return [value.reduce((a, b) => a + String(b), "")];
				case "min":
				case "max":
					if (!Array.isArray(value) || !value.length) return [];
					return [[...value].sort(compare)[op.name === "min" ? 0 : value.length - 1]];
				case "flatten":
					return [sub && /^\d+$/.test(sub) ? value && Array.isArray(value) ? value.flat(Number(sub)) : value : Array.isArray(value) ? value.flat() : value];
				case "reverse":
					return [Array.isArray(value) ? [...value].reverse() : typeof value === "string" ? [...value].reverse().join("") : value];
				case "first":
					return [Array.isArray(value) ? value[0] : value];
				case "last":
					return [Array.isArray(value) ? value[value.length - 1] : value];
				case "tostring":
					return [typeof value === "string" ? value : JSON.stringify(value)];
				case "tonumber": {
					const n = typeof value === "number" ? value : Number(String(value).trim());
					return Number.isFinite(n) ? [n] : [];
				}
				case "join": {
					if (!Array.isArray(value)) return [];
					const sep = sub === undefined ? "" : unquote(sub);
					return [value.map((v) => (v === null ? "" : typeof v === "string" ? v : JSON.stringify(v))).join(sep)];
				}
				case "map": {
					// jq's map yields one array, not a stream of its members
					if (!Array.isArray(value)) return [];
					return [value.flatMap((v) => {
						if (!sub) return [v];
						const r = runStage(v, sub);
						return "values" in r ? r.values : [];
					})];
				}
				case "sort_by": {
					if (!Array.isArray(value) || !sub) return [value];
					const keyed = value.map((v) => {
						const r = runStage(v, sub);
						return { v, k: "values" in r ? r.values[0] : undefined };
					});
					return [keyed.sort((a, b) => compare(a.k, b.k)).map((e) => e.v)];
				}
				default:
					throw new Error(`unknown function "${op.name}()"`);
			}
		}
	}
}

function runStage(value: unknown, stage: string): Run {
	const ops = parseStage(stage);
	if ("error" in ops) return { error: ops.error };
	let current = [value];
	for (const op of ops) {
		const next: unknown[] = [];
		for (const v of current) {
			try {
				next.push(...applyOp(v, op));
			} catch (e) {
				return { error: (e as Error).message };
			}
			if (next.length > CAP) return { error: `more than ${CAP} results — narrow the query` };
		}
		current = next;
	}
	return { values: current };
}

/** Run a query against a JSON value. An empty or "." query returns the value itself. */
export function runQuery(input: unknown, expr: string): Run {
	const stages = pipes(expr.trim() || ".");
	if (!stages.length) return { values: [input] };
	let current: unknown[] = [input];
	for (const stage of stages) {
		const next: unknown[] = [];
		for (const v of current) {
			const r = runStage(v, stage);
			if ("error" in r) return r;
			next.push(...r.values);
		}
		if (next.length > CAP) return { error: `more than ${CAP} results — narrow the query` };
		current = next;
	}
	return { values: current };
}

/** One-line summary of a query result, for the counter next to the box. */
export function describeRun(run: Run): string {
	if ("error" in run) return run.error;
	if (run.values.length === 1) {
		const v = run.values[0];
		if (Array.isArray(v)) return `1 array · ${v.length} item${v.length === 1 ? "" : "s"}`;
		if (v && typeof v === "object") return `1 object · ${Object.keys(v as object).length} key${Object.keys(v as object).length === 1 ? "" : "s"}`;
		return `1 ${typeOf(v)}`;
	}
	return `${run.values.length} results`;
}
