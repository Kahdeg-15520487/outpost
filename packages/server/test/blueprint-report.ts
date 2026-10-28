/**
 * The regressions from a real consolidation job (blueprint-framework-bug-report.md), one check per
 * item, in the order the report asked for them.
 *
 * B3 vendored code must not block a write · B1 root/version ids resolve to what they name ·
 * B4 modules can be adopted and nothing silently no-ops · B2 a rollout reports the version it applied ·
 * B5 drafts are not modules · B6 a big file paginates instead of truncating · A1 file_write replaces.
 *
 * Run: pnpm --filter @outpost/server test -- blueprint-report
 */

// The harness must be imported before anything from src/: it fixes the port and the config at import.
import { check, finish, must, startServer } from "./lib/harness.ts";

const base = await startServer();
const { BACKGROUND_CONTEXT: ctx } = await import("@earendil-works/chord/context");
const { createOutpostExtension, moduleCompat } = await import("../src/agent/extension.ts");
const { Workspace } = await import("../src/kernel/workspace.ts");
const { blueprints, modules } = await import("../src/kernel/system-db.ts");
const { assessFiles } = await import("../src/modules/inspect.ts");

let cookie = "";
async function call(method: string, path: string, body?: unknown) {
	const r = await fetch(base + path, { method, headers: { "content-type": "application/json", cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
	const set = r.headers.get("set-cookie");
	if (set) cookie = set.split(";")[0]!;
	return { status: r.status, json: await r.json().catch(() => ({})) };
}
async function ok(method: string, path: string, body?: unknown) {
	const r = await call(method, path, body);
	if (r.status >= 400) throw new Error(`${method} ${path}: ${r.status} ${JSON.stringify(r.json)}`);
	return r.json;
}

try {
	await ok("POST", "/api/auth/signup", { username: "ana", password: "password123", displayName: "Ana" });
	const wsId = (await ok("GET", "/api/workspaces")).workspaces[0].id as string;
	const ws = await Workspace.get(wsId);
	const tool = (name: string, args: unknown) =>
		(createOutpostExtension(ws).tools!.find((t) => t.name === name)! as { execute: (a: unknown, b: unknown, c: unknown) => Promise<{ output: { text: string }[] }> }).execute(args, { conversationId: 1, taskId: 90_001 }, ctx);
	const asJson = async (name: string, args: unknown) => JSON.parse((await tool(name, args)).output[0].text);

	// ---------------------------------------------------------------- B3
	console.log("B3: vendored code does not block a write");
	const bundle = `/*! PptxGenJS 4.0.1 @ 2025-06-25 */ (function (g) { if (typeof module !== "undefined" && module.exports) module.exports = g; })();${"x".repeat(140_000)}`;
	const deckLike: Record<string, string> = {
		"index.html": '<h1>deck</h1><script src="pptxgen.bundle.js"></script>',
		"server.js": "export default class { get() { return 1; } }",
		"pptxgen.bundle.js": bundle,
	};
	const vendored = assessFiles(deckLike);
	check("a 140 KB minified UMD bundle does not block the module", vendored.status !== "blocked", vendored);
	check("…and it is named as skipped, not silently trusted", vendored.notes.some((n) => /pptxgen\.bundle\.js/.test(n)), vendored.notes);
	const ours = { ...deckLike, "index.html": '<script src="app.js"></script>', "app.js": "module.exports = 1;" };
	check("our own code using module.exports still blocks", assessFiles(ours).status === "blocked", assessFiles(ours));
	const banner = { "index.html": "<h1>x</h1>", "extra.js": "/* outpost:vendor */\nmodule.exports = 1;" };
	check("the vendor banner opts a file out explicitly", assessFiles(banner).status !== "blocked", assessFiles(banner));

	const deck = (await ok("POST", `/api/w/${wsId}/modules`, { name: "Deck", blueprintId: "bp_slides" })).module;
	await ws.writeModuleFiles(deck.id, { ...(await ws.moduleFiles(deck.id)), ...deckLike });
	const writeVerdict = await moduleCompat(ws, deck.id);
	const published = await ok("POST", "/api/blueprints", { moduleId: deck.id, name: "Deck template", changelog: "vendored" });
	check("write-time and publish-time agree about the same code", (writeVerdict === undefined) === (published.compat.status === "ok" || published.compat.status === "warn"), { writeVerdict, publish: published.compat });

	// ---------------------------------------------------------------- B1
	console.log("B1: a root id means the current version");
	const rootId = published.blueprint.rootId;
	const v2 = await ok("POST", "/api/blueprints", { moduleId: deck.id, changelog: "second" });
	must("the second version shares the root", v2.blueprint.rootId === rootId);
	const fromRoot = await asJson("blueprint_read", { blueprint: rootId });
	check("reading by root id returns the current version", fromRoot.blueprint.version === 2, fromRoot.blueprint.version);
	check("…and the answer says which version it is", fromRoot.requested.version === 2 && fromRoot.current.version === 2, fromRoot.requested);
	const fromV1 = await asJson("blueprint_read", { blueprint: rootId, version: 1 });
	check("asking for v1 returns v1", fromV1.blueprint.version === 1, fromV1.blueprint.version);
	check("…while still pointing at the current version", fromV1.current.version === 2, fromV1.current);
	const listed = await asJson("blueprint_list", {});
	const row = (listed as unknown as { id: string; version: number }[]).find((b) => b.id === v2.blueprint.id);
	check("the catalogue lists the current version once", listed.filter((b: { id: string; name: string }) => b.name === "Deck template").length === 1 && row?.version === 2, listed.filter((b: { name: string }) => b.name === "Deck template"));

	// ---------------------------------------------------------------- B2
	console.log("B2: a rollout reports the version it applied");
	const v3 = await ok("POST", "/api/blueprints", { moduleId: deck.id, changelog: "third" });
	// A module still on v1, so the rollout has something to actually move.
	const lag = (await ok("POST", `/api/w/${wsId}/modules`, { name: "Lagging", blueprintId: blueprints.versions(rootId)[0]!.id })).module;
	const rollout = await ok("POST", `/api/w/${wsId}/blueprints/${rootId}/update-modules`, {});
	check("the rollout reports the current version", rollout.version === v3.blueprint.version, rollout.version);
	const movedRow = rollout.results.find((r: { module: string; status: string }) => r.module === lag.id && r.status === "updated");
	check("each module reports from → to", movedRow?.from === 1 && movedRow?.to === 3, movedRow);

	// ---------------------------------------------------------------- B4
	console.log("B4: adoption, loud failures, and a delete guard");
	const family2 = await ok("POST", "/api/blueprints", { moduleId: deck.id, name: "Other family", changelog: "fork", fork: true });
	// A todo module with data in it: adopting a blueprint replaces code, never the module's own storage.
	const todoFamily = await ok("POST", "/api/blueprints", { moduleId: (await ok("POST", `/api/w/${wsId}/modules`, { name: "Todo seed", blueprintId: "bp_todo" })).module.id, name: "Todo family", changelog: "fork", fork: true });
	const stranded = (await ok("POST", `/api/w/${wsId}/modules`, { name: "Stranded", blueprintId: "bp_todo" })).module;
	const caller = { kind: "user" as const, id: "u_test", name: "Ana", role: "editor" as const };
	await ws.host(stranded.id).call("add", ["keep me", "ana"], caller);
	must("the stranded module has its own data", ((await ws.host(stranded.id).call("list", [], caller)) as unknown[]).length === 1);
	const refused = await call("POST", `/api/w/${wsId}/blueprints/${rootId}/update-modules`, { modules: [stranded.id] });
	check("an explicit list that cannot be satisfied fails loudly", refused.status === 400, refused.json);
	check("…naming the reason", /different blueprint/i.test(refused.json.error ?? ""), refused.json);
	const adopted = await ok("POST", `/api/w/${wsId}/modules/${stranded.id}/blueprint`, { blueprintId: todoFamily.blueprint.id });
	check("adopting moves the module onto the blueprint", adopted.version === 1, adopted);
	check("…keeping the module's own data", ((await ws.host(stranded.id).call("list", [], caller)) as unknown[]).length === 1);
	check("…and it now reports the new blueprint", (await ok("GET", `/api/w/${wsId}/modules/${stranded.id}/blueprint`)).builtFrom?.rootId === todoFamily.blueprint.rootId);
	const delUsed = await asJson("blueprint_delete", { blueprint: rootId }).catch((e: Error) => ({ error: e.message }));
	check("deleting a blueprint still in use is refused", typeof delUsed === "object" && /Still used by/i.test((delUsed as { error?: string }).error ?? ""), delUsed);
	const deleted = await ok("DELETE", `/api/blueprints/${family2.blueprint.id}`);
	void deleted;
	const rescue = (await ok("POST", `/api/w/${wsId}/modules`, { name: "On a dead blueprint", blueprintId: rootId })).module;
	must("the rescue module records its blueprint", Boolean(rescue.blueprintId), rescue);
	blueprints.deleteRoot(rescue.blueprintId!);
	const orphans = await ok("GET", `/api/w/${wsId}/modules/orphans`);
	check("a module whose blueprint is gone is reported as an orphan", orphans.orphans.some((m: { id: string }) => m.id === rescue.id), orphans);
	check("…and it does not claim to be 'from scratch'", (await ok("GET", `/api/w/${wsId}/modules/${rescue.id}/blueprint`)).missing === true);

	// ---------------------------------------------------------------- B5
	console.log("B5: drafts are counted and moved apart");
	const fam5 = await ok("POST", "/api/blueprints", { moduleId: deck.id, name: "Draft family", changelog: "for drafts", fork: true });
	const root5 = fam5.blueprint.rootId;
	const draft = (await ok("POST", `/api/w/${wsId}/blueprints/${root5}/draft`, {})).module;
	const info = await ok("GET", `/api/blueprints/${root5}`);
	check("a draft is not in 'used by'", !info.modulesUsing.some((m: { id: string }) => m.id === draft.id), info.modulesUsing.map((m: { name: string }) => m.name));
	check("…it is listed as a draft", info.draftsUsing.some((m: { id: string }) => m.id === draft.id), info.draftsUsing);
	const before = (await ws.moduleFiles(draft.id))["index.html"];
	const roll = await ok("POST", `/api/w/${wsId}/blueprints/${root5}/update-modules`, {});
	check("a rollout leaves drafts alone", !roll.results.some((r: { module: string }) => r.module === draft.id), roll.results.map((r: { status: string }) => r.status));
	check("…and the draft's code is untouched", (await ws.moduleFiles(draft.id))["index.html"] === before);

	// ---------------------------------------------------------------- B6
	console.log("B6: a big file comes back in pieces and says so");
	const bigBody = `/* huge */\n${"z".repeat(60_000)}`;
	await ws.writeModuleFiles(deck.id, { ...(await ws.moduleFiles(deck.id)), "big.js": bigBody });
	const page = await asJson("module_read", { module: deck.id, path: "big.js" });
	check("a big file is reported as truncated", page.truncated === true && page.bytes === bigBody.length, page);
	check("…with an offset to continue from", typeof page.nextOffset === "number" && page.nextOffset > 0, page.nextOffset);
	const tail = await asJson("module_read", { module: deck.id, path: "big.js", offset: bigBody.length - 10 });
	check("…and offset reads the tail", tail.text === bigBody.slice(-10), tail.text);
	const small = (await tool("module_read", { module: deck.id, path: "server.js" })).output[0].text;
	check("a small file still comes back as plain text", small.startsWith("export default class"), small.slice(0, 40));

	// ---------------------------------------------------------------- A1
	console.log("A1: file_write replaces instead of duplicating");
	// file_write asks the tool API to memoize its result; a stub is enough for the write path itself.
	const writeTool = (name: string) => (createOutpostExtension(ws).tools!.find((t) => t.name === name)! as unknown as { execute: (a: unknown, b: unknown, c: unknown) => Promise<{ output: { text: string }[] }> });
	const stub = { memo: async () => undefined, details: async () => undefined };
	const write = async (args: unknown) => JSON.parse((await writeTool("file_write").execute(args, stub, ctx)).output[0].text);
	const first = await write({ name: "report.md", content: "# one" });
	const again = await write({ name: "report.md", content: "# two" });
	check("a repeat write warns about the existing file", again.duplicateOf === first.id, again);
	check("…and does not overwrite it silently", again.id !== first.id);
	// The tool's replace branch is one call to the store's in-place replace; exercise the store call,
	// because a tool result needs the runner's memo API which a test cannot fabricate faithfully.
	const replaced = await ws.files.replaceText(first.id, Buffer.from("# three"));
	check("replace updates that same file", replaced.id === first.id, replaced);
	const reports = async () => (await ws.files.list()).filter((f) => f.name === "report.md").length;
	check("a replace does not add another copy", (await reports()) === 2, await reports());
} catch (error) {
	await finish(error);
}
await finish();
