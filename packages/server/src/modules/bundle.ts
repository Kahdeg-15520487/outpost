import { blueprints, HttpError, newId, users, type BlueprintIntro, type BlueprintRow, type ModuleRow } from "../kernel/system-db.ts";
import type { Workspace } from "../kernel/workspace.ts";
import { assess, detectRequires, mergeRequires, producer, MODULE_RUNTIME, type Assessment, type Producer, type Requires } from "./compat.ts";

/**
 * Moving blueprints and modules between outpost instances: one portable JSON file (`*.outpost.json`).
 *
 *   { "format": "outpost/bundle", "version": 2, "exportedAt": "…",
 *     "producer": { "app": "outpost", "version": "0.8.0", "runtime": 2 },
 *     "blueprints": [{ name, description, icon, intro?, files: { path: text }, requires }],
 *     "modules":    [{ name, icon, blueprint?, files: { path: text }, data?: { key: json }, requires }] }
 *
 * `requires` (compat.ts) is the module runtime generation, the server/page features the code uses and the
 * Airlocks it calls. Import checks every item against this instance (re-detecting from the code):
 * items that can't run here are skipped, items whose Airlock calls would fail come with a warning.
 * Only the current Outpost format and bundle version are accepted. Legacy files need offline conversion.
 *
 * Code travels as its source files; a module's stored data (its key/value state) only when asked.
 * Things that belong to one instance stay behind: shares, share links, Airlock grants, workspace
 * files a module's data may point to, logs. Imported modules are new modules owned by the importer;
 * imported blueprints are new blueprints authored by the importer (private unless chosen otherwise).
 * Imported code runs in the same sandbox as any module (QuickJS server, CSP-locked iframe client).
 */
export const BUNDLE_FORMAT = "outpost/bundle";
export const BUNDLE_VERSION = 2;

export type BundleBlueprint = { name: string; description: string; icon: string; intro?: BlueprintIntro; files: Record<string, string>; requires?: Requires };
export type BundleModule = { name: string; icon: string; blueprint?: string; files: Record<string, string>; data?: Record<string, unknown>; requires?: Requires };
export type Bundle = { format: typeof BUNDLE_FORMAT; version: number; exportedAt: string; producer?: Producer; blueprints: BundleBlueprint[]; modules: BundleModule[] };

const LIMITS = { items: 200, filesPerItem: 300, fileBytes: 2 << 20, itemBytes: 10 << 20, dataBytes: 20 << 20, name: 80, description: 2000 };
const PATH = /^[\w./-]{1,120}$/;

export function makeBundle(parts: { blueprints?: BlueprintRow[]; modules?: { row: ModuleRow; files: Record<string, string>; data?: Record<string, unknown>; grants?: { id: string; label: string; airlock: string }[] }[] }): Bundle {
	return {
		format: BUNDLE_FORMAT,
		version: BUNDLE_VERSION,
		exportedAt: new Date().toISOString(),
		producer: producer(),
		blueprints: (parts.blueprints ?? []).map((b) => ({ name: b.name, description: b.description, icon: b.icon, ...(b.intro && Object.keys(b.intro).length ? { intro: b.intro } : {}), files: b.files, requires: detectRequires(b.files) })),
		modules: (parts.modules ?? []).map(({ row, files, data, grants }) => ({
			name: row.name,
			icon: row.icon,
			...(row.blueprintId ? { blueprint: blueprints.get(row.blueprintId)?.name } : {}),
			files,
			...(data ? { data } : {}),
			requires: detectRequires(files, grants),
		})),
	};
}

/** A file name for a bundle: `todo.outpost.json`, `outpost-export-2026-10-23.outpost.json`. */
export function bundleFileName(b: Bundle) {
	const one = b.blueprints.length + b.modules.length === 1 ? (b.blueprints[0]?.name ?? b.modules[0]?.name) : undefined;
	const stem = one ? one.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "export" : `outpost-export-${b.exportedAt.slice(0, 10)}`;
	return `${stem}.outpost.json`;
}

