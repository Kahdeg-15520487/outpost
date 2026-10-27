/**
 * Moving blueprints and modules between two outpost instances: this process runs instance A, and a
 * child process runs instance B with its own data. Exports from A are imported into B over HTTP.
 * Run: pnpm --filter @outpost/server test -- transfer
 */
import { check, finish, freePort, must, startServer, testDir, until } from "./lib/harness.ts";
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const baseA = await startServer();
const { Workspace } = await import("../src/kernel/workspace.ts");

// ------------------------------------------------------------------ instance B (separate process, separate data)
const portB = await freePort();
const dirB = join(testDir, "instance-b");
mkdirSync(dirB, { recursive: true });
const b = spawn(process.execPath, [join(import.meta.dirname, "..", "node_modules", "tsx", "dist", "cli.mjs"), join(import.meta.dirname, "..", "src", "main.ts")], {
	env: { ...process.env, PORT: String(portB), OUTPOST_DATA: join(dirB, "data"), INIT_CWD: dirB, OUTPOST_CONFIG: "" },
	stdio: ["ignore", "pipe", "pipe"],
});
let bLog = "";
b.stdout.on("data", (d) => (bLog += d));
b.stderr.on("data", (d) => (bLog += d));
const baseB = `http://127.0.0.1:${portB}`;
process.on("exit", () => b.kill());
try {
	must("instance B starts", await until("instance B", () => fetch(`${baseB}/api/me`).then(() => true), 40000), bLog.slice(-500));
	await run();
} catch (e) {
	b.kill();
	await finish(e);
}
b.kill();
await finish();

