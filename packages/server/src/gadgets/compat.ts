import { readFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.ts";
import { GATEKEEPERS } from "../gatekeepers/catalog.ts";

/**
 * Version and capability checks for moving blueprints and gadgets between pi-os instances.
 *
 * - PIOS_VERSION: this pi-os (root package.json).
 * - GADGET_RUNTIME: the gadget API generation. Bump it only for changes that break existing gadgets
 *   (a renamed or removed ctx/gadget member, changed semantics). Adding members doesn't need a bump:
 *   features are checked by name.
 * - What a gadget needs is detected from its code (server: `ctx.X`, client: `gadget.X`, Gatekeepers:
 *   `ctx.gatekeepers.<ref>.<method>`) and, on export, from the grants it holds. Detection runs on import
 *   too, so a file can't skip the check by declaring less, and older (v1) files are checked as well.
 */
export const GADGET_RUNTIME = 1;
export const SERVER_FEATURES = ["storage", "files", "gatekeepers", "broadcast", "caller", "presence", "now", "id"];
export const CLIENT_FEATURES = ["api", "call", "on", "onPresence", "presence", "user", "id"];

export const PIOS_VERSION: string = (() => {
	try {
		return JSON.parse(readFileSync(join(config.repoRoot, "package.json"), "utf8")).version ?? "0.0.0";
	} catch {
		return "0.0.0";
	}
})();

export type Requires = { runtime: number; server: string[]; client: string[]; gatekeepers: { id: string; methods: string[] }[] };
export type Producer = { app: string; version: string; runtime: number };
export type Assessment = { status: "ok" | "warn" | "blocked"; issues: string[]; notes: string[] };

export const producer = (): Producer => ({ app: "pi-os", version: PIOS_VERSION, runtime: GADGET_RUNTIME });

/** What this instance offers, for /api/capabilities and checks. */
export function capabilities() {
	return {
		app: "pi-os",
		version: PIOS_VERSION,
		runtime: GADGET_RUNTIME,
		server: SERVER_FEATURES,
		client: CLIENT_FEATURES,
		gatekeepers: Object.values(GATEKEEPERS).map((g) => ({ id: g.id, methods: Object.keys(g.methods) })),
	};
}

const isServerFile = (path: string) => path === "server.js" || path.startsWith("server/");
const uniq = (xs: string[]) => [...new Set(xs)].sort();

/**
 * What a gadget's code needs. `grants` (its current Gatekeeper grants) resolves grant labels and ids
 * used as `ctx.gatekeepers.<ref>` to the Gatekeeper behind them.
 */
export function detectRequires(files: Record<string, string>, grants: { id: string; label: string; gatekeeper: string }[] = []): Requires {
	const server: string[] = [];
	const client: string[] = [];
	const gk = new Map<string, Set<string>>();
	const use = (id: string, method?: string) => {
		if (!gk.has(id)) gk.set(id, new Set());
		if (method) gk.get(id)!.add(method);
	};
	for (const [path, raw] of Object.entries(files)) {
		if (!/\.(m?js|html?)$/.test(path)) continue;
		// In HTML only scripts count (prose like "the gadget. Then" isn't code).
		const code = /\.html?$/.test(path) ? [...raw.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]).join("\n") : raw;
		if (isServerFile(path)) {
			for (const m of code.matchAll(/\bctx\.([A-Za-z_$][\w$]*)/g)) server.push(m[1]!);
			for (const m of code.matchAll(/\bctx\s*\.\s*gatekeepers\s*(?:\.\s*([A-Za-z_$][\w$]*)|\[\s*["'`]([^"'`]+)["'`]\s*\])\s*(?:\.\s*([A-Za-z_$][\w$]*)|\[\s*["'`]([^"'`]+)["'`]\s*\])?/g)) {
				const ref = m[1] ?? m[2]!;
				const method = m[3] ?? m[4];
				const grant = grants.find((g) => g.id === ref || g.label === ref);
				use(GATEKEEPERS[ref] ? ref : (grant?.gatekeeper ?? ref), method);
			}
		} else for (const m of code.matchAll(/\bgadget\.([A-Za-z_$][\w$]*)/g)) client.push(m[1]!);
	}
	// Grants it holds count even when the code reaches them dynamically.
	for (const g of grants) use(g.gatekeeper);
	return { runtime: GADGET_RUNTIME, server: uniq(server), client: uniq(client), gatekeepers: [...gk].map(([id, ms]) => ({ id, methods: [...ms].sort() })).sort((a, b) => a.id.localeCompare(b.id)) };
}

/** Merge what a file declares with what its code shows (the stricter of both). */
export function mergeRequires(declared: Partial<Requires> | undefined, detected: Requires): Requires {
	const d = declared ?? {};
	const gks = new Map<string, Set<string>>();
	for (const g of [...(Array.isArray(d.gatekeepers) ? d.gatekeepers : []), ...detected.gatekeepers]) {
		if (!g || typeof g.id !== "string") continue;
		if (!gks.has(g.id)) gks.set(g.id, new Set());
		for (const m of Array.isArray(g.methods) ? g.methods : []) if (typeof m === "string") gks.get(g.id)!.add(m);
	}
	const strs = (xs: unknown) => (Array.isArray(xs) ? xs.filter((x): x is string => typeof x === "string") : []);
	return {
		// The runtime generation is the exporter's statement (code can't show it); default 1 for old files.
		runtime: typeof d.runtime === "number" ? d.runtime : 1,
		server: uniq([...strs(d.server), ...detected.server]),
		client: uniq([...strs(d.client), ...detected.client]),
		gatekeepers: [...gks].map(([id, ms]) => ({ id, methods: [...ms].sort() })).sort((a, b) => a.id.localeCompare(b.id)),
	};
}

/**
 * The compatibility rules for whoever builds gadgets and blueprints (the agent's guide), generated from
 * the lists above so the guide can't drift from what the runtime and the import check accept.
 */
export function compatGuide(): string {
	const gks = Object.values(GATEKEEPERS)
		.map((g) => `\`${g.id}\` (${Object.keys(g.methods).join(", ")})`)
		.join(", ");
	return `Compatibility (gadget runtime v${GADGET_RUNTIME}, pi-os ${PIOS_VERSION}): gadgets and blueprints are exported and imported between pi-os instances, and an instance runs only the API it knows. Use only these members:
- server \`ctx\`: ${SERVER_FEATURES.map((f) => `\`ctx.${f}\``).join(", ")}
- client \`gadget\`: ${CLIENT_FEATURES.map((f) => `\`gadget.${f}\``).join(", ")}
- Gatekeepers on this instance: ${gks || "(none)"}
Anything else (\`ctx.fetch\`, \`ctx.setTimeout\`, \`gadget.storage\`, a Gatekeeper or method not listed) doesn't exist here: the server or page fails, and another instance's import check blocks the gadget. \`gadget_write\` and \`gadget_edit\` report a \`compat\` problem when code uses something outside this list; fix it before moving on.`;
}

/** Compare versions like 0.7.0 / 1.2 (numeric parts). */
export function compareVersions(a: string, b: string): number {
	const pa = a.split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
	const pb = b.split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
	return 0;
}

/** Can this instance run an item with these needs? blocked: it can't run; warn: parts won't work. */
export function assess(req: Requires, from?: Producer): Assessment {
	const issues: string[] = [];
	const notes: string[] = [];
	let status: Assessment["status"] = "ok";
	const block = (s: string) => ((status = "blocked"), issues.push(s));
	const warn = (s: string) => (status === "ok" && (status = "warn"), issues.push(s));
	if (req.runtime > GADGET_RUNTIME) block(`needs gadget runtime v${req.runtime}; this pi-os has v${GADGET_RUNTIME}. Update pi-os to import it.`);
	const server = req.server.filter((f) => !SERVER_FEATURES.includes(f));
	if (server.length) block(`its server uses ${server.map((f) => `ctx.${f}`).join(", ")}, which this pi-os doesn't provide`);
	const client = req.client.filter((f) => !CLIENT_FEATURES.includes(f));
	if (client.length) block(`its page uses ${client.map((f) => `gadget.${f}`).join(", ")}, which this pi-os doesn't provide`);
	for (const g of req.gatekeepers) {
		const local = GATEKEEPERS[g.id];
		if (!local) {
			warn(`it calls the “${g.id}” Gatekeeper, which this pi-os doesn't have; those calls will fail`);
			continue;
		}
		const missing = g.methods.filter((m) => !local.methods[m]);
		if (missing.length) warn(`the ${local.title} Gatekeeper here has no ${missing.join(", ")}; those calls will fail`);
		else notes.push(`needs ${local.title} access: grant it after importing`);
	}
	if (from?.version && compareVersions(from.version, PIOS_VERSION) > 0) warn(`exported from a newer pi-os (${from.version}; this is ${PIOS_VERSION})`);
	return { status, issues, notes };
}
