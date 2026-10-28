/**
 * Artifacts in the chat: the marker parser, the grid/jq logic behind the interactive views, and
 * the write-back path a Markdown checklist uses. The rendering itself is checked in ui.ts.
 */

import { check, finish, startServer } from "./lib/harness.ts";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { embedMarker, hasEmbeds, splitEmbeds } from "../../web/src/artifacts/embeds.ts";
import { runQuery, describeRun } from "../../web/src/artifacts/jq.ts";
import { chartPoints, columnKinds, filterRows, gridFromJson, gridFromSheet, sortRows, ticks, tsvOf } from "../../web/src/artifacts/table.ts";

const base = await startServer();
try {
	// ------------------------------------------------------------------ markers
	const one = splitEmbeds("Before.\n![[f_1a2b3c4d5e6f]]\nAfter.");
	check(
		"a marker line becomes an embed between the prose around it",
		one.length === 3 && one[0]!.kind === "md" && one[1]!.kind === "embed" && one[2]!.kind === "md",
		one.map((s) => s.kind),
	);
	check("the embed carries the file id", one[1]!.kind === "embed" && one[1]!.id === "f_1a2b3c4d5e6f");
	const captioned = splitEmbeds("![[f_1a2b3c4d5e6f|Q3 revenue by region]]");
	check("a caption after the pipe becomes the title", captioned[0]!.kind === "embed" && captioned[0]!.title === "Q3 revenue by region", captioned);
	check("an unfinished marker mid-stream stays text", splitEmbeds("here: ![[f_1a2b3c").every((s) => s.kind === "md"));
	check("a marker inside a sentence is not an embed", splitEmbeds("see ![[f_1a2b3c4d5e6f]] inline").every((s) => s.kind === "md"));
	check("indented markers still work", splitEmbeds("  ![[f_1a2b3c4d5e6f]]").some((s) => s.kind === "embed"));
	check("hasEmbeds is a cheap gate", hasEmbeds("no markers here") === false && hasEmbeds("![[f_1a2b3c4d5e6f]]") === true);
	check("embedMarker round-trips through the parser", splitEmbeds(embedMarker("f_1a2b3c4d5e6f", "Totals"))[0]?.kind === "embed");
	const many = splitEmbeds("A\n![[f_1a2b3c4d5e6f]]\nB\n![[f_ffffffffffff|two]]\nC");
	check("several markers in one reply keep their order", many.filter((s) => s.kind === "embed").map((s) => (s.kind === "embed" ? s.id : "")).join() === "f_1a2b3c4d5e6f,f_ffffffffffff");
	check("prose between markers survives", many.filter((s) => s.kind === "md").map((s) => (s.kind === "md" ? s.text.trim() : "")).join("|") === "A|B|C");

	// ------------------------------------------------------------------ grids
	const sheet = {
		name: "Sheet1",
		rows: 4,
		cols: 4,
		cells: [
			{ row: 0, col: 0, value: "region", type: "string" },
			{ row: 0, col: 1, value: "revenue", type: "string" },
			{ row: 0, col: 2, value: "when", type: "string" },
			{ row: 0, col: 3, value: null, type: "empty" },
			{ row: 1, col: 0, value: "EMEA", type: "string" },
			{ row: 1, col: 1, value: 120, type: "number" },
			{ row: 1, col: 2, value: "2026-01-04", type: "string" },
			{ row: 2, col: 0, value: "APAC", type: "string" },
			{ row: 2, col: 1, value: 60, type: "number" },
			{ row: 2, col: 2, value: "2026-02-11", type: "string" },
			{ row: 3, col: 0, value: "AMER", type: "string" },
			{ row: 3, col: 1, value: 300, type: "number" },
			{ row: 3, col: 2, value: "2026-03-02", type: "string" },
		],
	};
	const grid = gridFromSheet(sheet);
	check("the first row becomes the header", grid.header.join() === "region,revenue,when");
	check("header rows are not repeated as data", grid.rows.length === 3);
	check("trailing empty columns are dropped", grid.header.length === 3);
	check("column types are detected", columnKinds(grid).join() === "text,number,date", columnKinds(grid));
	check("numbers sort numerically, not as text", sortRows(grid, 1, "desc").map((r) => r[1]).join() === "300,120,60");
	check("text sorts alphabetically", sortRows(grid, 0, "asc").map((r) => r[0]).join() === "AMER,APAC,EMEA");
	check("filter matches any cell", filterRows(grid.rows, "apac").length === 1);
	check("filter with two terms narrows", filterRows(grid.rows, "emea 120").length === 1 && filterRows(grid.rows, "emea 300").length === 0);
	check("numbers are searchable as text", filterRows(grid.rows, "300").length === 1 && filterRows(grid.rows, "060").length === 0);
	check("TSV starts with the header line", tsvOf(grid.header, grid.rows).split("\n")[0] === "region\trevenue\twhen");
	check("TSV has one line per row", tsvOf(grid.header, grid.rows).split("\n").length === 4);
	const blanks = gridFromSheet({ rows: 3, cols: 2, cells: [{ row: 0, col: 0, value: "a" }, { row: 0, col: 1, value: 1 }, { row: 1, col: 0, value: null }, { row: 2, col: 0, value: "z" }] });
	check("blank cells sort last in both directions", sortRows(blanks, 0, "asc").at(-1)?.[0] === null && sortRows(blanks, 0, "desc").at(-1)?.[0] === null);
	const headless = gridFromSheet({ rows: 2, cols: 2, cells: [{ row: 0, col: 0, value: 1 }, { row: 1, col: 0, value: 2 }] });
	check("a numeric first row is data, not a header", headless.header.join() === "Col 1" && headless.rows.length === 2, headless.header);

	// ------------------------------------------------------------------ charts
	const points = chartPoints(grid.rows, 0, 1);
	check("the chart takes one point per numeric row", points.length === 3 && points[0]!.label === "EMEA" && points[0]!.value === 120);
	check("rows without a number are skipped", chartPoints(grid.rows, 0, 2).length === 0);
	const wide = { header: ["x", "y"], rows: Array.from({ length: 1000 }, (_, i) => [`r${i}`, i] as (string | number)[]) };
	check("a large series is sampled down", chartPoints(wide.rows, 0, 1).length === 200);
	check("ticks cover the data in round steps", ticks(0, 300, 5).join() === "0,100,200,300", ticks(0, 300, 5));
	check("ticks handle a flat series", ticks(5, 5).length >= 1);
	check("negative values are covered", ticks(-40, 90, 4)[0]! <= -40);

	// ------------------------------------------------------------------ jq-lite
	const data = {
		team: { name: "Outpost", size: 3, tags: ["ai", "os"] },
		items: [
			{ id: 1, name: "alpha", score: 30 },
			{ id: 2, name: "beta", score: 10 },
			{ id: 3, name: "gamma", score: 20 },
		],
		empty: [],
		dup: [1, 1, 2],
	};
	const q = (expr: string) => runQuery(data, expr);
	const values = (expr: string) => {
		const r = q(expr);
		if ("error" in r) throw new Error(`${expr}: ${r.error}`);
		return r.values;
	};
	const failure = (expr: string) => {
		const r = q(expr);
		return "error" in r ? r.error : "";
	};
	const first = (expr: string) => values(expr)[0];
	check("identity returns the value", first(".") === data);
	check("an empty query is identity too", first("") === data);
	check("field access walks a path", first(".team.name") === "Outpost");
	check("a missing key yields nothing", values(".team.nope").length === 0);
	check("bracket keys allow spaces", first('.team["name"]') === "Outpost");
	check("index picks one element", first(".items[1].name") === "beta");
	check("negative index counts from the end", first(".items[-1].name") === "gamma");
	check("iteration fans out", values(".items[].name").join() === "alpha,beta,gamma");
	check("map applies an expression", JSON.stringify(first(".items | map(.score)")) === "[30,10,20]");
	check("pipes compose", values(".items[] | .score").join() === "30,10,20");
	check("length counts", first(".items | length") === 3);
	check("keys lists an object's keys", (first(".team | keys") as string[]).join() === "name,size,tags");
	check("type names the kind", first(".items | type") === "array");
	check("sort orders numerically", JSON.stringify(first(".items | map(.score) | sort")) === "[10,20,30]");
	check("sort_by keeps whole records", first(".items | sort_by(.score) | .[0].name") === "beta");
	check("add sums numbers", first(".items | map(.score) | add") === 60);
	check("join makes a string", first('.items | map(.name) | join(", ")') === "alpha, beta, gamma");
	check("unique drops duplicates", JSON.stringify(first(".dup | unique")) === "[1,2]");
	check("nested iteration flattens a level", values(".team.tags[]").join() === "ai,os");
	check("an empty array iterates to nothing", values(".empty[]").length === 0);
	check("unknown functions explain themselves", /unknown function/.test(failure(".items | flip()")));
	check("bad brackets explain themselves", /unclosed/.test(failure(".items[0")));
	check("describeRun counts results", describeRun(q(".items[].name")) === "3 results");
	check("describeRun names a single array", describeRun(q(".items")) === "1 array · 3 items");

	// ------------------------------------------------------------------ json → table
	const asGrid = gridFromJson([{ a: 1, b: { c: 2 } }, { a: 3, b: null }]);
	check("an array of objects becomes a table", asGrid?.header.join() === "a,b" && asGrid.rows.length === 2);
	check("nested values are stringified, not dropped", String(asGrid?.rows[0]![1]).includes("\"c\":2"));
	check("a scalar is not a table", gridFromJson(42) === undefined);
	check("an array of scalars is not a table", gridFromJson([1, 2, 3]) === undefined);

	// ------------------------------------------------------------------ write-back
	const { users, workspaces } = await import("../src/kernel/system-db.ts");
	const { Workspace } = await import("../src/kernel/workspace.ts");
	const user = users.create("artifact-owner", "password123", "Artifact owner");
	const workspace = workspaces.create("Artifacts", user.id);
	const ws = await Workspace.get(workspace.id);
	const checklist = "# Plan\n\n- [ ] write the parser\n- [ ] ship it\n";
	const meta = await ws.files.put(Buffer.from(checklist, "utf8"), { name: "plan.md", createdBy: "Agent", source: "agent" });
	const parsed = await ws.parsed(meta);
	check("a markdown file parses as text with its task lines", parsed.kind === "text" && (parsed as any).text.includes("- [ ] ship it"));

	const session = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "artifact-owner", password: "password123" }) });
	const cookies = (session.headers.getSetCookie?.() ?? [session.headers.get("set-cookie") ?? ""]).map((c) => c.split(";")[0]).join("; ");
	const put = (text: string) =>
		fetch(`${base}/api/w/${ws.id}/files/${meta.id}/content`, { method: "PUT", headers: { "content-type": "application/json", cookie: cookies }, body: JSON.stringify({ text }) });
	const res = await put(checklist.replace("- [ ] ship it", "- [x] ship it"));
	check("ticking a checkbox writes the file back", res.ok, await res.text());
	const after = await ws.files.get(meta.id);
	check("the file keeps its id", after.id === meta.id);
	check("the bytes changed", after.sha256 !== meta.sha256, `${meta.sha256} → ${after.sha256}`);
	const reparsed = await ws.parsed(after);
	check("the re-parse shows the tick", (reparsed as any).text.includes("- [x] ship it"), (reparsed as any).text);
	check("the superseded blob is collected", !existsSync(join(ws.files.dir, meta.sha256)), join(ws.files.dir, meta.sha256));
	check("the new blob is on disk", existsSync(join(ws.files.dir, after.sha256)));

	const png = await ws.files.put(Buffer.from("89504e470d0a1a0a", "hex"), { name: "dot.png", createdBy: user.id, source: "upload" });
	const rejected = await fetch(`${base}/api/w/${ws.id}/files/${png.id}/content`, { method: "PUT", headers: { "content-type": "application/json", cookie: cookies }, body: JSON.stringify({ text: "x" }) });
	check("binary files refuse a text write", rejected.status === 400 && /not a text file/.test(await rejected.text()));

	// the convention the agent is given, so a rename of the marker cannot drift from the renderer
	const { FILES_GUIDE } = await import("../src/files/tools.ts");
	check("the file guide teaches the embed marker", /!\[\[f_/.test(FILES_GUIDE) && /caption/i.test(FILES_GUIDE));
	check("the guide names the interactive views", /sandboxed|checkboxes/.test(FILES_GUIDE));
	await finish();
} catch (error) {
	await finish(error as Error);
}

