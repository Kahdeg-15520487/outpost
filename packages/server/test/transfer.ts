/**
 * Moving blueprints and gadgets between two pi-os instances: this process runs instance A, and a
 * child process runs instance B with its own data. Exports from A are imported into B over HTTP.
 * Run: pnpm --filter @pi-os/server test -- transfer
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
	env: { ...process.env, PORT: String(portB), PI_OS_DATA: join(dirB, "data"), INIT_CWD: dirB, PI_OS_CONFIG: "" },
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
	const { gadget } = await a.ok("POST", `/api/w/${wsA}/gadgets`, { name: "Team todo", blueprintId: "bp_todo" });
	const ws = await Workspace.get(wsA);
	const caller = { kind: "agent" as const, id: "t", name: "Test", role: "editor" as const };
	await ws.host(gadget.id).call("add", ["Book the venue", "ana"], caller);
	await ws.host(gadget.id).call("add", ["Order snacks", "ana"], caller);
	await ws.writeGadgetFiles(gadget.id, { "notes.md": "custom file that must travel" });
	const stateA = (await a.ok("GET", `/api/gadgets/${gadget.id}/state`)).kv;
	const filesA = (await a.ok("GET", `/api/gadgets/${gadget.id}`)).files;
	const { blueprint } = await a.ok("POST", "/api/blueprints", { gadgetId: gadget.id, name: "Ana's todo", description: "todo with notes", visibility: "private" });

	const code = await a.ok("GET", `/api/gadgets/${gadget.id}/export`);
	check("gadget export: code, no data", code.bundle.format === "pi-os/bundle" && code.bundle.gadgets.length === 1 && code.bundle.gadgets[0].files["notes.md"] && code.bundle.gadgets[0].data === undefined && code.fileName === "team-todo.pios.json", code.fileName);
	const withData = await a.ok("GET", `/api/gadgets/${gadget.id}/export?data=1`);
	check("gadget export with data", JSON.stringify(withData.bundle.gadgets[0].data) === JSON.stringify(stateA), withData.bundle.gadgets[0].data);
	const bp = await a.ok("GET", `/api/blueprints/${blueprint.id}/export`);
	check("blueprint export keeps files and intro", bp.bundle.blueprints[0].name === "Ana's todo" && bp.bundle.blueprints[0].files["notes.md"] && !!bp.bundle.blueprints[0].intro, bp.bundle.blueprints[0].intro);
	const builtin = await a.ok("GET", "/api/blueprints/bp_slides/export");
	check("built-in blueprints export too", builtin.bundle.blueprints[0].name.length > 0);
	const all = await a.ok("GET", `/api/w/${wsA}/export?blueprints=mine&gadgets=all&data=1`);
	check("bulk export: my blueprints + the workspace's gadgets", all.bundle.blueprints.length === 1 && all.bundle.gadgets.length === 1 && /^pi-os-export-/.test(all.fileName), all.fileName);
	const other = client(baseA);
	await other.ok("POST", "/api/auth/signup", { username: "eve", password: "password123", displayName: "Eve" });
	check("a private blueprint can't be exported by others", (await other.call("GET", `/api/blueprints/${blueprint.id}/export`)).status === 404);
	check("a gadget can't be exported without editor access", (await other.call("GET", `/api/gadgets/${gadget.id}/export`)).status >= 403);

	console.log("import into B");
	const bb = client(baseB);
	await bb.ok("POST", "/api/auth/signup", { username: "bo", password: "password123", displayName: "Bo" });
	const wsB = (await bb.ok("GET", "/api/workspaces")).workspaces[0].id as string;
	const result = await bb.ok("POST", `/api/w/${wsB}/import`, undefined, JSON.stringify(all.bundle));
	check("import reports what arrived", result.blueprints.length === 1 && result.gadgets.length === 1 && result.gadgets[0].data === true && result.notes.length > 0, result);
	const gB = result.gadgets[0].id as string;
	const viewB = await bb.ok("GET", `/api/gadgets/${gB}`);
	check("gadget code arrives intact", JSON.stringify(viewB.files) === JSON.stringify(filesA) && viewB.gadget.name === "Team todo", Object.keys(viewB.files));
	const stateB = (await bb.ok("GET", `/api/gadgets/${gB}/state`)).kv;
	check("gadget data arrives intact", JSON.stringify(stateB) === JSON.stringify(stateA), { stateA, stateB });
	check("the imported gadget's server loads on B", !viewB.server?.error && ["list", "add"].every((m) => viewB.server?.methods?.includes(m)), viewB.server);
	const bpsB = (await bb.ok("GET", "/api/blueprints")).blueprints as any[];
	const mineB = bpsB.find((x) => x.name === "Ana's todo");
	check("blueprint arrives private and owned by the importer", mineB?.mine === true && mineB.visibility === "private", mineB);
	const viewer = client(baseB);
	await viewer.ok("POST", "/api/auth/signup", { username: "cy", password: "password123", displayName: "Cy" });
	check("others on B don't see a private import", !((await viewer.ok("GET", "/api/blueprints")).blueprints as any[]).some((x) => x.name === "Ana's todo"));
	await bb.ok("POST", `/api/w/${wsB}/import?visibility=public`, undefined, JSON.stringify(bp.bundle));
	check("shared import is visible to everyone on B", ((await viewer.ok("GET", "/api/blueprints")).blueprints as any[]).some((x) => x.name === "Ana's todo" && x.visibility === "public"));
	const fromBp = await bb.ok("POST", `/api/w/${wsB}/gadgets`, { name: "From imported", blueprintId: mineB.id });
	check("an imported blueprint can be used", (await bb.ok("GET", `/api/gadgets/${fromBp.gadget.id}`)).files["notes.md"] === "custom file that must travel");

	console.log("validation");
	const bad = async (body: string) => (await bb.call("POST", `/api/w/${wsB}/import`, undefined, body)).json.error as string;
	check("not JSON is refused", /isn't JSON/.test(await bad("hello")));
	check("other JSON is refused", /Not a pi-os export/.test(await bad(JSON.stringify({ foo: 1 }))));
	check("a newer bundle version is refused", /newer pi-os/.test(await bad(JSON.stringify({ ...all.bundle, version: 99 }))));
	check("path traversal in files is refused", /invalid file path/.test(await bad(JSON.stringify({ format: "pi-os/bundle", version: 1, gadgets: [{ name: "x", files: { "../evil.js": "1" } }] }))));
	check("non-text files are refused", /must be text/.test(await bad(JSON.stringify({ format: "pi-os/bundle", version: 1, blueprints: [{ name: "x", files: { "a.js": 5 } }] }))));
	check("an empty bundle is refused", /no blueprints or gadgets/.test(await bad(JSON.stringify({ format: "pi-os/bundle", version: 1 }))));
	await viewer.ok("GET", "/api/workspaces");
	check("importing into someone else's workspace is refused", (await viewer.call("POST", `/api/w/${wsB}/import`, undefined, JSON.stringify(code.bundle))).status >= 403);
}
