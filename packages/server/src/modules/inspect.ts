/**
 * What a blueprint reader and a module owner need to compare code: file-level diff counts, the API a
 * blueprint declares, and the compat assessment of a set of files.
 *
 * Nothing here executes the blueprint — comparing two versions must never be a side effect (that was
 * the whole complaint: asking "does it have the field?" created a module).
 */

import { detectRequires, MODULE_RUNTIME, OUTPOST_VERSION, type Assessment } from "./compat.ts";
import { blueprints, modules, type BlueprintRow } from "../kernel/system-db.ts";

export type FileChange = {
	path: string;
	status: "added" | "removed" | "changed" | "same";
	before?: number;
	after?: number;
};

/** Per-path comparison of two file maps, sizes included so the UI can show `+124 / -38`. */
export function diffFiles(before: Record<string, string>, after: Record<string, string>, onlyChanged = true): FileChange[] {
	const paths = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
	const out: FileChange[] = [];
	for (const path of paths) {
		const a = before[path];
		const b = after[path];
		const status = a === undefined ? "added" : b === undefined ? "removed" : a === b ? "same" : "changed";
		if (onlyChanged && status === "same") continue;
		out.push({ path, status, ...(a !== undefined ? { before: a.length } : {}), ...(b !== undefined ? { after: b.length } : {}) });
	}
	return out;
}

/**
 * The methods a blueprint's server file declares, read statically: `get()`, `setDeck()`, and the
 * `static readonly = [...]` list that marks read-only ones. This is the "what can it do?" answer that
 * used to require cloning the blueprint and asking the running module.
 */
export function declaredApi(files: Record<string, string>): { methods: string[]; readonly: string[] } {
	const server = files["server.js"] ?? Object.entries(files).find(([path]) => path === "server.js" || path.startsWith("server/"))?.[1] ?? "";
	const readonly = [...server.matchAll(/static\s+readonly\s*=\s*\[([^\]]*)\]/g)]
		.flatMap((m) => [...m[1]!.matchAll(/["'`]([^"'`]+)["'`]/g)].map((x) => x[1]!));
	const methods = [...server.matchAll(/^\s{2,4}([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/gm)]
		.map((m) => m[1]!)
		.filter((name) => !["constructor", "if", "for", "while", "switch", "catch", "return", "function"].includes(name));
	const unique = [...new Set(methods)].sort();
	return { methods: unique, readonly: readonly.filter((name) => unique.includes(name)).sort() };
}

/** Would this code run on this instance? The same check import runs, for publish time. */
export function assessFiles(files: Record<string, string>): Assessment {
	const requires = detectRequires(files);
	const issues: string[] = [];
	const notes: string[] = [];
	if (requires.runtime !== MODULE_RUNTIME) issues.push(`Built for module runtime ${requires.runtime}; this instance runs ${MODULE_RUNTIME}.`);
	if (!files["index.html"]) issues.push("No index.html: the module would have no client.");
	if (!files["server.js"]) notes.push("No server.js: the module has no server API.");
	const unknown = requires.airlocks.filter((g) => !g.methods.length);
	if (unknown.length) notes.push(`Uses airlocks: ${requires.airlocks.map((g) => g.id).join(", ")}.`);
	return { status: issues.length ? "blocked" : notes.length ? "warn" : "ok", issues, notes: [...notes, `for Outpost ${OUTPOST_VERSION}`] };
}

/**
 * Everything a reader needs to judge a blueprint without cloning it: files with sizes, the source,
 * the API it declares, every version, and which modules are sitting on one. Read-only, no execution.
 */
export function blueprintInfo(bp: BlueprintRow) {
	const versions = blueprints.versions(bp.rootId);
	const using = modules.fromRoot(bp.rootId, versions.map((v) => v.id));
	return {
		blueprint: { ...bp, files: undefined },
		files: Object.fromEntries(Object.entries(bp.files).map(([path, body]) => [path, { size: body.length, lines: body.split("\n").length }])),
		source: bp.files,
		api: declaredApi(bp.files),
		versions: versions.map(({ files: _files, ...v }) => v),
		modulesUsing: using.map((m) => ({ id: m.id, name: m.name, workspaceId: m.workspaceId, current: m.blueprintId === bp.id, hidden: m.hidden === true })),
		compat: assessFiles(bp.files),
	};
}
