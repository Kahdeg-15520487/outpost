/**
 * What a tool call looks like in the transcript. Tool arguments are ids — `file=f_23696ca26acd`,
 * `module=g_d038200d4fd9490a` — and an id is an implementation detail, so each one is turned back
 * into the thing it names: the file's name, the module's name, the blueprint's name. Anything that
 * can't be resolved says so plainly instead of spilling the id into the conversation.
 */

/** Anything with an id and a display name: a module, a blueprint, a mission. */
type Named = { id: string; name: string };

/** What the labels resolve against — the workspace's files, modules and blueprints, structurally. */
export type CallNames = {
	files?: Record<string, { name?: string } | undefined>;
	modules?: Named[];
	blueprints?: Named[];
};

/** Ids the app hands out: `f_…` files, `g_…`/`mod_…` modules, `bp_…` blueprints, `p_…` missions. */
const looksLikeId = (value: string) => /^(f|g|mod|bp|p|w|u|c)_[0-9a-z]{4,}$/i.test(value);

/** Cut very long values (code, content, paths) so the header stays one line. */
const clip = (value: string, max = 60) => (value.length > max ? `${value.slice(0, max - 1)}…` : value);

const scalar = (value: unknown): string => {
	if (value === null || value === undefined) return "";
	if (typeof value === "string") return clip(value);
	if (typeof value === "object") return clip(JSON.stringify(value), 40);
	return String(value);
};

function fileLabel(names: CallNames, value: string): string {
	if (!looksLikeId(value)) return value;
	return names.files?.[value]?.name ?? "a file that is gone";
}

function moduleLabel(names: CallNames, value: string): string {
	if (!looksLikeId(value)) return value;
	return names.modules?.find((m) => m.id === value)?.name ?? "a module that is gone";
}

function blueprintLabel(names: CallNames, value: string): string {
	if (!looksLikeId(value)) return value;
	return names.blueprints?.find((b) => b.id === value)?.name ?? "a blueprint that is gone";
}

/** Keys that have a place of their own in the summary, so they never show up as `key=value`. */
const NAMED = new Set([
	"file",
	"module",
	"blueprint",
	"path",
	"match",
	"text",
	"query",
	"hex",
	"content",
	"code",
	"args",
	"task",
	// Prose fields: a description belongs in the expanded call, not in the header line.
	"name",
	"description",
	"visibility",
	"method",
	"to",
	"save_as",
	"encoding",
	"mime",
]);

/**
 * A one-line summary of a tool call: the *thing* it acts on first, then the interesting detail.
 *
 *   file_unzip   "Q3 planning.pptx" · ppt/slides
 *   module_read  "Todo" · app.js
 *   module_write "Todo" · app.js (1204 chars)
 *   file_search  "Q3 planning.pptx" · "revenue"
 */
export function describeArgs(tool: string, args: Record<string, unknown> | undefined, names: CallNames = {}): string {
	if (!args || typeof args !== "object") return "";
	if (tool === "codemode") return clip(String(args.code ?? "").split("\n").find((line) => line.trim()) ?? "", 90);
	if (tool === "subagent") return clip(String(args.task ?? ""), 90);

	const bits: string[] = [];
	const add = (value: string | undefined) => {
		const text = (value ?? "").trim();
		if (text && !bits.includes(text)) bits.push(text);
	};

	// The subject: a file, a module, a blueprint — in that order, whichever the tool takes.
	if (typeof args.file === "string") add(fileLabel(names, args.file));
	if (typeof args.module === "string") add(moduleLabel(names, args.module));
	// file_write names its file instead of pointing at one.
	if (tool === "file_write" && typeof args.name === "string") add(args.name);
	if (tool === "module_create" && typeof args.name === "string") add(args.name);
	if (typeof args.blueprint === "string") add(`from the ${blueprintLabel(names, args.blueprint)} blueprint`);

	// Then the part of it being touched.
	if (typeof args.path === "string") add(args.path);
	if (typeof args.match === "string") add(`/${args.match}/`);
	if (typeof args.query === "string") add(`"${args.query}"`);
	if (typeof args.text === "string") add(`"${clip(args.text, 40)}"`);
	if (typeof args.hex === "string") add(`hex ${args.hex}`);
	if (tool === "file_convert" && typeof args.to === "string") add(`to ${args.to}`);
	if (tool === "file_write" && typeof args.content === "string") add(`${args.content.length} chars`);
	if (tool === "file_inflate" && typeof args.save_as === "string") add(`save as ${args.save_as}`);
	if (tool === "module_write" && typeof args.content === "string") add(`${args.content.length} chars`);
	if (tool === "module_call" && typeof args.method === "string") {
		const call = Array.isArray(args.args) ? `${args.method}(${args.args.map(scalar).join(", ")})` : args.method;
		add(clip(call, 70));
	}
	if (tool === "blueprint_publish" && typeof args.name === "string") add(`as "${args.name}"`);
	if (tool === "request_access") {
		for (const key of ["airlock", "connection", "resource", "forModule"] as const) {
			const value = args[key];
			if (typeof value !== "string") continue;
			add(key === "forModule" ? `for ${moduleLabel(names, value)}` : value);
		}
	}

	// Whatever is left reads as `key=value`, still skipping the ones already used.
	for (const [key, value] of Object.entries(args)) {
		if (NAMED.has(key) || value === undefined || value === null || value === "") continue;
		add(`${key}=${scalar(value)}`);
	}

	return clip(bits.join(" · "), 110);
}
