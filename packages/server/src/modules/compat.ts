import { readFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.ts";
import { AIRLOCKS } from "../airlocks/catalog.ts";
import { CONNECTOR_INFO } from "../airlocks/connectors/types.ts";

/**
 * Version and capability checks for moving blueprints and modules between outpost instances.
 *
 * - OUTPOST_VERSION: this outpost (root package.json).
 * - MODULE_RUNTIME: the module API generation. Bump it only for changes that break existing modules
 *   (a renamed or removed ctx/module member, changed semantics). Adding members doesn't need a bump:
 *   features are checked by name.
 * - What a module needs is detected from its code (server: `ctx.X`, client: `module.X`, Airlocks:
 *   `ctx.airlocks.<ref>.<method>`) and, on export, from the grants it holds. Detection runs on import
 *   too, so a file can't skip the check by declaring less. Legacy runtime versions are refused.
 */
export const MODULE_RUNTIME = 2;
export const SERVER_FEATURES = ["storage", "files", "airlocks", "broadcast", "caller", "presence", "now", "id"];
export const CLIENT_FEATURES = ["api", "call", "on", "onPresence", "presence", "user", "id"];

export const OUTPOST_VERSION: string = (() => {
	try {
		return JSON.parse(readFileSync(join(config.repoRoot, "package.json"), "utf8")).version ?? "0.0.0";
	} catch {
		return "0.0.0";
	}
})();

export type Requires = { runtime: number; server: string[]; client: string[]; airlocks: { id: string; methods: string[] }[]; vendored?: string[] };
export type Producer = { app: string; version: string; runtime: number };
export type Assessment = { status: "ok" | "warn" | "blocked"; issues: string[]; notes: string[] };

export const producer = (): Producer => ({ app: "outpost", version: OUTPOST_VERSION, runtime: MODULE_RUNTIME });

/** What this instance offers, for /api/capabilities and checks. */
export function capabilities() {
	return {
		app: "outpost",
		version: OUTPOST_VERSION,
		runtime: MODULE_RUNTIME,
		server: SERVER_FEATURES,
		client: CLIENT_FEATURES,
		airlocks: Object.values(AIRLOCKS).map((g) => ({ id: g.id, methods: Object.keys(g.methods) })),
	};
}

const isServerFile = (path: string) => path === "server.js" || path.startsWith("server/");
const uniq = (xs: string[]) => [...new Set(xs)].sort();

/**
 * What a module's code needs. `grants` (its current Airlock grants) resolves grant labels and ids
 * used as `ctx.airlocks.<ref>` to the Airlock behind them.
 */
/**
 * Is this file somebody else's minified library rather than code we wrote? Vendored bundles are full of
 * legitimate Node-isms (`module.exports` guards in a UMD wrapper) that say nothing about how the module
 * uses our API — scanning them turned every edit of a deck with PptxGenJS in it into a blocking warning.
 *
 * Three signals, any one is enough: an explicit banner a packer can leave behind, the usual minified
 * names, or a size no hand-written client file reaches.
 */
export const VENDOR_BYTES = 120_000;
export function isVendored(path: string, source: string): boolean {
	if (/\/\*\s*outpost:vendor\s*\*\//i.test(source) || /\/\/\s*outpost:vendor/i.test(source)) return true;
	if (/(\.bundle|\.min|\.vendor)\.(m?js)$/i.test(path) || /(^|\/)(vendor|third[-_]?party|libs?)\//i.test(path)) return true;
	if (source.length > VENDOR_BYTES) return true;
	// A single very long line is minified output, whatever it is called.
	const firstBreak = source.indexOf("\n");
	return (firstBreak === -1 ? source.length : firstBreak) > 5_000;
}

export function detectRequires(files: Record<string, string>, grants: { id: string; label: string; airlock: string }[] = []): Requires {
	const server: string[] = [];
	const client: string[] = [];
	const vendored: string[] = [];
	const gk = new Map<string, Set<string>>();
	const use = (id: string, method?: string) => {
		if (!gk.has(id)) gk.set(id, new Set());
		if (method) gk.get(id)!.add(method);
	};
	for (const [path, raw] of Object.entries(files)) {
		if (!/\.(m?js|html?)$/.test(path)) continue;
		// Vendored libraries are shipped as-is: their internals are not a statement about our API.
		if (isVendored(path, raw)) {
			vendored.push(path);
			continue;
		}
		// In HTML only scripts count (prose like "the module. Then" isn't code).
		const code = /\.html?$/.test(path) ? [...raw.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]).join("\n") : raw;
		if (isServerFile(path)) {
			for (const m of code.matchAll(/\bctx\.([A-Za-z_$][\w$]*)/g)) server.push(m[1]!);
			for (const m of code.matchAll(/\bctx\s*\.\s*airlocks\s*(?:\.\s*([A-Za-z_$][\w$]*)|\[\s*["'`]([^"'`]+)["'`]\s*\])\s*(?:\.\s*([A-Za-z_$][\w$]*)|\[\s*["'`]([^"'`]+)["'`]\s*\])?/g)) {
				const ref = m[1] ?? m[2]!;
				const method = m[3] ?? m[4];
				const grant = grants.find((g) => g.id === ref || g.label === ref);
				use(AIRLOCKS[ref] ? ref : (grant?.airlock ?? ref), method);
			}
		} else for (const m of code.matchAll(/\bmodule\.([A-Za-z_$][\w$]*)/g)) client.push(m[1]!);
	}
	// Grants it holds count even when the code reaches them dynamically.
	for (const g of grants) use(g.airlock);
	return {
		runtime: MODULE_RUNTIME,
		server: uniq(server),
		client: uniq(client),
		airlocks: [...gk].map(([id, ms]) => ({ id, methods: [...ms].sort() })).sort((a, b) => a.id.localeCompare(b.id)),
		// Reported so a skipped file is visible instead of silently trusted.
		vendored: vendored.sort(),
	};
}

/** Merge what a file declares with what its code shows (the stricter of both). */
export function mergeRequires(declared: Partial<Requires> | undefined, detected: Requires): Requires {
	const d = declared ?? {};
	const gks = new Map<string, Set<string>>();
	for (const g of [...(Array.isArray(d.airlocks) ? d.airlocks : []), ...detected.airlocks]) {
		if (!g || typeof g.id !== "string") continue;
		if (!gks.has(g.id)) gks.set(g.id, new Set());
		for (const m of Array.isArray(g.methods) ? g.methods : []) if (typeof m === "string") gks.get(g.id)!.add(m);
	}
	const strs = (xs: unknown) => (Array.isArray(xs) ? xs.filter((x): x is string => typeof x === "string") : []);
	return {
		// Undeclared requirements use this Outpost runtime; legacy exports require offline conversion.
		runtime: typeof d.runtime === "number" ? d.runtime : MODULE_RUNTIME,
		server: uniq([...strs(d.server), ...detected.server]),
		client: uniq([...strs(d.client), ...detected.client]),
		airlocks: [...gks].map(([id, ms]) => ({ id, methods: [...ms].sort() })).sort((a, b) => a.id.localeCompare(b.id)),
	};
}

/**
 * The compatibility rules for whoever builds modules and blueprints (the agent's guide), generated from
 * the lists above so the guide can't drift from what the runtime and the import check accept.
 */
export function compatGuide(): string {
	const gks = Object.values(AIRLOCKS)
		.map((g) => `\`${g.id}\` (${Object.keys(g.methods).join(", ")})`)
		.join(", ");
	return `Compatibility (module runtime v${MODULE_RUNTIME}, outpost ${OUTPOST_VERSION}): modules and blueprints are exported and imported between outpost instances, and an instance runs only the API it knows. Use only these members:
- server \`ctx\`: ${SERVER_FEATURES.map((f) => `\`ctx.${f}\``).join(", ")}
- client \`module\`: ${CLIENT_FEATURES.map((f) => `\`module.${f}\``).join(", ")}
- Airlocks on this instance: ${gks || "(none)"}, plus the workspace's connections (MCP servers, REST APIs) granted to the module, called the same way: \`await ctx.airlocks["<label>"].<method>(args)\`. A write on a connection resolves to \`{status: "pending", actionId}\` until someone approves it.
Anything else (\`ctx.fetch\`, \`ctx.setTimeout\`, \`module.storage\`, a Airlock or method not listed) doesn't exist here: the server or page fails, and another instance's import check blocks the module. \`module_write\` and \`module_edit\` report a \`compat\` problem when code uses something outside this list; fix it before moving on.`;
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
	if (req.runtime < MODULE_RUNTIME) block(`uses legacy runtime v${req.runtime}; migrate its code to the Outpost module API before importing`);
	if (req.runtime > MODULE_RUNTIME) block(`needs module runtime v${req.runtime}; this outpost has v${MODULE_RUNTIME}. Update outpost to import it.`);
	const server = req.server.filter((f) => !SERVER_FEATURES.includes(f));
	if (server.length) block(`its server uses ${server.map((f) => `ctx.${f}`).join(", ")}, which this outpost doesn't provide`);
	const client = req.client.filter((f) => !CLIENT_FEATURES.includes(f));
	if (client.length) block(`its page uses ${client.map((f) => `module.${f}`).join(", ")}, which this outpost doesn't provide`);
	for (const g of req.airlocks) {
		const connector = CONNECTOR_INFO[g.id as keyof typeof CONNECTOR_INFO];
		if (connector) {
			// Generic connectors: the methods depend on the service connected, so only the grant can tell.
			notes.push(`calls a workspace connection (${connector.title}${g.methods.length ? `: ${g.methods.join(", ")}` : ""}): add the service under Connections and grant it after importing`);
			continue;
		}
		const local = AIRLOCKS[g.id];
		if (!local) {
			warn(`it calls the “${g.id}” Airlock, which this outpost doesn't have; those calls will fail`);
			continue;
		}
		const missing = g.methods.filter((m) => !local.methods[m]);
		if (missing.length) warn(`the ${local.title} Airlock here has no ${missing.join(", ")}; those calls will fail`);
		else notes.push(`needs ${local.title} access: grant it after importing`);
	}
	if (from?.version && compareVersions(from.version, OUTPOST_VERSION) > 0) warn(`exported from a newer outpost (${from.version}; this is ${OUTPOST_VERSION})`);
	return { status, issues, notes };
}
