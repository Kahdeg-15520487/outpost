/**
 * Offline, one-way migration. Run against a STOPPED instance:
 *   pnpm --filter @outpost/server exec tsx scripts/migrate-outpost.ts <old-data> <new-data> [final-data]
 * The destination must not exist. Source files are never changed. Keep the source as the rollback
 * backup and deploy the destination only after verification. node_modules caches are not copied.
 * This is a migration utility, NOT a runtime compatibility layer.
 */
import { DatabaseSync, backup } from "node:sqlite";
import { closeSync, cpSync, existsSync, ftruncateSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { applyImmutable } from "@earendil-works/chord/delta";
import { parse } from "acorn";
import { parse as parseLoose } from "acorn-loose";

type Json = any;
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const entries = (v: Json): Json[] => Object.values(v ?? {});
const renamedKind = (s: string) => s.startsWith("os.") ? s.replace(/^os\./, "outpost.").replace("gadget", "module").replace("project", "mission") : s;
const toolName = (s: string) => s.replace(/^gadget_/, "module_").replace(/^gatekeeper_/, "airlock_").replace(/^file_share_with_gadget$/, "file_share_with_module");
const extensionName = (s: string) => s === "os" ? "outpost" : s === "pios-project" ? "outpost-mission" : s;
const holder = (h: Json) => {
	if (h?.kind === "gadget") h.kind = "module";
	if (h?.kind === "project") h.kind = "mission";
	return h;
};
function renameKey(v: Json, old: string, next: string) {
	if (v && Object.hasOwn(v, old)) {
		if (Object.hasOwn(v, next)) throw new Error(`Conflicting migration fields: ${old}, ${next}`);
		v[next] = v[old]; delete v[old];
	}
}
const model = (m: Json) => { if (m?.provider === "pi-os-demo") m.provider = "outpost-demo"; };

/** Only executable platform API references. Module data and prose are never run through this. */
export function migrateCode(code: string): string {
	const options = { ecmaVersion: "latest" as const, sourceType: "module" as const, allowAwaitOutsideFunction: true };
	let tree: Json;
	try { tree = parse(code, options); } catch { tree = parseLoose(code, options); } // old edit fragments can be incomplete
	const edits = new Map<number, { start: number; end: number; value: string }>();
	const text = (n: Json) => n ? code.slice(n.start, n.end) : "";
	const visit = (n: Json, p?: Json, gp?: Json, ggp?: Json) => {
		if (!n || typeof n !== "object" || !n.type) return;
		if (n.type === "Identifier") {
			const property = (p?.type === "MemberExpression" && p.property === n && !p.computed) || (["Property", "MethodDefinition"].includes(p?.type) && p.key === n && !p.computed);
			let value: string | undefined;
			if (n.name === "gadget" && (!property || (p?.type === "MemberExpression" && /^(window|globalThis)$/.test(text(p.object))))) value = "module";
			if (n.name === "gatekeepers" && p?.type === "MemberExpression" && /(?:^|\.)ctx$/.test(text(p.object))) value = "airlocks";
			if (p?.type === "MemberExpression" && p.property === n && text(p.object) === "tools") value = toolName(n.name);
			if (p?.type === "Property" && p.key === n && gp?.type === "ObjectExpression" && ggp?.type === "CallExpression") {
				const call = text(ggp.callee);
				if (/^tools\.(gadget_|file_share_with_gadget)/.test(call) && n.name === "gadget") value = "module";
				if (call === "tools.request_access") value = ({ gatekeeper: "airlock", forGadget: "forModule" } as Record<string, string>)[n.name];
			}
			if (value && value !== n.name) edits.set(n.start, { start: n.start, end: n.end, value });
		}
		if (n.type === "MemberExpression" && n.computed && n.property.type === "Literal" && typeof n.property.value === "string") {
			const key = n.property; const receiver = text(n.object);
			const value = key.value === "gadget" && /^(window|globalThis)$/.test(receiver) ? "module" : key.value === "gatekeepers" && /(?:^|\.)ctx$/.test(receiver) ? "airlocks" : receiver === "tools" ? toolName(key.value) : key.value;
			if (value !== key.value) edits.set(key.start, { start: key.start, end: key.end, value: JSON.stringify(value) });
		}
		for (const child of Object.values(n)) {
			if (Array.isArray(child)) for (const c of child) visit(c, n, p, gp);
			else if (child && typeof child === "object") visit(child, n, p, gp);
		}
	};
	visit(tree);
	for (const e of [...edits.values()].sort((a, b) => b.start - a.start)) code = code.slice(0, e.start) + e.value + code.slice(e.end);
	return code;
}
function sourceFiles(files: Record<string, string>) {
	return Object.fromEntries(Object.entries(files).map(([p, text]) => [p,
		// Vendored JS is third-party code, not our API. HTML: change scripts only, preserving page text.
		/\.(?:bundle|min)\.js$/.test(p) ? text : /\.html?$/.test(p)
			? text.replace(/(<script\b[^>]*>)([\s\S]*?)(<\/script>)/gi, (_, a, b, c) => a + migrateCode(b) + c)
			: /\.[cm]?js$/.test(p) ? migrateCode(text) : text,
	]));
}
function operationalText(s: string) {
	return migrateCode(s).replace(/\.pios[\\/]project\.json/g, ".outpost/mission.json").replace(/\.pios\//g, ".outpost/")
		.replace(/\bpi-os\b/g, "Outpost").replace(/\bGadgets?\b/g, (s) => s === "Gadgets" ? "Modules" : "Module")
		.replace(/\bGatekeepers?\b/g, (s) => s === "Gatekeepers" ? "Airlocks" : "Airlock");
}
function pathMove(text: string, oldRoot: string, newRoot: string) {
	for (const [a, b] of [[oldRoot, newRoot], [oldRoot.replaceAll("\\", "/"), newRoot.replaceAll("\\", "/")]]) {
		text = text.split(`${a}${a.includes("\\") ? "\\" : "/"}projects${a.includes("\\") ? "\\" : "/"}`)
			.join(`${b}${b.includes("\\") ? "\\" : "/"}missions${b.includes("\\") ? "\\" : "/"}`);
	}
	return text;
}

/** Tool-call envelope only: third-party arguments, user text and stored application data stay intact. */
export function migrateEnvelope(input: Json, oldRoot: string, newRoot: string): Json {
	if (Array.isArray(input)) return input.map((v) => migrateEnvelope(v, oldRoot, newRoot));
	if (!input || typeof input !== "object") return input;
	const v = clone(input);
	const oldTool = typeof v.name === "string" && (v.type === "toolCall" || v.arguments !== undefined) ? v.name : undefined;
	if (oldTool) {
		v.name = toolName(oldTool);
		const a = v.arguments;
		if (a && typeof a === "object") {
			if (/^gadget_|^file_share_with_gadget$/.test(oldTool)) renameKey(a, "gadget", "module");
			if (oldTool === "request_access") { renameKey(a, "gatekeeper", "airlock"); renameKey(a, "forGadget", "forModule"); }
			if (oldTool === "gadget_write" && typeof a.content === "string") a.content = migrateCode(a.content);
			if (oldTool === "gadget_edit") for (const e of a.edits ?? []) { e.oldText = migrateCode(e.oldText); e.newText = migrateCode(e.newText); }
			if (oldTool === "codemode" && typeof a.code === "string") a.code = operationalText(a.code);
		}
	}
	if (typeof v.toolName === "string") v.toolName = toolName(v.toolName);
	if (typeof v.kind === "string") v.kind = renamedKind(v.kind);
	if (v.details) renameKey(v.details, "openGadget", "openModule");
	for (const [k, child] of Object.entries(v)) {
		if (k === "arguments" || k === "args") continue;
		if (k === "extensions" && Array.isArray(child)) v[k] = child.map(extensionName);
		else if (k === "model") { model(child); }
		else if (k === "cwd" && typeof child === "string") v[k] = pathMove(child, oldRoot, newRoot);
		else if (k === "instructions" && typeof child === "string") v[k] = pathMove(operationalText(child), oldRoot, newRoot);
		else if (child && typeof child === "object") v[k] = migrateEnvelope(child, oldRoot, newRoot);
	}
	return v;
}

export function migrateDocument(kind: string, input: Json, oldRoot: string, newRoot: string): Json {
	const v = clone(input);
	if (kind === "os.gadget.source") { v.files = sourceFiles(v.files); return v; }
	if (kind === "os.projects") { renameKey(v, "projects", "missions"); for (const m of entries(v.missions)) model(m.model); }
	if (kind === "os.project") for (const a of entries(v.agents)) { model(a.model); if (a.brief) a.brief = pathMove(operationalText(a.brief), oldRoot, newRoot); }
	if (kind === "os.files") for (const f of entries(v.files)) { renameKey(f, "gadgets", "modules"); if (f.source === "gadget") f.source = "module"; }
	if (kind === "os.grants") for (const g of [...entries(v.grants), ...entries(v.requests)]) { renameKey(g, "gatekeeper", "airlock"); holder(g.holder); }
	if (kind === "os.approvals") for (const a of entries(v.actions)) { renameKey(a, "gatekeeper", "airlock"); holder(a.requestedBy); }
	if (kind === "os.audit") for (const l of v.lines ?? []) renameKey(l, "gatekeeper", "airlock");
	if (kind === "os.activity") for (const r of v.runs ?? []) r.tools = Object.fromEntries(Object.entries(r.tools ?? {}).map(([k, n]) => [toolName(k), n]));
	if (kind === "pi.agent") {
		const next = migrateEnvelope(v, oldRoot, newRoot);
		for (const key of ["tools", "modelTools"]) if (Array.isArray(next[key])) next[key] = next[key].map((t: Json) => typeof t === "string" ? toolName(t) : migrateEnvelope(t, oldRoot, newRoot));
		return next;
	}
	if (["pi.codemode.run", "pi.tool.nested-call", "pi.codemode.journal"].includes(kind)) return migrateEnvelope(v, oldRoot, newRoot);
	// In particular: os.gadget.state, chat text, connection params/schema, Azure project fields,
	// uploaded file contents and arbitrary codemode values are opaque, not branding strings.
	return v;
}

function transaction(db: DatabaseSync, f: () => void) {
	db.exec("BEGIN IMMEDIATE");
	try { f(); db.exec("COMMIT"); } catch (e) { db.exec("ROLLBACK"); throw e; }
}
function integrity(db: DatabaseSync) {
	if (Object.values(db.prepare("PRAGMA integrity_check").get()!)[0] !== "ok") throw new Error("SQLite integrity check failed");
}
export function migrateSystem(file: string) {
	const db = new DatabaseSync(file);
	try {
		if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='gadgets'").get()) throw new Error("Not an unmigrated system database");
		transaction(db, () => {
			db.exec(`ALTER TABLE gadgets RENAME TO modules;
			ALTER TABLE gadget_shares RENAME TO module_shares;
			ALTER TABLE module_shares RENAME COLUMN gadget_id TO module_id;
			ALTER TABLE share_links RENAME COLUMN gadget_id TO module_id;`);
			for (const row of db.prepare("SELECT id,files FROM blueprints").all() as any[]) {
				db.prepare("UPDATE blueprints SET files=? WHERE id=?").run(JSON.stringify(sourceFiles(JSON.parse(row.files))), row.id);
			}
			for (const row of db.prepare("SELECT id,settings FROM workspaces").all() as any[]) {
				const settings = JSON.parse(row.settings); model(settings.defaultModel);
				db.prepare("UPDATE workspaces SET settings=? WHERE id=?").run(JSON.stringify(settings), row.id);
			}
			for (const row of db.prepare("SELECT id,prefs FROM users").all() as any[]) {
				const prefs = JSON.parse(row.prefs); if (prefs.modelPicker) renameKey(prefs.modelPicker, "pi-os-demo", "outpost-demo");
				db.prepare("UPDATE users SET prefs=? WHERE id=?").run(JSON.stringify(prefs), row.id);
			}
		}); integrity(db);
	} finally { db.close(); }
}

export function migrateWorkspace(file: string, oldRoot: string, newRoot: string) {
	const db = new DatabaseSync(file);
	try {
		transaction(db, () => {
			for (const doc of db.prepare("SELECT id,kind,record FROM documents").all() as any[]) {
				const kind = JSON.parse(doc.kind);
				const next = renamedKind(kind);
				if (next !== kind) {
					const record = JSON.parse(doc.record); record.kind = next;
					db.prepare("UPDATE documents SET kind=?,record=? WHERE id=?").run(JSON.stringify(next), JSON.stringify(record), doc.id);
				}
				if (!kind.startsWith("os.") && !["pi.agent", "pi.codemode.run", "pi.tool.nested-call", "pi.codemode.journal"].includes(kind)) continue;
				let value: Json;
				// Re-materialize each revision with the original deltas before converting it. This avoids
				// corrupting string/array splice offsets, and preserves every historical sequence number.
				for (const row of db.prepare("SELECT seq,kind,content FROM document_revisions WHERE document_id=? ORDER BY seq").all(doc.id) as any[]) {
					const content = JSON.parse(row.content);
					if (row.kind === "delta" && value === undefined) throw new Error(`No base for document ${doc.id}`);
					value = row.kind === "base" ? content : applyImmutable(value, content);
					const converted = migrateDocument(kind, value, oldRoot, newRoot);
					db.prepare("UPDATE document_revisions SET kind='base',content=? WHERE document_id=? AND seq=?").run(JSON.stringify(converted), doc.id, row.seq);
				}
			}
			for (const table of ["conversations", "entries", "tasks", "submissions"]) {
				for (const row of db.prepare(`SELECT id,record FROM ${table}`).all() as any[]) {
					const converted = JSON.stringify(migrateEnvelope(JSON.parse(row.record), oldRoot, newRoot));
					if (converted !== row.record) db.prepare(`UPDATE ${table} SET record=? WHERE id=?`).run(converted, row.id);
				}
			}
		}); integrity(db);
	} finally { db.close(); }
}

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "core.autocrlf=false", "-C", cwd, ...args], { encoding: "utf8", windowsHide: true, maxBuffer: 32 << 20 }).trim();
function missionRoots(data: string) {
	const dir = join(data, "missions");
	return existsSync(dir) ? readdirSync(dir).filter((n) => existsSync(join(dir, n, "repo", ".git"))).map((n) => join(dir, n)) : [];
}

