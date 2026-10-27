/**
 * Why merges conflicted in real missions, and the fixes:
 *  - outpost's generated files (docs/backlog.md, docs/retrospectives/) take main's version on every merge;
 *  - repositories carry LF line endings (.gitattributes) and repo-local git config (no CRLF conversion,
 *    "outpost agents" identity), so agents' own git commands behave like outpost's;
 *  - the scheduler doesn't run tasks with overlapping areas in parallel.
 * Run: pnpm --filter @outpost/server test -- conflicts
 */
import { check, finish, passDocGates, until } from "./lib/harness.ts";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { users, workspaces } = await import("../src/kernel/system-db.ts");
const { Workspace } = await import("../src/kernel/workspace.ts");
const { addItems } = await import("../src/missions/backlog.ts");
const { git, MissionRepo } = await import("../src/missions/repo.ts");
const { areasOverlap } = await import("../src/missions/build.ts");

const u = users.create("conflicts", "password123");
const ws = await Workspace.get(workspaces.create("conflicts", u.id).id);
const pm = ws.missions;
pm.build.nudges = false;
const p = await pm.create(u, { goal: "Merge conflict regression mission", model: { provider: "outpost-demo", modelId: "demo" } });
await passDocGates(ws, p.id);
await pm.stopAll(p.id);
const repo = pm.repo(p.id);
const write = (dir: string, path: string, c: string) => {
	const f = join(dir, path);
	mkdirSync(join(f, ".."), { recursive: true });
	writeFileSync(f, c);
};
/** git as an agent runs it in its shell: no -c overrides, only the repo's own config (plus the machine's). */
const shellGit = (dir: string, ...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "", GIT_COMMITTER_NAME: "" } });
const hasCR = async (ref: string, path: string) => (await git(repo.main, ["show", `${ref}:${path}`])).includes("\r");

// ------------------------------------------------------------------ repository setup
console.log("repository setup");
check("new repos carry LF line endings", (await git(repo.main, ["show", "HEAD:.gitattributes"])).includes("* text=auto eol=lf"));
check("repo-local config: no CRLF conversion, outpost agents identity", (await git(repo.main, ["config", "--local", "core.autocrlf"])).trim() === "false" && (await git(repo.main, ["config", "--local", "user.name"])).trim() === "outpost agents");
const devDir = await repo.ensureWorktree("dev-1");
write(devDir, "app/own.txt", "mine\n");
shellGit(devDir, "add", "-A");
execFileSync("git", ["commit", "-q", "-m", "agent's own commit"], { cwd: devDir });
check("an agent's own git commit is authored by outpost agents, not the machine's user", execFileSync("git", ["log", "-1", "--format=%an <%ae>"], { cwd: devDir, encoding: "utf8" }).trim() === "outpost agents <agents@outpost.local>");
write(devDir, "app/crlf.css", "a {\r\n  color: red;\r\n}\r\n");
const sub = await repo.submit("dev-1", "crlf file");
check("CRLF written in a worktree is stored as LF", !!sub.commit && !(await hasCR(sub.commit!, "app/crlf.css")));

// an older mission: no .gitattributes, no repo-local config, a CRLF file committed
const legacyRoot = mkdtempSync(join(tmpdir(), "outpost-legacy-"));
const legacy = new MissionRepo("legacy");
(legacy as any).root = legacyRoot;
(legacy as any).main = join(legacyRoot, "repo");
mkdirSync(legacy.main, { recursive: true });
execFileSync("git", ["init", "-q", "-b", "main"], { cwd: legacy.main });
execFileSync("git", ["config", "core.autocrlf", "false"], { cwd: legacy.main });
write(legacy.main, "a.txt", "one\r\ntwo\r\n");
execFileSync("git", ["add", "-A"], { cwd: legacy.main });
execFileSync("git", ["-c", "user.name=x", "-c", "user.email=x@x", "commit", "-q", "-m", "legacy"], { cwd: legacy.main });
execFileSync("git", ["config", "--unset", "core.autocrlf"], { cwd: legacy.main });
await legacy.ensureSetup();
check("older repos get the setup: .gitattributes + renormalised + config", (await git(legacy.main, ["show", "HEAD:.gitattributes"])).includes("eol=lf") && !(await git(legacy.main, ["show", "HEAD:a.txt"])).includes("\r") && (await git(legacy.main, ["config", "--local", "user.name"])).trim() === "outpost agents");
const legacy2Root = mkdtempSync(join(tmpdir(), "outpost-legacy-"));
const legacy2 = new MissionRepo("legacy2");
(legacy2 as any).root = legacy2Root;
(legacy2 as any).main = join(legacy2Root, "repo");
mkdirSync(legacy2.main, { recursive: true });
execFileSync("git", ["init", "-q", "-b", "main"], { cwd: legacy2.main });
write(legacy2.main, "a.txt", "x\n");
execFileSync("git", ["add", "-A"], { cwd: legacy2.main });
execFileSync("git", ["-c", "user.name=x", "-c", "user.email=x@x", "commit", "-q", "-m", "legacy"], { cwd: legacy2.main });
write(legacy2.main, "a.txt", "uncommitted work\n");
await legacy2.ensureSetup();
check("setup never commits uncommitted work in main", (await git(legacy2.main, ["show", "HEAD:a.txt"])) === "x\n" && (await git(legacy2.main, ["status", "--porcelain"])).includes("a.txt"));

