/**
 * How a tool call reads in the transcript. The agent works with ids; the reader should see the file,
 * module or blueprint it acted on. These checks pin the mapping and, more importantly, that no id
 * sneaks back into the summary line.
 */

import { check, finish } from "./lib/harness.ts";
import { describeArgs, type CallNames } from "../../web/src/toolargs.ts";

const names: CallNames = {
	files: { f_23696ca26acd: { name: "Q3 planning.pptx" }, f_8a4b966d3dc5: { name: "brief.docx" } },
	modules: [
		{ id: "g_d038200d4fd9490a", name: "Todo" },
		{ id: "g_1111111111aaaaaa", name: "Slides (Rosenxt)" },
	],
	blueprints: [
		{ id: "bp_todo", name: "Shared task list" },
		{ id: "bp_slides", name: "Slides" },
	],
};

try {
	const file = describeArgs("file_info", { file: "f_23696ca26acd" }, names);
	check("a file id becomes the file's name", file === "Q3 planning.pptx", file);

	const missing = describeArgs("file_read", { file: "f_00000000deadbeef" }, names);
	check("a file that no longer exists says so", missing === "a file that is gone", missing);
	check("…without leaking its id", !/f_[0-9a-f]/.test(missing), missing);

	const byName = describeArgs("file_info", { file: "Q3 planning.pptx" }, names);
	check("a name the agent passed through is left alone", byName === "Q3 planning.pptx", byName);

	const mod = describeArgs("module_read", { module: "g_d038200d4fd9490a", path: "app.js" }, names);
	check("a module id becomes the module's name", mod === "Todo · app.js", mod);

	const write = describeArgs("module_write", { module: "g_d038200d4fd9490a", path: "app.js", content: "x".repeat(1204) }, names);
	check("module_write reads as name · path · size", write === "Todo · app.js · 1204 chars", write);

	const unzip = describeArgs("file_unzip", { file: "f_23696ca26acd", match: "ppt/slides" }, names);
	check("an archive entry keeps its match pattern, without the key", unzip === "Q3 planning.pptx · /ppt/slides/", unzip);

	const search = describeArgs("file_search", { file: "f_8a4b966d3dc5", text: "revenue" }, names);
	check("a search says which file and what for", search === "brief.docx · \"revenue\"", search);

	const made = describeArgs("module_create", { name: "Notes", blueprint: "bp_slides" }, names);
	check("a created module names its blueprint", made === "Notes · from the Slides blueprint", made);

	const published = describeArgs("blueprint_publish", { module: "g_1111111111aaaaaa", name: "Team slides", description: "deck" }, names);
	check("publishing names the module and the new blueprint", published === "Slides (Rosenxt) · as \"Team slides\"", published);

	const script = describeArgs("codemode", { code: "const r = await tools.module_list({});\nconsole.log(r)" }, names);
	check("codemode shows its first line", script === "const r = await tools.module_list({});", script);

	const empty = describeArgs("module_list", {}, names);
	check("a call with no arguments has no summary", empty === "", empty);

	// The point of the change: no identifier reaches the summary line.
	const calls: [string, Record<string, unknown>][] = [
		["file_info", { file: "f_23696ca26acd" }],
		["file_read", { file: "f_8a4b966d3dc5", offset: 0, length: 4096 }],
		["file_unzip", { file: "f_23696ca26acd", match: "ppt/slides" }],
		["file_share_with_module", { file: "f_23696ca26acd", module: "g_d038200d4fd9490a" }],
		["module_read", { module: "g_d038200d4fd9490a", path: "app.js" }],
		["module_call", { module: "g_d038200d4fd9490a", method: "list", args: [1, "two"] }],
		["module_create", { name: "Notes", blueprint: "bp_todo" }],
		["blueprint_publish", { module: "g_1111111111aaaaaa", name: "Deck", description: "d" }],
	];
	const lines = calls.map(([tool, args]) => `${tool}: ${describeArgs(tool, args, names)}`);
	check("no summary line contains a raw id", lines.every((line) => !/\b(f|g|mod|bp)_[0-9a-z]{6,}\b/.test(line)), lines);
	check("every summary line actually says something", lines.every((line) => line.split(": ")[1]?.length), lines);
	check("module_call keeps the call shape", describeArgs("module_call", { module: "g_d038200d4fd9490a", method: "list", args: [1, "two"] }, names) === "Todo · list(1, two)");

	// Long values are clipped rather than wrapping the header.
	const long = describeArgs("subagent", { task: "x".repeat(400) }, names);
	check("a long task is clipped", long.length <= 92, long.length);
} catch (error) {
	await finish(error);
}
await finish();