/** Rewrite BOTH ends of worktree links before invoking git; never let a copied worktree touch the original repo. */
export function relocateRepositories(data: string, oldRoot: string, newRoot = data) {
	for (const root of missionRoots(data)) {
		const main = join(root, "repo");
		const pointers = [join(main, ".git", "config")];
		const admin = join(main, ".git", "worktrees");
		if (existsSync(admin)) for (const name of readdirSync(admin)) pointers.push(join(admin, name, "gitdir"));
		for (const d of [join(root, "preview"), join(root, "verify"), ...(existsSync(join(root, "worktrees")) ? readdirSync(join(root, "worktrees")).map((n) => join(root, "worktrees", n)) : [])]) pointers.push(join(d, ".git"));
		for (const p of pointers) if (existsSync(p) && statSync(p).isFile()) {
			let text = readFileSync(p, "utf8");
			for (const slash of ["/", "\\"]) {
				const old = resolve(oldRoot).replace(/[\\/]/g, slash);
				const next = resolve(newRoot).replace(/[\\/]/g, slash);
				text = text.split(`${old}${slash}projects${slash}`).join(`${next}${slash}missions${slash}`)
					.split(`${old}${slash}missions${slash}`).join(`${next}${slash}missions${slash}`);
			}
			// Git for Windows marks .git files hidden: opening with O_CREAT ('w') fails with EPERM.
			const fd = openSync(p, "r+");
			try { ftruncateSync(fd, 0); writeFileSync(fd, text); } finally { closeSync(fd); }
		}
		git(main, "worktree", "repair");
	}
}
function migrateRepo(root: string) {
	// Dependency caches were omitted; force preview/verification installs on next use.
	for (const name of ["preview-install.sha1", "verify-install.sha1"]) rmSync(join(root, name), { force: true });
	const main = join(root, "repo");
	const worktrees = git(main, "worktree", "list", "--porcelain").split("\n\n").filter(Boolean).map((s) => ({
		dir: /^worktree (.+)$/m.exec(s)![1]!, branch: /^branch refs\/heads\/(.+)$/m.exec(s)?.[1],
	}));
	const convert = (dir: string) => {
		const old = join(dir, ".pios", "project.json");
		if (!existsSync(old)) return;
		const next = join(dir, ".outpost", "mission.json");
		if (existsSync(next)) throw new Error(`Both run configurations exist in ${dir}`);
		mkdirSync(dirname(next), { recursive: true }); renameSync(old, next);
		if (!readdirSync(dirname(old)).length) rmSync(dirname(old), { recursive: true });
		git(dir, "add", "--", ".pios/project.json", ".outpost/mission.json");
		// --only keeps unrelated staged and unstaged work out of the migration commit.
		git(dir, "commit", "--only", "-m", "Migrate run configuration to Outpost", "--", ".pios/project.json", ".outpost/mission.json");
	};
	for (const w of worktrees) convert(w.dir);
	for (const branch of git(main, "for-each-ref", "--format=%(refname:short)", "refs/heads").split("\n").filter(Boolean)) {
		if (worktrees.some((w) => w.branch === branch)) continue;
		if (!git(main, "ls-tree", "--name-only", branch, "--", ".pios/project.json")) continue;
		const temp = join(root, "migration-worktree");
		git(main, "worktree", "add", "-q", temp, branch);
		try { convert(temp); } finally { git(main, "worktree", "remove", temp); }
	}
}