function client(base: string) {
	let cookie = "";
	const call = async (method: string, path: string, body?: unknown, raw?: string) => {
		const r = await fetch(base + path, { method, headers: { "content-type": "application/json", cookie }, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
		const set = r.headers.get("set-cookie");
		if (set) cookie = set.split(";")[0]!;
		const json = await r.json().catch(() => ({}));
		return { status: r.status, json };
	};
	return { call, ok: async (method: string, path: string, body?: unknown, raw?: string) => {
		const r = await call(method, path, body, raw);
		if (r.status >= 400) throw new Error(`${method} ${path}: ${r.status} ${JSON.stringify(r.json)}`);
		return r.json;
	} };
}

async function run() {
	console.log("export from A");
	const a = client(baseA);
	await a.ok("POST", "/api/auth/signup", { username: "ana", password: "password123", displayName: "Ana" });
	const wsA = (await a.ok("GET", "/api/workspaces")).workspaces[0].id as string;
	const { module } = await a.ok("POST", `/api/w/${wsA}/modules`, { name: "Team todo", blueprintId: "bp_todo" });
	check("legacy module and team routes are gone", (await a.call("GET", `/api/w/${wsA}/gadgets`)).status === 404 && (await a.call("GET", `/api/w/${wsA}/projects`)).status === 404 && (await a.call("GET", "/api/gatekeepers")).status === 404);
	const ws = await Workspace.get(wsA);
	const caller = { kind: "agent" as const, id: "t", name: "Test", role: "editor" as const };
	await ws.host(module.id).call("add", ["Book the venue", "ana"], caller);
	await ws.host(module.id).call("add", ["Order snacks", "ana"], caller);
	await ws.writeModuleFiles(module.id, { "notes.md": "custom file that must travel" });
	const stateA = (await a.ok("GET", `/api/modules/${module.id}/state`)).kv;
	const filesA = (await a.ok("GET", `/api/modules/${module.id}`)).files;
	const { blueprint } = await a.ok("POST", "/api/blueprints", { moduleId: module.id, name: "Ana's todo", description: "todo with notes", visibility: "private" });

	const code = await a.ok("GET", `/api/modules/${module.id}/export`);
	check("module export: code, no data", code.bundle.format === "outpost/bundle" && code.bundle.modules.length === 1 && code.bundle.modules[0].files["notes.md"] && code.bundle.modules[0].data === undefined && code.fileName === "team-todo.outpost.json", code.fileName);
	const withData = await a.ok("GET", `/api/modules/${module.id}/export?data=1`);
	check("module export with data", JSON.stringify(withData.bundle.modules[0].data) === JSON.stringify(stateA), withData.bundle.modules[0].data);
	const bp = await a.ok("GET", `/api/blueprints/${blueprint.id}/export`);
	check("blueprint export keeps files and intro", bp.bundle.blueprints[0].name === "Ana's todo" && bp.bundle.blueprints[0].files["notes.md"] && !!bp.bundle.blueprints[0].intro, bp.bundle.blueprints[0].intro);
	const builtin = await a.ok("GET", "/api/blueprints/bp_slides/export");
	check("built-in blueprints export too", builtin.bundle.blueprints[0].name.length > 0);
	const all = await a.ok("GET", `/api/w/${wsA}/export?blueprints=mine&modules=all&data=1`);
	check("bulk export: my blueprints + the workspace's modules", all.bundle.blueprints.length === 1 && all.bundle.modules.length === 1 && /^outpost-export-/.test(all.fileName), all.fileName);
	const other = client(baseA);
	await other.ok("POST", "/api/auth/signup", { username: "eve", password: "password123", displayName: "Eve" });
	check("a private blueprint can't be exported by others", (await other.call("GET", `/api/blueprints/${blueprint.id}/export`)).status === 404);
	check("a module can't be exported without editor access", (await other.call("GET", `/api/modules/${module.id}/export`)).status >= 403);

	console.log("import into B");
	const bb = client(baseB);
	await bb.ok("POST", "/api/auth/signup", { username: "bo", password: "password123", displayName: "Bo" });
	const wsB = (await bb.ok("GET", "/api/workspaces")).workspaces[0].id as string;
	const result = await bb.ok("POST", `/api/w/${wsB}/import`, undefined, JSON.stringify(all.bundle));
	check("import reports what arrived", result.blueprints.length === 1 && result.modules.length === 1 && result.modules[0].data === true && result.notes.length > 0, result);
	const gB = result.modules[0].id as string;
	const viewB = await bb.ok("GET", `/api/modules/${gB}`);
	check("module code arrives intact", JSON.stringify(viewB.files) === JSON.stringify(filesA) && viewB.module.name === "Team todo", Object.keys(viewB.files));
	const stateB = (await bb.ok("GET", `/api/modules/${gB}/state`)).kv;
	check("module data arrives intact", JSON.stringify(stateB) === JSON.stringify(stateA), { stateA, stateB });
	check("the imported module's server loads on B", !viewB.server?.error && ["list", "add"].every((m) => viewB.server?.methods?.includes(m)), viewB.server);
	const bpsB = (await bb.ok("GET", "/api/blueprints")).blueprints as any[];
	const mineB = bpsB.find((x) => x.name === "Ana's todo");
	check("blueprint arrives private and owned by the importer", mineB?.mine === true && mineB.visibility === "private", mineB);
	const viewer = client(baseB);
	await viewer.ok("POST", "/api/auth/signup", { username: "cy", password: "password123", displayName: "Cy" });
	check("others on B don't see a private import", !((await viewer.ok("GET", "/api/blueprints")).blueprints as any[]).some((x) => x.name === "Ana's todo"));
	await bb.ok("POST", `/api/w/${wsB}/import?visibility=public`, undefined, JSON.stringify(bp.bundle));
	check("shared import is visible to everyone on B", ((await viewer.ok("GET", "/api/blueprints")).blueprints as any[]).some((x) => x.name === "Ana's todo" && x.visibility === "public"));
	const fromBp = await bb.ok("POST", `/api/w/${wsB}/modules`, { name: "From imported", blueprintId: mineB.id });
	check("an imported blueprint can be used", (await bb.ok("GET", `/api/modules/${fromBp.module.id}`)).files["notes.md"] === "custom file that must travel");

	console.log("validation");
	const bad = async (body: string) => (await bb.call("POST", `/api/w/${wsB}/import`, undefined, body)).json.error as string;
	check("not JSON is refused", /isn't JSON/.test(await bad("hello")));
	check("other JSON is refused", /Not an Outpost export/.test(await bad(JSON.stringify({ foo: 1 }))));
	check("a newer bundle version is refused", /Unsupported Outpost bundle version/.test(await bad(JSON.stringify({ ...all.bundle, version: 99 }))));
	check("path traversal in files is refused", /invalid file path/.test(await bad(JSON.stringify({ format: "outpost/bundle", version: 2, modules: [{ name: "x", files: { "../evil.js": "1" } }] }))));
	check("non-text files are refused", /must be text/.test(await bad(JSON.stringify({ format: "outpost/bundle", version: 2, blueprints: [{ name: "x", files: { "a.js": 5 } }] }))));
	check("an empty bundle is refused", /no blueprints or modules/.test(await bad(JSON.stringify({ format: "outpost/bundle", version: 2 }))));
	await viewer.ok("GET", "/api/workspaces");
	check("importing into someone else's workspace is refused", (await viewer.call("POST", `/api/w/${wsB}/import`, undefined, JSON.stringify(code.bundle))).status >= 403);

	console.log("version + capabilities");
	check("exports record the producing outpost and module runtime", code.bundle.version === 2 && code.bundle.producer?.app === "outpost" && code.bundle.producer.version === "0.8.0" && code.bundle.producer.runtime === 2, code.bundle.producer);
	const req = code.bundle.modules[0].requires;
	check("exports record what each item needs (detected from its code)", req.runtime === 2 && req.server.includes("storage") && req.server.includes("broadcast") && req.client.includes("api"), req);
	const caps = await bb.ok("GET", "/api/capabilities");
	check("/api/capabilities describes this instance", caps.version === "0.8.0" && caps.runtime === 2 && caps.server.includes("storage") && caps.airlocks.some((g: any) => g.id === "github"), caps);

	// A module holding a GitHub grant: its export says it needs GitHub.
	await ws.grant({ airlock: "github", resource: "octo/repo", holder: { kind: "module", id: module.id }, by: "ana" });
	await ws.writeModuleFiles(module.id, { "server.js": `export default class S { constructor(ctx) { this.ctx = ctx; } async issues() { return this.ctx.airlocks.github.list_issues({}); } }` });
	const withGrant = await a.ok("GET", `/api/modules/${module.id}/export`);
	check("module export lists the Airlocks it needs", withGrant.bundle.modules[0].requires.airlocks.some((g: any) => g.id === "github" && g.methods.includes("list_issues")), withGrant.bundle.modules[0].requires);

	const moduleItem = (name: string, files: Record<string, string>, extra: object = {}) => ({ name, icon: "◆", files: { "index.html": "<h1>x</h1>", ...files }, ...extra });
	const mixed = {
		format: "outpost/bundle",
		version: 2,
		exportedAt: new Date().toISOString(),
		producer: { app: "outpost", version: "0.8.0", runtime: 2 },
		blueprints: [],
		modules: [
			moduleItem("Fine", { "server.js": "export default class S { constructor(ctx){this.ctx=ctx} n(){ return this.ctx.storage.get('n') } }" }),
			moduleItem("Future runtime", {}, { requires: { runtime: 3, server: [], client: [], airlocks: [] } }),
			moduleItem("Unknown feature", { "server.js": "export default class S { constructor(ctx){this.ctx=ctx} go(){ return this.ctx.teleport('mars') } }" }, { requires: { runtime: 2, server: [], client: [], airlocks: [] } }),
			moduleItem("Page feature", { "index.html": "<p>the module. Then text</p><script>module.vibrate(3)</script>" }),
			moduleItem("Slack poster", { "server.js": "export default class S { constructor(ctx){this.ctx=ctx} post(){ return this.ctx.airlocks.slack.post({}) } }" }),
			moduleItem("Odd GitHub method", { "server.js": "export default class S { constructor(ctx){this.ctx=ctx} x(){ return this.ctx.airlocks.github.deleteRepo({}) } }" }),
		],
	};
	const report = await bb.ok("POST", `/api/w/${wsB}/import/check`, undefined, JSON.stringify(mixed));
	const st = (name: string) => report.items.find((i: any) => i.name === name);
	check("check: a plain module is ok", st("Fine")?.status === "ok", st("Fine"));
	check("check: a newer module runtime is blocked", st("Future runtime")?.status === "blocked" && /runtime v3/.test(st("Future runtime").issues.join()), st("Future runtime"));
	check("check: an unknown server feature is blocked, even if the file declares less", st("Unknown feature")?.status === "blocked" && /ctx\.teleport/.test(st("Unknown feature").issues.join()), st("Unknown feature"));
	check("check: an unknown page feature is blocked (prose isn't code)", st("Page feature")?.status === "blocked" && /module\.vibrate/.test(st("Page feature").issues.join()) && !/module\.Then/.test(st("Page feature").issues.join()), st("Page feature"));
	check("check: a missing Airlock is a warning", st("Slack poster")?.status === "warn" && /slack/.test(st("Slack poster").issues.join()), st("Slack poster"));
	check("check: a missing Airlock method is a warning", st("Odd GitHub method")?.status === "warn" && /deleteRepo/.test(st("Odd GitHub method").issues.join()), st("Odd GitHub method"));
	check("check reports both versions", report.producer?.version === "0.8.0" && report.local?.version === "0.8.0");
	const newer = await bb.ok("POST", `/api/w/${wsB}/import/check`, undefined, JSON.stringify({ ...mixed, producer: { app: "outpost", version: "9.1.0", runtime: 2 }, modules: [mixed.modules[0]] }));
	check("check: a file from a newer outpost is a warning", newer.items[0].status === "warn" && /newer outpost \(9\.1\.0/.test(newer.items[0].issues.join()), newer.items[0]);
	const legacy = await bb.call("POST", `/api/w/${wsB}/import/check`, { format: "pi-os/bundle", version: 2, gadgets: [{ name: "Old", files: {} }] });
	check("legacy format is refused, not silently aliased", legacy.status === 400);
	const v1 = await bb.call("POST", `/api/w/${wsB}/import/check`, { ...mixed, version: 1 });
	check("obsolete bundle versions are refused", v1.status === 400);
	const oldRuntime = await bb.ok("POST", `/api/w/${wsB}/import/check`, { ...mixed, modules: [moduleItem("Legacy runtime", {}, { requires: { runtime: 1 } })] });
	check("obsolete runtime is blocked", oldRuntime.items[0].status === "blocked");
	const imported = await bb.ok("POST", `/api/w/${wsB}/import`, undefined, JSON.stringify(mixed));
	check("import skips what can't run and says why", imported.skipped.map((x: any) => x.name).sort().join() === "Future runtime,Page feature,Unknown feature" && imported.skipped.every((x: any) => x.issues.length), imported.skipped);
	check("import keeps what partly works, with warnings", imported.modules.map((x: any) => x.name).sort().join() === "Fine,Odd GitHub method,Slack poster" && imported.warnings.length === 2, imported);
	const ghImport = await bb.ok("POST", `/api/w/${wsB}/import`, undefined, JSON.stringify(withGrant.bundle));
	check("import notes which access to grant again", ghImport.notes.some((n: string) => /needs GitHub.* access: grant it/.test(n)), ghImport.notes);

	console.log("the builder's guide + feedback");
	const { OUTPOST_GUIDE, moduleCompat } = await import("../src/agent/extension.ts");
	const { SERVER_FEATURES, CLIENT_FEATURES, MODULE_RUNTIME } = await import("../src/modules/compat.ts");
	const undocumented = [...SERVER_FEATURES.map((f) => `ctx.${f}`), ...CLIENT_FEATURES.map((f) => `module.${f}`)].filter((m) => !new RegExp(`${m.replace(".", "\\.")}\\b`).test(OUTPOST_GUIDE));
	check("the agent's module guide documents every runtime feature", undocumented.length === 0, undocumented);
	check("the guide states the compatibility rules (runtime version, only these members)", OUTPOST_GUIDE.includes(`module runtime v${MODULE_RUNTIME}`) && /Use only these members/.test(OUTPOST_GUIDE) && /github` \(repo_info/.test(OUTPOST_GUIDE));
	const { module: probe } = await a.ok("POST", `/api/w/${wsA}/modules`, { name: "Probe" });
	await ws.writeModuleFiles(probe.id, { "server.js": "export default class S { constructor(ctx){this.ctx=ctx} n(){ return this.ctx.storage.get('n') } }" });
	check("module_write feedback: fine code reports nothing", (await moduleCompat(ws, probe.id)) === undefined);
	await ws.writeModuleFiles(probe.id, { "server.js": "export default class S { constructor(ctx){this.ctx=ctx} n(){ return this.ctx.fetch('x') } }" });
	const report2 = await moduleCompat(ws, probe.id);
	check("module_write feedback: code outside the runtime is reported with a fix", report2?.status === "blocked" && /ctx\.fetch/.test(report2.issues.join()) && /documented ctx\/module API/.test(report2.fix), report2);
	await ws.writeModuleFiles(probe.id, { "server.js": "export default class S { constructor(ctx){this.ctx=ctx} n(){ return this.ctx.airlocks.github.delete_repo({}) } }" });
	check("module_write feedback: an unknown Airlock method is a warning", (await moduleCompat(ws, probe.id))?.status === "warn");
}