function files(raw: unknown, where: string): Record<string, string> {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new HttpError(400, `${where}: files must be an object of path → text`);
	const out: Record<string, string> = {};
	let total = 0;
	const entries = Object.entries(raw as Record<string, unknown>);
	if (entries.length > LIMITS.filesPerItem) throw new HttpError(400, `${where}: too many files (${entries.length} > ${LIMITS.filesPerItem})`);
	for (const [path, content] of entries) {
		if (!PATH.test(path) || path.includes("..") || path.startsWith("/")) throw new HttpError(400, `${where}: invalid file path “${path}”`);
		if (typeof content !== "string") throw new HttpError(400, `${where}: ${path} must be text`);
		if (content.length > LIMITS.fileBytes) throw new HttpError(400, `${where}: ${path} is too large`);
		total += content.length;
		out[path] = content;
	}
	if (total > LIMITS.itemBytes) throw new HttpError(400, `${where}: files too large in total`);
	return out;
}

const str = (v: unknown, max: number, fallback = "") => (typeof v === "string" ? v.slice(0, max) : fallback);

/** Validate an uploaded bundle; throws a 400 that says what's wrong. */
export function parseBundle(input: unknown): Bundle {
	const b = input as Partial<Bundle> | undefined;
	if (!b || typeof b !== "object" || b.format !== BUNDLE_FORMAT) throw new HttpError(400, "Not an Outpost export file (expected format “outpost/bundle”)");
	if (typeof b.version !== "number" || b.version !== BUNDLE_VERSION) throw new HttpError(400, `Unsupported Outpost bundle version ${b.version}; expected ${BUNDLE_VERSION}`);
	const bps = Array.isArray(b.blueprints) ? b.blueprints : [];
	const gs = Array.isArray(b.modules) ? b.modules : [];
	if (!bps.length && !gs.length) throw new HttpError(400, "The file contains no blueprints or modules");
	if (bps.length + gs.length > LIMITS.items) throw new HttpError(400, `Too many items (${bps.length + gs.length} > ${LIMITS.items})`);
	const from = b.producer && typeof b.producer === "object" ? { app: str((b.producer as any).app, 40, "outpost"), version: str((b.producer as any).version, 40), runtime: typeof (b.producer as any).runtime === "number" ? (b.producer as any).runtime : MODULE_RUNTIME } : undefined;
	// What an item declares, joined with what its code shows; the runtime default comes from the producer.
	const requires = (x: any, files: Record<string, string>) => mergeRequires({ runtime: from?.runtime, ...(x?.requires && typeof x.requires === "object" ? x.requires : {}) }, detectRequires(files));
	return {
		format: BUNDLE_FORMAT,
		version: b.version,
		exportedAt: str(b.exportedAt, 40),
		...(from ? { producer: from } : {}),
		blueprints: bps.map((x: any, i) => {
			const where = `Blueprint ${i + 1}${x?.name ? ` “${str(x.name, 40)}”` : ""}`;
			const name = str(x?.name, LIMITS.name).trim();
			if (!name) throw new HttpError(400, `${where}: missing name`);
			const intro = x?.intro && typeof x.intro === "object" ? (JSON.parse(JSON.stringify(x.intro)) as BlueprintIntro) : undefined;
			const fs = files(x?.files, where);
			return { name, description: str(x?.description, LIMITS.description), icon: str(x?.icon, 8, "◆") || "◆", ...(intro ? { intro } : {}), files: fs, requires: requires(x, fs) };
		}),
		modules: gs.map((x: any, i) => {
			const where = `Module ${i + 1}${x?.name ? ` “${str(x.name, 40)}”` : ""}`;
			const name = str(x?.name, LIMITS.name).trim();
			if (!name) throw new HttpError(400, `${where}: missing name`);
			let data: Record<string, unknown> | undefined;
			if (x?.data !== undefined) {
				if (!x.data || typeof x.data !== "object" || Array.isArray(x.data)) throw new HttpError(400, `${where}: data must be an object`);
				const json = JSON.stringify(x.data);
				if (json.length > LIMITS.dataBytes) throw new HttpError(400, `${where}: data too large`);
				data = JSON.parse(json);
			}
			const fs = files(x?.files, where);
			return { name, icon: str(x?.icon, 8, "◆") || "◆", ...(x?.blueprint ? { blueprint: str(x.blueprint, LIMITS.name) } : {}), files: fs, ...(data ? { data } : {}), requires: requires(x, fs) };
		}),
	};
}

