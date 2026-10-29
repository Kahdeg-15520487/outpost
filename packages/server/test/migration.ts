/** Outpost clean-break migration: real SQLite journals and git worktrees, all under the test temp dir. */
import { check, finish, testDir } from "./lib/harness.ts";
import { DatabaseSync } from "node:sqlite";
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { Harness, createRegistry, defineDoc, defineDocFamily } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createModels } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { migrateCode, migrateConfig, migrateData, migrateDocument, migrateEnvelope } from "../scripts/migrate-outpost.ts";

const source = join(testDir, "legacy");
const dest = join(testDir, "migrated");
const final = join(testDir, "final");
mkdirSync(join(source, "workspaces"), { recursive: true });
const db = new DatabaseSync(join(source, "system.sqlite"));
db.exec(`CREATE TABLE users(id TEXT, pw_hash TEXT, prefs TEXT);
CREATE TABLE workspaces(id TEXT, settings TEXT);
CREATE TABLE gadgets(id TEXT, name TEXT);
CREATE TABLE gadget_shares(gadget_id TEXT, user_id TEXT, role TEXT);
CREATE TABLE share_links(token TEXT, gadget_id TEXT);
CREATE TABLE blueprints(id TEXT, files TEXT);
INSERT INTO users VALUES ('u_1','password-hash','{"modelPicker":{"pi-os-demo":["demo"]}}');
INSERT INTO workspaces VALUES ('w_1','{"defaultModel":{"provider":"pi-os-demo","modelId":"demo"}}');
INSERT INTO gadgets VALUES ('g_1','Keep my title');
INSERT INTO gadget_shares VALUES ('g_1','u_1','viewer');
INSERT INTO share_links VALUES ('same-token','g_1');`);
const html = '<p>My gadget project</p><script>gadget.api.get(); gadget.on("updated", console.log)</script>';
const files = { "index.html": html, "server.js": 'export default class { static readonly=["get"]; get(){return ctx.storage.get("project")} }', "vendor.bundle.js": "// gadget is a vendor term" };
db.prepare("INSERT INTO blueprints VALUES (?,?)").run("bp_1", JSON.stringify(files)); db.close();
const secret = Buffer.alloc(32, 7);
writeFileSync(join(source, "secret.key"), secret);
writeFileSync(join(source, "credentials.enc.json"), '{"opaque":"encrypted bytes must not change"}');
mkdirSync(join(source, "workspaces", "w_1.files"));
writeFileSync(join(source, "workspaces", "w_1.files", "upload.bin"), Buffer.from([0, 7, 255]));
const oldSource = defineDocFamily<any, null>({ kind: "os.gadget.source", version: 1, scope: "session", family: true, initial: () => ({ files: {}, revision: 0 }), checkpointWhen: () => false });
const oldState = defineDocFamily<any, null>({ kind: "os.gadget.state", version: 1, scope: "session", family: true, initial: () => ({ kv: {} }), checkpointWhen: () => false });
const oldGrants = defineDoc<any>({ kind: "os.grants", version: 1, scope: "session", initial: () => ({ grants: {}, requests: {} }), checkpointWhen: () => false });
const store = await openNodeSqliteStorage(join(source, "workspaces", "w_1.sqlite"));
const h = await Harness.open(store, { models: createModels({}), registry: createRegistry() }, ctx);
try {
	await h.commit(async (tx) => {
		const src = await tx.doc(oldSource, "g_1", null); src.files = files; src.revision = 1;
		(await tx.doc(oldState, "g_1", null)).kv = { project: { gadget: "original user data", gatekeepers: ["do not rename"] } };
		(await tx.doc(oldGrants)).grants.g1 = { gatekeeper: "azure-devops", holder: { kind: "project", id: "p_1" }, methods: ["list_projects"] };
	}, ctx);
	await h.commit(async (tx) => { (await tx.doc(oldSource, "g_1", null)).files["index.html"] += "<footer>unchanged</footer>"; }, ctx);
} finally { await h.close(ctx); }