// ------------------------------------------------------------------ generated files
console.log("generated files");
await repo.writeMain("docs/backlog.md", "# Backlog v1\n", "snapshot 1");
await repo.sync("dev-1");
write(devDir, "docs/backlog.md", "# Backlog edited by an agent (or flipped to CRLF)\r\n");
write(devDir, "app/feature.js", "export const f = 1;\n");
await repo.writeMain("docs/backlog.md", "# Backlog v2 (outpost)\n", "snapshot 2");
const pub = await repo.publish("dev-1", "feature");
check("publish: a branch that touched docs/backlog.md merges without a conflict", pub.merged && !pub.conflict, pub);
check("main keeps outpost's backlog snapshot", (await git(repo.main, ["show", "HEAD:docs/backlog.md"])) === "# Backlog v2 (outpost)\n" && (await repo.files()).includes("app/feature.js"));
write(devDir, "docs/retrospectives/0001-x.md", "agent edit\n");
await repo.writeMain("docs/retrospectives/0001-x.md", "outpost retro\n", "retro");
await repo.writeMain("docs/backlog.md", "# Backlog v3 (outpost)\n", "snapshot 3");
check("sync: generated files resolve to main", /Merged the latest main|Up to date/.test(await repo.sync("dev-1")) && (await git(devDir, ["show", "HEAD:docs/retrospectives/0001-x.md"])) === "outpost retro\n");

// real conflicts are still reported, and only the real files
const dev2 = await repo.ensureWorktree("dev-2");
await repo.sync("dev-2");
write(devDir, "app/shared.js", "export const a = 'dev-1';\n");
await repo.publish("dev-1", "shared by dev-1");
write(dev2, "app/shared.js", "export const a = 'dev-2';\n");
write(dev2, "docs/backlog.md", "dev-2 touched it too\n");
await repo.writeMain("docs/backlog.md", "# Backlog v4 (outpost)\n", "snapshot 4");
const clash = await repo.publish("dev-2", "shared by dev-2");
check("a real conflict is reported, without the generated files", !clash.merged && /conflicts in: app\/shared\.js\./.test(clash.conflict ?? ""), clash.conflict);

// ------------------------------------------------------------------ overlapping areas
console.log("overlapping areas");
check("areasOverlap: a path inside another overlaps", areasOverlap("app/src/sim", "app/src/sim/state.js") && areasOverlap("app/src/sim/state.js", "app/src/sim/"));
check("areasOverlap: lists overlap when any path does", areasOverlap("app/styles, app/src/ui", "app/src/ui/panel.js"));
check("areasOverlap: siblings don't overlap", !areasOverlap("app/src/sim", "app/src/simulation") && !areasOverlap("app/src/ui", "app/styles"));
for (const k of ["dev-1", "dev-2"]) await repo.checkoutOwnBranch(k).catch(() => {});
for (const role of ["worker", "worker"]) await pm.addAgent(p.id, { role, brief: "wait", start: false });
const devs = Object.values((await pm.state(p.id)).agents)
	.filter((a) => a.role === "worker")
	.map((a) => a.key);
await pm.editBacklog(p.id, (b) =>
	addItems(
		b,
		[
			{ ref: "f", type: "feature", title: "Sim" },
			{ ref: "p", type: "pbi", parent: "f", title: "World" },
			{ type: "task", parent: "p", title: "Sim core", area: "app/src/sim" },
			{ type: "task", parent: "p", title: "State shape", area: "app/src/sim/state.js" },
			{ type: "task", parent: "p", title: "Panel", area: "app/src/ui" },
		],
		"planner",
	),
);
await pm.approveBacklog(p.id, u);
const items = async () => Object.values((await pm.backlog(p.id)).items).filter((i) => i.type === "task");
await until("two assignments", async () => (await items()).filter((t) => t.status === "doing").length === 2);
const doing = (await items()).filter((t) => t.status === "doing").map((t) => t.title).sort();
check("overlapping areas don't run in parallel; a separate area does", doing.join() === "Panel,Sim core" && devs.length === 2, doing);

await finish();