export type ItemCheck = { kind: "blueprint" | "module"; index: number; name: string; requires: Requires } & Assessment;
export type BundleCheck = { producer?: Producer; local: Producer; items: ItemCheck[] };

/** Check every item of a bundle against this instance, without importing anything. */
export function checkBundle(b: Bundle): BundleCheck {
	const item = (kind: ItemCheck["kind"], index: number, x: BundleBlueprint | BundleModule): ItemCheck => {
		const requires = x.requires ?? detectRequires(x.files);
		return { kind, index, name: x.name, requires, ...assess(requires, b.producer) };
	};
	return { ...(b.producer ? { producer: b.producer } : {}), local: producer(), items: [...b.blueprints.map((x, i) => item("blueprint", i, x)), ...b.modules.map((x, i) => item("module", i, x))] };
}

export type ImportResult = {
	blueprints: { id: string; name: string }[];
	modules: { id: string; name: string; data: boolean }[];
	/** Not imported: they can't run on this instance. */
	skipped: { kind: string; name: string; issues: string[] }[];
	/** Imported, but some parts won't work here. */
	warnings: { kind: string; name: string; issues: string[] }[];
	notes: string[];
};

/** Create the bundle's blueprints (for the user) and modules (in this workspace, owned by the user). */
export async function importBundle(ws: Workspace | undefined, userId: string, b: Bundle, opts: { visibility: "public" | "private" }): Promise<ImportResult> {
	if (b.modules.length && !ws) throw new HttpError(400, "Open a workspace to import modules into");
	const result: ImportResult = { blueprints: [], modules: [], skipped: [], warnings: [], notes: [] };
	const author = users.get(userId)?.displayName ?? "you";
	const checks = checkBundle(b).items;
	const verdict = (kind: "blueprint" | "module", i: number, name: string) => {
		const c = checks.find((x) => x.kind === kind && x.index === i)!;
		if (c.status === "blocked") result.skipped.push({ kind, name, issues: c.issues });
		else if (c.status === "warn") result.warnings.push({ kind, name, issues: c.issues });
		for (const n of c.notes) if (!result.notes.includes(`${name}: ${n}`)) result.notes.push(`${name}: ${n}`);
		return c.status !== "blocked";
	};
	for (const [i, bp] of b.blueprints.entries()) {
		if (!verdict("blueprint", i, bp.name)) continue;
		const id = newId("bp");
		const row: BlueprintRow = { id, rootId: id, version: 1, changelog: "Imported", parentId: null, updatedAt: Date.now(), name: bp.name, description: bp.description, icon: bp.icon, authorId: userId, visibility: opts.visibility, files: bp.files, createdAt: Date.now(), intro: bp.intro };
		blueprints.upsert(row);
		result.blueprints.push({ id: row.id, name: row.name });
	}
	for (const [i, g] of b.modules.entries()) {
		if (!verdict("module", i, g.name)) continue;
		const row = await ws!.createModule({ name: g.name, icon: g.icon, ownerId: userId, files: g.files });
		if (g.data && Object.keys(g.data).length) await ws!.setModuleState(row.id, g.data);
		result.modules.push({ id: row.id, name: row.name, data: !!g.data });
	}
	if (result.modules.length) result.notes.push(`Modules arrive owned by ${author}, unshared, with no Airlock access: grant what they need again.`);
	if (b.modules.some((g) => g.data && JSON.stringify(g.data).includes('"f_'))) result.notes.push("Some module data refers to files from the other instance; those files weren't moved.");
	return result;
}

