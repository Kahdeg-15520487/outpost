/**
 * What a blueprint reader and a module owner need to compare code, resolve ids, and judge whether the
 * code will run — all of it without executing anything. Comparing two versions must never be a side
 * effect; that was the whole complaint (asking "does it have the field?" used to create a module).
 */

import { assess, detectRequires, type Assessment } from "./compat.ts";
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

/**
 * Would this code run on this instance? The same assessment import uses, so writing a file and
 * publishing a blueprint can never disagree about the same code.
 */
export function assessFiles(files: Record<string, string>): Assessment {
	const requires = detectRequires(files);
	const base = assess(requires);
	const issues = [...base.issues];
	const notes = [...base.notes];
	if (!files["index.html"]) issues.push("No index.html: the module would have no client.");
	if (!files["server.js"]) notes.push("No server.js: the module has no server API.");
	if (requires.vendored?.length) notes.push(`Shipped as-is, not scanned: ${requires.vendored.join(", ")}`);
	const status: Assessment["status"] = issues.length ? "blocked" : base.status === "warn" || notes.length ? "warn" : "ok";
	return { status, issues, notes };
}

/**
 * Resolve whatever id a caller has to the version they mean.
 *
 * Three kinds of id exist and callers mix them: a root (`bp_…` naming the blueprint), a version id (one
 * build, or the id stored on a module), and — because a first version's id *is* its root — an id that is
 * both. Reading "the blueprint" by a root id must give the current version; a version id must give that
 * version. Resolving the other way round silently returns stale code, and editing stale code then
 * publishing it reverts whatever was improved.
 */
export function findBlueprint(id: string, version?: number | "latest"): BlueprintRow | undefined {
	const byId = blueprints.get(id);
	if (!byId) return undefined;
	const versions = blueprints.versions(byId.rootId);
	if (typeof version === "number") return versions.find((v) => v.version === version);
	if (version === "latest") return versions.at(-1);
	return byId.rootId === id ? versions.at(-1) : byId;
}

/**
 * Everything a reader needs to judge a blueprint without cloning it: files with sizes, the source, the
 * API it declares, every version, who is using it, and which version it came from.
 */
export function blueprintInfo(bp: BlueprintRow) {
	const versions = blueprints.versions(bp.rootId);
	const current = versions.at(-1)!;
	const using = modules.fromRoot(bp.rootId, versions.map((v) => v.id));
	const drafts = using.filter((m) => m.hidden === true);
	const live = using.filter((m) => m.hidden !== true);
	return {
		blueprint: { ...bp, files: undefined },
		// Which version this answer is about, and which one is current: they differ when an old version
		// was asked for explicitly, and a caller must be able to see that rather than guess.
		requested: { id: bp.id, version: bp.version },
		current: { id: current.id, version: current.version, changelog: current.changelog, updatedAt: current.updatedAt },
		files: Object.fromEntries(Object.entries(bp.files).map(([path, body]) => [path, { size: body.length, lines: body.split("\n").length }])),
		source: bp.files,
		api: declaredApi(bp.files),
		versions: versions.map(({ files: _files, ...v }) => v),
		modulesUsing: live.map((m) => ({ id: m.id, name: m.name, workspaceId: m.workspaceId, current: m.blueprintId === bp.id })),
		// Drafts are working copies, not the user's modules: counted apart so they neither inflate "used
		// by" nor get swept up by a rollout.
		draftsUsing: drafts.map((m) => ({ id: m.id, name: m.name, workspaceId: m.workspaceId, current: m.blueprintId === bp.id })),
		compat: assessFiles(bp.files),
	};
}