const repo = join(source, "projects", "p_1", "repo");
const worker = join(source, "projects", "p_1", "worktrees", "worker");
mkdirSync(join(repo, ".pios"), { recursive: true });
writeFileSync(join(repo, ".pios", "project.json"), '{"test":"echo ok"}');
writeFileSync(join(repo, "app.txt"), "committed\n");
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=Migration test", "-c", "user.email=test@example.invalid", "-c", "core.autocrlf=false", "-C", cwd, ...args], { encoding: "utf8", windowsHide: true }).trim();
git(repo, "init", "-q", "-b", "main"); git(repo, "config", "user.name", "Migration test"); git(repo, "config", "user.email", "test@example.invalid");
git(repo, "add", "."); git(repo, "commit", "-qm", "fixture");
git(repo, "worktree", "add", "-qb", "agent/worker", worker);
writeFileSync(join(worker, "app.txt"), "staged\n"); git(worker, "add", "app.txt"); writeFileSync(join(worker, "app.txt"), "unstaged\n");
const beforeHead = git(repo, "rev-parse", "HEAD");
const originalPointer = readFileSync(join(worker, ".git"), "utf8");
const sourceAlias = join(testDir, "legacy-alias");
symlinkSync(source, sourceAlias, process.platform === "win32" ? "junction" : "dir");
mkdirSync(join(worker, "node_modules")); writeFileSync(join(worker, "node_modules", "cache"), "reinstallable");

