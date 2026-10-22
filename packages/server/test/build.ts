/**
 * Milestones 4 and 5 without a model: the build scheduler (assign → task_done → review → merge) and
 * the live preview (a tiny Node app run from main, restarted after merges). Agents are scripted: the
 * test writes files into their worktrees and calls the same methods their tools call.
 * Run: pnpm --filter @pi-os/server test:build
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PI_OS_DATA ??= mkdtempSync(join(tmpdir(), "pios-build-"));
process.env.PI_OS_CONFIG = "";

const { users, workspaces } = await import("../src/kernel/system-db.ts");
const { Workspace } = await import("../src/kernel/workspace.ts");
const { addItems } = await import("../src/projects/backlog.ts");
const { git } = await import("../src/projects/repo.ts");

let failed = 0;
const check = (name: string, ok: unknown, detail?: unknown) => {
	console.log(`${ok ? "  ✓" : "  ✗"} ${name}${ok ? "" : ` — ${JSON.stringify(detail)}`}`);
	if (!ok) failed++;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(what: string, fn: () => Promise<T | undefined | false>, ms = 20000): Promise<T | undefined> {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		const v = await fn().catch(() => undefined);
		if (v) return v as T;
		await sleep(150);
	}
	console.log(`  … timed out waiting for ${what}`);
	return undefined;
}

const u = users.create("builder", "password123");
const ws = await Workspace.get(workspaces.create("build", u.id).id);
const pm = ws.projects;
pm.build.nudges = false;
const p = await pm.create(u, { goal: "Build flow regression project", model: { provider: "pi-os-demo", modelId: "demo" } });
await pm.stopAll(p.id);
for (const role of ["worker", "worker", "reviewer"]) await pm.addAgent(p.id, { role, brief: "wait for pi-os", start: false });
const agent = async (key: string) => (await pm.state(p.id)).agents[key]!;
const repo = pm.repo(p.id);
const write = (key: string, path: string, content: string) => {
	const file = join(repo.worktree(key), path);
	mkdirSync(join(file, ".."), { recursive: true });
	writeFileSync(file, content);
};
const item = async (id: string) => (await pm.backlog(p.id)).items[id]!;

await pm.editBacklog(p.id, (b) =>
	addItems(
		b,
		[
			{ ref: "f", type: "feature", title: "Hello app" },
			{ ref: "p", type: "pbi", parent: "f", title: "Greets visitors", acceptance: ["GET / says hello"] },
			{ ref: "t1", type: "task", parent: "p", title: "Server", area: "app/server" },
			{ type: "task", parent: "p", title: "Greeting v2", deps: ["t1"], area: "app/server" },
			{ type: "task", parent: "p", title: "Docs", area: "docs" },
		],
		"planner",
	),
);

// ------------------------------------------------------------------ assignment
await pm.editBacklog(p.id, (b) => void (b.approval = { status: "pending", requestedBy: "Planner", requestedAt: Date.now() }));
let b = await pm.backlog(p.id);
check("no assignments before approval", Object.values(b.items).every((i) => i.status === "todo"), Object.values(b.items).map((i) => i.status));

await pm.approveBacklog(p.id, u);
await until("assignments", async () => (await item("T1")).briefed && (await item("T3")).briefed);
const t1 = await item("T1");
const t2 = await item("T2");
const t3 = await item("T3");
check("ready tasks go to free developers", t1.status === "doing" && t1.assignee === "dev-1" && t3.status === "doing" && t3.assignee === "dev-2", [t1, t3].map((t) => [t.status, t.assignee]));
check("a task waits for its dependency", t2.status === "todo" && !t2.assignee, t2);
check("briefs sent and marked", t1.briefed && t3.briefed && t1.attempt === 1, t1);
check("stage moves to build", (await pm.meta(p.id)).stage === "build", (await pm.meta(p.id)).stage);
check("PBI and feature roll up to in progress", (await item("P1")).status === "doing" && (await item("F1")).status === "doing", [(await item("P1")).status, (await item("F1")).status]);

// ------------------------------------------------------------------ task_done → review → changes → approve → merge
const reply0 = await pm.build.taskDone(p.id, await agent("dev-1"), "nothing yet", false);
check("task_done without changes is refused", /no changes compared to main/.test(reply0), reply0);

write("dev-1", "app/server.js", `require("http").createServer((q, s) => s.end("hello v1")).listen(process.env.PORT, "127.0.0.1");\n`);
write("dev-1", "app/package.json", `{ "name": "hello", "private": true }\n`);
write("dev-1", ".pios/project.json", JSON.stringify({ dev: { command: "node server.js", readyPath: "/" } }));
const reply1 = await pm.build.taskDone(p.id, await agent("dev-1"), "server on $PORT", false);
check("task_done submits", /^Submitted T1/.test(reply1), reply1);
await until("review assignment", async () => (await item("T1")).reviewBriefed);
let r1 = await item("T1");
check("submitted work goes to the reviewer", r1.status === "review" && r1.reviewer === "reviewer" && r1.submitted?.files.includes("app/server.js"), r1);
check("reviewer's worktree holds the submitted commit", (await git(repo.worktree("reviewer"), ["rev-parse", "HEAD"])).trim() === r1.submitted?.commit && (await repo.isDetached("reviewer")));

const v1 = await pm.build.verdict(p.id, await agent("reviewer"), "T1", "changes", "Add a newline to the response");
r1 = await item("T1");
check("changes → back to the developer", r1.status === "doing" && !r1.reviewer && /Changes requested/.test(r1.history?.at(-1)?.text ?? ""), [v1, r1.status, r1.history?.at(-1)]);
check("reviewer back on its own branch", !(await repo.isDetached("reviewer")));

write("dev-1", "app/server.js", `require("http").createServer((q, s) => s.end("hello v1\\n")).listen(process.env.PORT, "127.0.0.1");\n`);
await pm.build.taskDone(p.id, await agent("dev-1"), "added the newline", false);
await until("second review", async () => (await item("T1")).reviewBriefed && (await item("T1")).reviewRound === 2);
const before = (await repo.files()).includes("app/server.js");
const v2 = await pm.build.verdict(p.id, await agent("reviewer"), "T1", "approve", "");
r1 = await item("T1");
check("approve merges into main", r1.status === "done" && !!r1.merged && !before && (await repo.files()).includes("app/server.js"), [v2, r1.status]);
check("history tells the story", (r1.history ?? []).map((h) => h.text.split(/[: ]/)[0]).join(",") === "Assigned,Submitted,Review,Changes,Submitted,Review,Approved,Merged", (r1.history ?? []).map((h) => h.text));

// ------------------------------------------------------------------ the dependency unlocks; preview runs main
await until("T2 assigned", async () => (await item("T2")).briefed);
const r2 = await item("T2");
check("dependency done → next task to the free developer", r2.status === "doing" && r2.assignee === "dev-1", [r2.status, r2.assignee]);
check("next brief synced the worktree with main", (await git(repo.worktree("dev-1"), ["log", "-1", "--format=%s"])).length > 0 && (await git(repo.worktree("dev-1"), ["merge-base", "--is-ancestor", "main", "HEAD"]).then(() => true, () => false)));

const running = await until("preview running", async () => {
	const i = pm.previews.info(p.id);
	return i.status === "running" ? i : i.status === "failed" ? (console.log("    preview failed:", i.error, pm.previews.tail(p.id)), undefined) : undefined;
}, 30000);
const body1 = running ? await fetch(`http://127.0.0.1:${running.port}/`).then((r) => r.text()) : "";
check("preview starts after the merge and serves main", body1 === "hello v1\n", { body1, info: pm.previews.info(p.id) });

// T3 with no code change, T2 changes the greeting; both reviewed and merged
const reply3 = await pm.build.taskDone(p.id, await agent("dev-2"), "README only; nothing in app", true);
check("no_changes submit allowed when declared", /^Submitted T3/.test(reply3), reply3);
write("dev-1", "app/server.js", `require("http").createServer((q, s) => s.end("hello v2\\n")).listen(process.env.PORT, "127.0.0.1");\n`);
await pm.build.taskDone(p.id, await agent("dev-1"), "v2 greeting", false);
for (let i = 0; i < 2; i++) {
	const t = await until("a review", async () => Object.values((await pm.backlog(p.id)).items).find((x) => x.status === "review" && x.reviewBriefed));
	if (t) await pm.build.verdict(p.id, await agent("reviewer"), t.id, "approve", "ok");
}
await until("all done", async () => (await pm.backlog(p.id)).build?.finishedAt);
b = await pm.backlog(p.id);
check("all tasks done, build finished", Object.values(b.items).filter((i) => i.type === "task").every((t) => t.status === "done") && !!b.build?.finishedAt, Object.values(b.items).map((i) => `${i.id}:${i.status}`));
check("PBI and feature roll up to done", b.items.P1!.status === "done" && b.items.F1!.status === "done", [b.items.P1!.status, b.items.F1!.status]);

const body2 = await until("preview restarted with v2", async () => {
	const i = pm.previews.info(p.id);
	if (i.status !== "running") return undefined;
	const t = await fetch(`http://127.0.0.1:${i.port}/`).then((r) => r.text());
	return t === "hello v2\n" ? t : undefined;
}, 30000);
check("preview restarts after the next merge", body2 === "hello v2\n", pm.previews.info(p.id));
const oldPortAlive = running && pm.previews.info(p.id).port !== running.port ? await fetch(`http://127.0.0.1:${running.port}/`).then(() => true, () => false) : false;
check("the old dev server is gone after the restart", !oldPortAlive, running?.port);
check("preview logs captured", /ready on http/.test(pm.previews.tail(p.id)), pm.previews.tail(p.id));

// ------------------------------------------------------------------ pause, user stop
await pm.build.setPaused(p.id, true, "builder");
check("pause stored", (await pm.backlog(p.id)).build?.paused === true);
const lastPort = pm.previews.info(p.id).port;
await pm.previews.stop(p.id, true);
check("stop kills the dev server", !(await fetch(`http://127.0.0.1:${lastPort}/`).then(() => true, () => false)), lastPort);
check("user stop: preview off and remembered", pm.previews.info(p.id).status === "off" && pm.previews.info(p.id).stoppedByUser === true, pm.previews.info(p.id));

pm.previews.stopAll();
await Workspace.closeAll();
console.log(failed ? `\n${failed} check(s) failed` : "\nALL GOOD");
process.exit(failed ? 1 : 0);
