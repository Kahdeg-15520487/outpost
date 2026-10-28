/**
 * Improving a blueprint, and moving modules onto it.
 *
 * The old loop had no "open → edit → save": you cloned a blueprint into a permanent module to read
 * it, published to fork a new near-identically named blueprint, and no module ever got the change.
 * These checks pin the replacement: read without cloning, versions instead of forks, drafts that
 * stay out of the module list, drift, rollout, and a changelog that is a field rather than prose.
 *
 * Run: pnpm --filter @outpost/server test -- blueprints
 */

import { check, finish, must, startServer, until } from "./lib/harness.ts";

const base = await startServer();
const { Workspace } = await import("../src/kernel/workspace.ts");
const { modules } = await import("../src/kernel/system-db.ts");

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
	const ws = (await ok("GET", "/api/workspaces")).workspaces[0].id as string;
	const wsObj = await Workspace.get(ws);

	console.log("reading a blueprint does not create anything");
	const before = modules.all().length;
	const list = await ok("GET", "/api/blueprints");
	const notes = list.blueprints.find((b: any) => b.name === "Notes")!;
	must("the catalogue has the built-in notes blueprint", notes);
	const info = await ok("GET", `/api/blueprints/${notes.id}`);
	check("reading lists the files with sizes", Object.keys(info.files).includes("index.html") && info.files["index.html"].lines > 10, Object.keys(info.files));
	check("reading returns the source", String(info.source["server.js"] ?? "").includes("class"), Object.keys(info.source));
	check("reading names the declared API", info.api.methods.includes("page") || info.api.methods.length > 0, info.api);
	check("reading lists versions", info.versions.length >= 1 && info.versions[0].version === 1, info.versions.map((v: any) => v.version));
	check("reading reports compatibility", ["ok", "warn", "blocked"].includes(info.compat.status), info.compat);
	check("no module was created to answer that", modules.all().length === before, `${before} → ${modules.all().length}`);

	console.log("a draft is not one of the user's modules");
	const { module: draft } = await ok("POST", `/api/w/${ws}/blueprints/${notes.id}/draft`, {});
	const listed = await ok("GET", `/api/w/${ws}/modules`);
	check("the draft exists", Boolean(modules.get(draft.id)));
	check("…and is absent from the module list", !listed.modules.some((m: any) => m.id === draft.id), listed.modules.map((m: any) => m.name));
	check("…while still readable by id", (await call("GET", `/api/modules/${draft.id}`)).status === 200);
	check("the draft knows where it came from", draft.blueprint?.name === "Notes" || modules.get(draft.id)?.blueprintId === notes.id);
	const draftInfo = (await ok("GET", `/api/modules/${draft.id}`)).module;
	check("the api marks it as a draft", draftInfo.draft === true, draftInfo);

	console.log("publishing from a built-in forks (it would be overwritten on boot)");
	const forked = await ok("POST", "/api/blueprints", { moduleId: draft.id, name: "Notes but mine", changelog: "first", description: "my notes" });
	check("a fork gets its own root", forked.blueprint.rootId === forked.blueprint.id, forked.blueprint);
	check("…at version 1", forked.blueprint.version === 1);
	check("…and records the version it came from", (await ok("GET", `/api/blueprints/${forked.blueprint.id}`)).blueprint.parentId === notes.id);
	check("publish reports whether the code runs here", ["ok", "warn", "blocked"].includes(forked.compat.status), forked.compat);

	console.log("publishing from a module built on it appends a version");
	const { module: deck } = await ok("POST", `/api/w/${ws}/modules`, { name: "My notes", blueprintId: forked.blueprint.id });
	const files = { ...(await wsObj.moduleFiles(deck.id)), "app.js": "// cover image support\n" };
	await wsObj.writeModuleFiles(deck.id, files);
	const v2 = await ok("POST", "/api/blueprints", { moduleId: deck.id, changelog: "added a cover image field" });
	check("the blueprint keeps its identity", v2.blueprint.rootId === forked.blueprint.rootId, v2.blueprint);
	check("…and its name", v2.blueprint.name === "Notes but mine", v2.blueprint.name);
	check("…and moves to v2", v2.blueprint.version === 2, v2.blueprint.version);
	check("the changelog is stored as a field", v2.blueprint.changelog === "added a cover image field", v2.blueprint.changelog);
	const afterInfo = await ok("GET", `/api/blueprints/${forked.blueprint.id}`);
	check("the blueprint now has two versions", afterInfo.versions.length === 2, afterInfo.versions.map((v: any) => v.version));
	check("the catalogue shows one row, at the newest version", (await ok("GET", "/api/blueprints")).blueprints.filter((b: any) => b.rootId === forked.blueprint.rootId).length === 1);
	const catalogue = (await ok("GET", "/api/blueprints")).blueprints.find((b: any) => b.rootId === forked.blueprint.rootId)!;
	check("…with a version count and who uses it", catalogue.versionCount === 2 && catalogue.modulesUsing >= 1, catalogue);

	console.log("modules know how far they have drifted");
	const { module: second } = await ok("POST", `/api/w/${ws}/modules`, { name: "Second notes", blueprintId: forked.blueprint.id });
	const drift = await ok("GET", `/api/w/${ws}/modules/${deck.id}/blueprint`);
	check("a module on the newest version is up to date", drift.behind === 0, drift);
	const old = await ok("GET", `/api/w/${ws}/modules/${second.id}/blueprint`);
	check("a module on v1 is one behind", old.behind === 1, old.behind);
	check("…and shows which files the blueprint changed", old.changed.some((c: any) => c.path === "app.js" && c.status === "added"), old.changed);

	console.log("moving modules onto the new version");
	const moved = await ok("POST", `/api/w/${ws}/modules/${second.id}/blueprint`, {});
	check("the update reports what it replaced", moved.version === 2, moved);
	check("…and the module now has the new file", Object.keys(await wsObj.moduleFiles(second.id)).includes("app.js"));
	check("…and is up to date afterwards", (await ok("GET", `/api/w/${ws}/modules/${second.id}/blueprint`)).behind === 0);

	console.log("diffing two versions");
	const latest = afterInfo.versions.at(-1).id;
	const diff = await ok("GET", `/api/blueprints/${afterInfo.versions[0].id}/diff?with=${latest}`);
	check("the diff names the added file", diff.changed.some((c: any) => c.path === "app.js" && c.status === "added"), diff.changed);
	check("the diff says which way round it is", diff.from.version === 1 && diff.to.version === 2, { from: diff.from, to: diff.to });

	console.log("rolling out to every module on the blueprint");
	const v3 = await ok("POST", "/api/blueprints", { moduleId: deck.id, changelog: "third" });
	check("publishing again makes v3", v3.blueprint.version === 3);
	const rollout = await ok("POST", `/api/w/${ws}/blueprints/${v3.blueprint.id}/update-modules`, {});
	const movedNow = rollout.results.filter((r: any) => r.status === "updated");
	check("every module on the blueprint is moved", movedNow.length >= 2, rollout.results.map((r: any) => r.status));
	check("…to the version just published", rollout.version === 3);
	check("…and none is left behind", (await ok("GET", `/api/w/${ws}/modules/${second.id}/blueprint`)).behind === 0);

	console.log("deleting");
	await ok("DELETE", `/api/modules/${draft.id}`);
	check("a draft can be deleted", !modules.get(draft.id));
	const gone = await ok("DELETE", `/api/blueprints/${v3.blueprint.id}`);
	check("a blueprint with versions can be deleted whole", gone.ok === true && (await call("GET", `/api/blueprints/${v3.blueprint.id}`)).status === 404);
	const builtinDelete = await call("DELETE", `/api/blueprints/${notes.id}`);
	check("a built-in blueprint refuses deletion", builtinDelete.status === 403, builtinDelete.json);

	console.log("the agent is taught the same loop");
	const { OUTPOST_GUIDE } = await import("../src/agent/extension.ts");
	const taught = ["blueprint_read", "module_draft", "blueprint_update_modules", "module_delete"].filter((tool) => OUTPOST_GUIDE.includes(tool));
	check("the guide names the new blueprint tools", taught.length === 4, taught);
	check("…and says where the changelog goes", /changelog/.test(OUTPOST_GUIDE));

} catch (error) {
	await finish(error);
}
await finish();