try {
	const code = migrateCode('gadget.api.get(); ctx.storage.get("gadget"); const obj = { gadget: "original" }; obj.gadget; ctx["gatekeepers"].web.get({});');
	check("code migration changes API references, not literals or user properties", code.includes('module.api.get()') && code.includes('storage.get("gadget")') && code.includes('obj.gadget') && code.includes('ctx["airlocks"]'));
	const report = await migrateData(sourceAlias, dest, final);
	check("path aliases never redirect source worktrees into the copy", readFileSync(join(worker, ".git"), "utf8") === originalPointer && existsSync(join(worker, ".pios", "project.json")));
	check("migrates system + workspace and a mission", report.databases === 2 && report.missions === 1);
	check("source database schema is unchanged", (() => { const d = new DatabaseSync(join(source, "system.sqlite"), { readOnly: true }); try { return !!d.prepare("SELECT 1 FROM sqlite_master WHERE name='gadgets'").get(); } finally { d.close(); } })());
	check("original repository and worktree are untouched", git(repo, "rev-parse", "HEAD") === beforeHead && git(worker, "show", ":app.txt") === "staged" && readFileSync(join(worker, "app.txt"), "utf8") === "unstaged\n");
	check("secrets and uploaded bytes are unchanged", readFileSync(join(dest, "secret.key")).equals(secret) && readFileSync(join(dest, "credentials.enc.json")).equals(readFileSync(join(source, "credentials.enc.json"))) && readFileSync(join(dest, "workspaces", "w_1.files", "upload.bin")).equals(Buffer.from([0, 7, 255])));
	check("node_modules caches are omitted", !existsSync(join(dest, "missions", "p_1", "worktrees", "worker", "node_modules")));
	const d = new DatabaseSync(join(dest, "system.sqlite"), { readOnly: true });
	try {
		check("module ID, share roles and link tokens survive", d.prepare("SELECT id FROM modules").get()!.id === "g_1" && d.prepare("SELECT role FROM module_shares WHERE module_id='g_1'").get()!.role === "viewer" && d.prepare("SELECT module_id FROM share_links WHERE token='same-token'").get()!.module_id === "g_1");
		check("password hash is unchanged", d.prepare("SELECT pw_hash FROM users").get()!.pw_hash === "password-hash");
		const bp = JSON.parse(d.prepare("SELECT files FROM blueprints").get()!.files as string);
		check("blueprint scripts migrate but prose and vendored code do not", bp["index.html"].includes("module.api.get()") && bp["index.html"].includes("My gadget project") && bp["vendor.bundle.js"] === files["vendor.bundle.js"]);
	} finally { d.close(); }
	const newH = await Harness.open(await openNodeSqliteStorage(join(dest, "workspaces", "w_1.sqlite")), { models: createModels({}), registry: createRegistry() }, ctx);
	try {
		const { ModuleSourceDoc, ModuleStateDoc, GrantsDoc } = await import("../src/kernel/docs.ts");
		const src = await newH.snapshot(ModuleSourceDoc, "g_1", ctx);
		check("real harness reads migrated base + delta history", src?.files["index.html"]?.includes("module.api.get()") && src.files["index.html"].endsWith("<footer>unchanged</footer>"));
		const state = await newH.snapshot(ModuleStateDoc, "g_1", ctx);
		check("module user data preserves old-word keys and content", JSON.stringify(state?.kv) === JSON.stringify({ project: { gadget: "original user data", gatekeepers: ["do not rename"] } }));
		const grant = (await newH.snapshot(GrantsDoc, ctx))?.grants.g1;
		check("capabilities keep their methods, with new holder and airlock fields", grant?.airlock === "azure-devops" && grant.holder.kind === "mission" && grant.methods?.[0] === "list_projects");
	} finally { await newH.close(ctx); }
	const targetRepo = join(dest, "missions", "p_1", "repo");
	const targetWorker = join(dest, "missions", "p_1", "worktrees", "worker");
	check("run manifest is renamed and committed on main and agent branch", git(targetRepo, "show", "HEAD:.outpost/mission.json").includes("echo ok") && git(targetWorker, "show", "HEAD:.outpost/mission.json").includes("echo ok") && !existsSync(join(targetRepo, ".pios")));
	check("migration does not commit unrelated staged or unstaged work", git(targetWorker, "show", ":app.txt") === "staged" && git(targetWorker, "show", "HEAD:app.txt") === "committed" && readFileSync(join(targetWorker, "app.txt"), "utf8") === "unstaged\n");
	check("copied worktree points only at the migrated repository", realpathSync.native(resolve(targetWorker, git(targetWorker, "rev-parse", "--git-common-dir"))).startsWith(realpathSync.native(dest)));
	let refused = false; try { await migrateData(source, dest); } catch { refused = true; }
	check("a second run cannot overwrite the destination", refused);
	const cfg = migrateConfig({ gatekeepers: { github: { token: "$GITHUB_TOKEN" } }, connectors: [{ params: { project: "Azure project" } }] });
	check("config renames only platform keys, not service project parameters", cfg.airlocks.github.token === "$GITHUB_TOKEN" && !cfg.gatekeepers && cfg.connectors[0].params.project === "Azure project");
	const envelope = migrateEnvelope({ kind: "os.user", data: { text: "My gadget project on pi-os" }, call: { type: "toolCall", name: "gadget_call", arguments: { gadget: "g_1", args: [{ project: "user value" }] } } }, source, final);
	check("tool envelope changes without rewriting user text or RPC payload", envelope.kind === "outpost.user" && envelope.data.text === "My gadget project on pi-os" && envelope.call.name === "module_call" && envelope.call.arguments.module === "g_1" && envelope.call.arguments.args[0].project === "user value");
	const agent = migrateDocument("pi.agent", { extensions: ["os", "pios-project"], cwd: repo, model: { provider: "pi-os-demo", modelId: "demo" }, instructions: "Use gadget.api and .pios/project.json" }, source, final);
	check("agent extension IDs, working directory and model survive the clean break", agent.extensions.join() === "outpost,outpost-mission" && agent.cwd === join(final, "missions", "p_1", "repo") && agent.model.provider === "outpost-demo" && agent.instructions.includes(".outpost/mission.json"));
	check("pending Azure writes keep their argument schema", migrateDocument("os.approvals", { actions: { a: { gatekeeper: "azure-devops", requestedBy: { kind: "project", id: "p_1" }, args: { project: "Shop" } } } }, source, final).actions.a.args.project === "Shop");
	// ---------------------------------------------------------------- the one-line command
	// `pnpm run migration <old-root>` is the documented way in: it reads this project's config for the
	// destination, falls back to ./data, and converts the old config beside it. The old root here is the
	// fixture above, which is already a whole old instance (data + mission repositories).
	console.log("the one-command migration");
	const oldRoot = source;
	// Kept outside the old root so it isn't copied into the migrated data.
	const oldConfigPath = join(testDir, "pi-os.config.json");
	writeFileSync(oldConfigPath, JSON.stringify({ gatekeepers: { github: { token: "$GITHUB_TOKEN" } }, models: { default: "pi-os-demo/demo" } }));
	const project = join(testDir, "fresh-project");
	mkdirSync(project, { recursive: true });
	const env: NodeJS.ProcessEnv = { ...process.env, INIT_CWD: project, GIT_AUTHOR_NAME: "Migration", GIT_AUTHOR_EMAIL: "m@example.com", GIT_COMMITTER_NAME: "Migration", GIT_COMMITTER_EMAIL: "m@example.com" };
	delete env.OUTPOST_DATA;
	delete env.OUTPOST_CONFIG;
	const cli = [join(import.meta.dirname, "..", "node_modules", "tsx", "dist", "cli.mjs"), join(import.meta.dirname, "..", "scripts", "migrate.ts")];
	const args = [oldRoot, "--config", oldConfigPath];

	// Dry run first: it must not create anything.
	const dry = execFileSync(process.execPath, [...cli, ...args, "--dry-run"], { env, encoding: "utf8", stdio: "pipe" });
	check("a dry run reports the plan", /destination\s+.*fresh-project[\\/]data/.test(dry) && /Dry run/.test(dry), dry.split("\n").slice(0, 6).join(" | "));
	check("…and changes nothing", !existsSync(join(project, "data")) && !existsSync(join(project, "outpost.config.json")));

	let out = "";
	try {
		out = execFileSync(process.execPath, [...cli, ...args], { env, encoding: "utf8", stdio: "pipe" });
	} catch (error) {
		const e = error as { stdout?: string; stderr?: string };
		console.log("   DEBUG stdout:", (e.stdout ?? "").slice(-800));
		console.log("   DEBUG stderr:", (e.stderr ?? "").slice(-1500));
		throw error;
	}
	check("the command migrates the data", existsSync(join(project, "data", "system.sqlite")) && existsSync(join(project, "data", "missions", "p_1", "repo")), out.split("\n").find((l) => l.startsWith("data")));
	const written = JSON.parse(readFileSync(join(project, "outpost.config.json"), "utf8"));
	check("…and writes this project's config next to it", written.airlocks?.github?.token === "$GITHUB_TOKEN" && !written.gatekeepers, written);
	check("…with dataDir pointing at what it just wrote", written.dataDir === "data", written.dataDir);
	check("…leaving the old checkout untouched", !existsSync(join(oldRoot, "outpost-migration.json")) && existsSync(join(oldRoot, "system.sqlite")));

	let again = "";
	try {
		execFileSync(process.execPath, [...cli, ...args], { env, encoding: "utf8", stdio: "pipe" });
	} catch (error) {
		again = String((error as { stderr?: string; message?: string }).stderr ?? (error as Error).message);
	}
	check("a second run refuses rather than overwriting the destination", /already exists and is not empty/.test(again), again.split("\n").filter((l) => l.includes("already exists"))[0]);
	const into = join(testDir, "elsewhere");
	execFileSync(process.execPath, [...cli, ...args, "--into", into, "--data-only"], { env, encoding: "utf8", stdio: "pipe" });
	check("--into picks a destination, and --data-only leaves the config alone", existsSync(join(into, "system.sqlite")) && !existsSync(join(testDir, "elsewhere", "outpost.config.json")));
} catch (e) { await finish(e); }
await finish();