export function migrateConfig(input: Json): Json {
	const cfg = clone(input); renameKey(cfg, "gatekeepers", "airlocks");
	if (cfg.models?.default?.startsWith("pi-os-demo/")) cfg.models.default = cfg.models.default.replace("pi-os-demo/", "outpost-demo/");
	return cfg;
}

export async function migrateData(source: string, destination: string, finalData = destination) {
	source = resolve(source); destination = resolve(destination); finalData = resolve(finalData);
	if (existsSync(destination)) throw new Error("Destination already exists; choose an empty new path");
	if (!existsSync(join(source, "system.sqlite"))) throw new Error("Source has no system.sqlite");
	if (!relative(source, destination).startsWith(`..${sep}`) && !relative(source, destination).startsWith("..")) throw new Error("Destination must be outside source");
	mkdirSync(destination, { recursive: true });
	for (const name of readdirSync(source)) cpSync(join(source, name), join(destination, name === "projects" ? "missions" : name), {
		recursive: true, verbatimSymlinks: true,
		filter: (src) => basename(src) !== "node_modules" && !/\.sqlite(?:-wal|-shm)?$/.test(src),
	});
	const databases = ["system.sqlite", ...readdirSync(join(source, "workspaces")).filter((f) => f.endsWith(".sqlite")).map((f) => join("workspaces", f))];
	for (const f of databases) {
		const db = new DatabaseSync(join(source, f), { readOnly: true });
		try { await backup(db, join(destination, f)); } finally { db.close(); }
	}
	migrateSystem(join(destination, "system.sqlite"));
	for (const f of databases.slice(1)) migrateWorkspace(join(destination, f), source, finalData);
	relocateRepositories(destination, source);
	for (const root of missionRoots(destination)) migrateRepo(root);
	writeFileSync(join(destination, "outpost-migration.json"), JSON.stringify({ version: 1, source, finalData, at: new Date().toISOString(), databases, omittedCaches: ["node_modules"] }, null, 2));
	return { databases: databases.length, missions: missionRoots(destination).length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	const [source, dest, final] = process.argv.slice(2);
	if (!source || !dest) throw new Error("Usage: migrate-outpost.ts <STOPPED-instance-data> <new-destination> [final-data-path]");
	console.log(await migrateData(source, dest, final));
}
