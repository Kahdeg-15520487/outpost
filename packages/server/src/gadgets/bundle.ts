import { blueprints, HttpError, newId, users, type BlueprintIntro, type BlueprintRow, type GadgetRow } from "../kernel/system-db.ts";
import type { Workspace } from "../kernel/workspace.ts";

/**
 * Moving blueprints and gadgets between pi-os instances: one portable JSON file (`*.pios.json`).
 *
 *   { "format": "pi-os/bundle", "version": 1, "exportedAt": "…",
 *     "blueprints": [{ name, description, icon, intro?, files: { path: text } }],
 *     "gadgets":    [{ name, icon, blueprint?, files: { path: text }, data?: { key: json } }] }
 *
 * Code travels as its source files; a gadget's stored data (its key/value state) only when asked.
 * Things that belong to one instance stay behind: shares, share links, Gatekeeper grants, workspace
 * files a gadget's data may point to, logs. Imported gadgets are new gadgets owned by the importer;
 * imported blueprints are new blueprints authored by the importer (private unless chosen otherwise).
 * Imported code runs in the same sandbox as any gadget (QuickJS server, CSP-locked iframe client).
 */
export const BUNDLE_FORMAT = "pi-os/bundle";
export const BUNDLE_VERSION = 1;

export type BundleBlueprint = { name: string; description: string; icon: string; intro?: BlueprintIntro; files: Record<string, string> };
export type BundleGadget = { name: string; icon: string; blueprint?: string; files: Record<string, string>; data?: Record<string, unknown> };
export type Bundle = { format: typeof BUNDLE_FORMAT; version: number; exportedAt: string; blueprints: BundleBlueprint[]; gadgets: BundleGadget[] };

const LIMITS = { items: 200, filesPerItem: 300, fileBytes: 2 << 20, itemBytes: 10 << 20, dataBytes: 20 << 20, name: 80, description: 2000 };
const PATH = /^[\w./-]{1,120}$/;

export function makeBundle(parts: { blueprints?: BlueprintRow[]; gadgets?: { row: GadgetRow; files: Record<string, string>; data?: Record<string, unknown> }[] }): Bundle {
	return {
		format: BUNDLE_FORMAT,
		version: BUNDLE_VERSION,
		exportedAt: new Date().toISOString(),
		blueprints: (parts.blueprints ?? []).map((b) => ({ name: b.name, description: b.description, icon: b.icon, ...(b.intro && Object.keys(b.intro).length ? { intro: b.intro } : {}), files: b.files })),
		gadgets: (parts.gadgets ?? []).map(({ row, files, data }) => ({
			name: row.name,
			icon: row.icon,
			...(row.blueprintId ? { blueprint: blueprints.get(row.blueprintId)?.name } : {}),
			files,
			...(data ? { data } : {}),
		})),
	};
}

/** A file name for a bundle: `todo.pios.json`, `pi-os-export-2026-10-23.pios.json`. */
export function bundleFileName(b: Bundle) {
	const one = b.blueprints.length + b.gadgets.length === 1 ? (b.blueprints[0]?.name ?? b.gadgets[0]?.name) : undefined;
	const stem = one ? one.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "export" : `pi-os-export-${b.exportedAt.slice(0, 10)}`;
	return `${stem}.pios.json`;
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
	if (!b || typeof b !== "object" || b.format !== BUNDLE_FORMAT) throw new HttpError(400, "Not a pi-os export file (expected format “pi-os/bundle”)");
	if (typeof b.version !== "number" || b.version > BUNDLE_VERSION) throw new HttpError(400, `This file is from a newer pi-os (bundle version ${b.version}); update this instance to import it`);
	const bps = Array.isArray(b.blueprints) ? b.blueprints : [];
	const gs = Array.isArray(b.gadgets) ? b.gadgets : [];
	if (!bps.length && !gs.length) throw new HttpError(400, "The file contains no blueprints or gadgets");
	if (bps.length + gs.length > LIMITS.items) throw new HttpError(400, `Too many items (${bps.length + gs.length} > ${LIMITS.items})`);
	return {
		format: BUNDLE_FORMAT,
		version: b.version,
		exportedAt: str(b.exportedAt, 40),
		blueprints: bps.map((x: any, i) => {
			const where = `Blueprint ${i + 1}${x?.name ? ` “${str(x.name, 40)}”` : ""}`;
			const name = str(x?.name, LIMITS.name).trim();
			if (!name) throw new HttpError(400, `${where}: missing name`);
			const intro = x?.intro && typeof x.intro === "object" ? (JSON.parse(JSON.stringify(x.intro)) as BlueprintIntro) : undefined;
			return { name, description: str(x?.description, LIMITS.description), icon: str(x?.icon, 8, "◆") || "◆", ...(intro ? { intro } : {}), files: files(x?.files, where) };
		}),
		gadgets: gs.map((x: any, i) => {
			const where = `Gadget ${i + 1}${x?.name ? ` “${str(x.name, 40)}”` : ""}`;
			const name = str(x?.name, LIMITS.name).trim();
			if (!name) throw new HttpError(400, `${where}: missing name`);
			let data: Record<string, unknown> | undefined;
			if (x?.data !== undefined) {
				if (!x.data || typeof x.data !== "object" || Array.isArray(x.data)) throw new HttpError(400, `${where}: data must be an object`);
				const json = JSON.stringify(x.data);
				if (json.length > LIMITS.dataBytes) throw new HttpError(400, `${where}: data too large`);
				data = JSON.parse(json);
			}
			return { name, icon: str(x?.icon, 8, "◆") || "◆", ...(x?.blueprint ? { blueprint: str(x.blueprint, LIMITS.name) } : {}), files: files(x?.files, where), ...(data ? { data } : {}) };
		}),
	};
}

export type ImportResult = { blueprints: { id: string; name: string }[]; gadgets: { id: string; name: string; data: boolean }[]; notes: string[] };

/** Create the bundle's blueprints (for the user) and gadgets (in this workspace, owned by the user). */
export async function importBundle(ws: Workspace | undefined, userId: string, b: Bundle, opts: { visibility: "public" | "private" }): Promise<ImportResult> {
	if (b.gadgets.length && !ws) throw new HttpError(400, "Open a workspace to import gadgets into");
	const result: ImportResult = { blueprints: [], gadgets: [], notes: [] };
	const author = users.get(userId)?.displayName ?? "you";
	for (const bp of b.blueprints) {
		const row: BlueprintRow = { id: newId("bp"), name: bp.name, description: bp.description, icon: bp.icon, authorId: userId, visibility: opts.visibility, files: bp.files, createdAt: Date.now(), intro: bp.intro };
		blueprints.upsert(row);
		result.blueprints.push({ id: row.id, name: row.name });
	}
	for (const g of b.gadgets) {
		const row = await ws!.createGadget({ name: g.name, icon: g.icon, ownerId: userId, files: g.files });
		if (g.data && Object.keys(g.data).length) await ws!.setGadgetState(row.id, g.data);
		result.gadgets.push({ id: row.id, name: row.name, data: !!g.data });
	}
	if (b.gadgets.length) result.notes.push(`Gadgets arrive owned by ${author}, unshared, with no Gatekeeper access: grant what they need again.`);
	if (b.gadgets.some((g) => g.data && JSON.stringify(g.data).includes('"f_'))) result.notes.push("Some gadget data refers to files from the other instance; those files weren't moved.");
	return result;
}

