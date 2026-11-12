/**
 * Quality gates around a build, without a model:
 *  - M2 document gates: the backlog can't be approved before the requirements and the design are;
 *  - story briefs: the context the planner names is inlined into the developer's brief;
 *  - tests before review and before merge (the merge result is tested when main moved);
 *  - definition of done: the reviewer confirms every item to approve;
 *  - M6: the retrospective after a build, its lessons in later briefs, and a restart (workspace
 *    closed and reopened) resuming briefs and the preview.
 * Run: pnpm --filter @outpost/server test -- quality
 */
import { check, finish, must, until } from "./lib/harness.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const { users, workspaces } = await import("../src/kernel/system-db.ts");
const { Workspace } = await import("../src/kernel/workspace.ts");
const { addItems } = await import("../src/missions/backlog.ts");
const { DEFAULT_DOD } = await import("../src/missions/checks.ts");
const { storyContext } = await import("../src/missions/story.ts");
const { MissionDoc } = await import("../src/missions/docs.ts");
const { BACKGROUND_CONTEXT: ctx } = await import("@earendil-works/chord/context");

const u = users.create("quality", "password123");
const wsId = workspaces.create("quality", u.id).id;
let ws = await Workspace.get(wsId);
let pm = ws.missions;
const sent: { to: string; text: string }[] = [];
const capture = () => {
	pm.build.nudges = false;
	const orig = pm.deliver.bind(pm);
	pm.deliver = (async (pid: string, to: string, m: any, rid?: string) => {
		sent.push({ to, text: m.text });
		return orig(pid, to, m, rid);
	}) as any;
};
capture();
const p = await pm.create(u, { goal: "Quality gates regression mission", model: { provider: "outpost-demo", modelId: "demo" } });
await pm.stopAll(p.id);
for (const role of ["worker", "worker", "reviewer"]) await pm.addAgent(p.id, { role, brief: "wait", start: false });
const repo = pm.repo(p.id);
const agent = async (k: string) => (await pm.state(p.id)).agents[k]!;
let seq = 5000;
const tool = async (key: string, name: string, args: unknown) => pm.tools.get(name)!.execute(args, { conversationId: Number((await agent(key)).conversationId), taskId: ++seq } as any) as Promise<any>;
const out = (r: any) => (r?.output ?? []).map((o: any) => o.text).join("");
const rejects = async (fn: () => Promise<unknown>) => fn().then(() => "", (e: Error) => e.message);
const item = async (id: string) => (await pm.backlog(p.id)).items[id]!;
const write = (key: string, path: string, c: string) => {
	const f = join(repo.worktree(key), path);
	mkdirSync(join(f, ".."), { recursive: true });
	writeFileSync(f, c);
};
const all = DEFAULT_DOD.map((_, i) => ({ item: i + 1, met: true }));
const lastTo = (key: string) => [...sent].reverse().find((m) => m.to === key)?.text ?? "";

// ------------------------------------------------------------------ M2 gates
console.log("document gates");
await pm.editBacklog(p.id, (b) => addItems(b, [{ ref: "f", type: "feature", title: "Core" }, { ref: "p", type: "pbi", parent: "f", title: "Basics", acceptance: ["works"] }, { type: "task", parent: "p", title: "x" }], "planner"));
await pm.editBacklog(p.id, (b) => void (b.approval = { status: "pending", requestedBy: "Planner", requestedAt: Date.now() }));
check("the backlog can't be approved before requirements and design", /Approve the requirements and the design first/.test(await rejects(() => pm.approveBacklog(p.id, u))));
check("review needs the document on main", /isn't on main yet/.test(await rejects(() => tool("lead", "request_review", { gate: "requirements", summary: "s" }))));
await repo.writeMain("docs/requirements.md", "# Requirements\n\nThings.\n", "requirements");
await repo.writeMain("docs/design.md", "# Design\n\n## Overview\nShort.\n\n## Data model\nTasks are rows; marker-DM-42.\n\n### Indexes\nby owner\n\n## API\nREST.\n", "design");
check("design review waits for approved requirements", /requirements approved first/.test(await rejects(() => tool("lead", "request_review", { gate: "design", summary: "s" }))));
const rr = await tool("lead", "request_review", { gate: "requirements", summary: "3 stories" });
let st = await pm.state(p.id);
check("request_review: pending, ends the lead's turn", st.gates?.requirements?.status === "pending" && rr.control?.terminate === true && !!st.gates.requirements.commit);

// ------------------------------------------------------------------ reviewing a document in pieces
console.log("reviewing in pieces");
const { gateItems, changesFromItems, withGateItems } = await import("../src/missions/gates.ts");
const { MissionDoc: MD } = await import("../src/missions/docs.ts");
const setGate = (gate: "requirements" | "design", g: any) =>
	ws.harness.commit(async (tx: any) => {
		const doc = await tx.doc(MD, p.id, null);
		doc.gates = { ...doc.gates, [gate]: { status: "pending", summary: "s", requestedBy: "Lead", requestedAt: Date.now(), ...g } };
	}, ctx);
await setGate("requirements", { summary: ["Two things:", "", "- **Scoring**: three darts, best of five", "- **Voice**: no recording, typed only"].join("\n") });
const derived = gateItems((await pm.state(p.id)).gates?.requirements);
check("an older request's bullets become the items of its review", derived.length === 2 && derived[0]!.title === "Scoring" && derived[0]!.detail === "three darts, best of five" && derived[1]!.id === "p2", derived);
check("the browser is sent those items with the state", (withGateItems(await pm.state(p.id))!.gates!.requirements!).items?.length === 2);
await pm.reviewGateItem(p.id, "requirements", u, "p1", "changes", "six darts, not five");
let gate = (await pm.state(p.id)).gates!.requirements!;
check("a flagged item is stored with its note and who said it", gate.reviews?.p1?.verdict === "changes" && gate.reviews.p1.note === "six darts, not five" && gate.reviews.p1.by === u.displayName, gate.reviews);
check("the derived items are kept, so the id resolves next time", gate.items?.length === 2);
await pm.reviewGateItem(p.id, "requirements", u, "p2", "ok");
gate = (await pm.state(p.id)).gates!.requirements!;
check("an item can be marked fine", gate.reviews?.p2?.verdict === "ok", gate.reviews);
check("approving is refused while an item is flagged", /You asked for changes on 1 item \(Scoring\)/.test(await rejects(() => pm.approveGate(p.id, "requirements", u))));
check("the change request names every item not marked as fine", changesFromItems(gate) === "- **Scoring**: six darts, not five", changesFromItems(gate));
// p2 is marked fine, p1 flagged: un-ticking p2 puts it in the request too, with no note of its own.
const { openItems } = await import("../src/missions/gates.ts");
await pm.reviewGateItem(p.id, "requirements", u, "p2", "clear");
check("an item left untouched is sent as well", changesFromItems((await pm.state(p.id)).gates?.requirements) === "- **Scoring**: six darts, not five\n- **Voice**", changesFromItems((await pm.state(p.id)).gates?.requirements));
check("…and the count says how many the button will name", openItems((await pm.state(p.id)).gates?.requirements) === 2);
await pm.reviewGateItem(p.id, "requirements", u, "p2", "ok");
check("an unknown item is not a review", /No item p9/.test(await rejects(() => pm.reviewGateItem(p.id, "requirements", u, "p9", "ok"))));
await pm.reviewGateItem(p.id, "requirements", u, "p1", "clear");
gate = (await pm.state(p.id)).gates!.requirements!;
check("a verdict can be taken back", !gate.reviews?.p1, gate.reviews);
check("with nothing flagged, approving goes through", await pm.approveGate(p.id, "requirements", u).then(() => true, () => false));
check("a decided review is not a checklist any more", /aren't waiting for approval/.test(await rejects(() => pm.reviewGateItem(p.id, "requirements", u, "p2", "ok"))));

// a new request is a new checklist
await tool("lead", "request_review", { gate: "design", summary: "rest + rows", items: [{ title: "Rest shape" }, { title: "Rows", detail: "one row per task" }] });
gate = (await pm.state(p.id)).gates!.design!;
check("items come with the request, in order, with ids", gate.items?.length === 2 && gate.items[0]!.id === "i1" && gate.items[1]!.title === "Rows" && gate.items[1]!.detail === "one row per task", gate.items);
check("a new request starts with no verdicts", !Object.keys(gate.reviews ?? {}).length, gate.reviews);
await pm.reviewGateItem(p.id, "design", u, "i1", "changes", "three columns");
await tool("lead", "request_review", { gate: "design", summary: "rest + columns", items: [{ title: "Shape" }] });
gate = (await pm.state(p.id)).gates!.design!;
check("re-requesting replaces the items and forgets the old verdicts", gate.items?.length === 1 && gate.items[0]!.title === "Shape" && !Object.keys(gate.reviews ?? {}).length, gate);
check("requesting without items keeps the checklist off", !(await (async () => {
	await setGate("requirements", { status: "approved" });
	await tool("lead", "request_review", { gate: "requirements", summary: "still prose only, no bullets" });
	return (await pm.state(p.id)).gates!.requirements!.items;
})()), "items should be absent");
check("a changes request with no comment complains when nothing is flagged", /Say what should change, or flag an item/.test(await rejects(() => pm.gateChanges(p.id, "requirements", u, ""))));
await tool("lead", "request_review", { gate: "requirements", summary: "again", items: [{ title: "Scope" }, { title: "Non-goals" }] });
await pm.reviewGateItem(p.id, "requirements", u, "i2", "changes", "name the excluded formats");
await pm.gateChanges(p.id, "requirements", u, "");
check("the team is told which items to change", /\*\*Non-goals\*\*: name the excluded formats/.test(lastTo("lead")), lastTo("lead"));
// back to the plain path the rest of the suite expects
await setGate("requirements", { status: "pending", summary: "with non-goals" });
await pm.gateChanges(p.id, "requirements", u, "Add non-goals");
check("request changes reaches the lead", (await pm.state(p.id)).gates?.requirements?.status === "changes" && /requested changes to the requirements/.test(lastTo("lead")));
await tool("lead", "request_review", { gate: "requirements", summary: "with non-goals" });
await pm.approveGate(p.id, "requirements", u);
check("approve requirements: stage design, lead told", (await pm.meta(p.id)).stage === "design" && /approved the requirements/.test(lastTo("lead")));
await tool("lead", "request_review", { gate: "design", summary: "rest + rows" });
await pm.approveGate(p.id, "design", u);
check("approve design: stage planning", (await pm.meta(p.id)).stage === "planning");
await pm.removeItem(p.id, "F1", u);

// a mission from before gates isn't held to them
const legacy = await pm.create(u, { goal: "Legacy mission without gates", model: { provider: "outpost-demo", modelId: "demo" } });
await pm.stopAll(legacy.id);
await ws.harness.commit(async (tx) => void delete ((await tx.doc(MissionDoc, legacy.id, null)) as any).gates, ctx);
await pm.editBacklog(legacy.id, (b) => addItems(b, [{ type: "task", title: "y" }], "planner"));
check("older missions (no gates) approve as before", (await rejects(() => pm.approveBacklog(legacy.id, u))) === "");
await pm.archive(legacy.id);

// ------------------------------------------------------------------ story briefs + checks + DoD
console.log("story briefs");
await repo.writeMain("docs/decisions/0001-use-rows.md", "# 0001. Store tasks as rows\n- Status: accepted\n", "adr");
await repo.writeMain(".outpost/mission.json", JSON.stringify({ test: "node check.js", dev: { command: "node server.js" }, definitionOfDone: ["The changelog mentions it"] }), "run config");
await repo.writeMain("app/check.js", `const fs=require("fs");const ok=fs.existsSync("ok.txt")&&fs.readFileSync("ok.txt","utf8").trim()==="ok";if(fs.existsSync("flag.txt")&&fs.existsSync("t3.txt")){console.log("flag and t3 clash");process.exit(1)}console.log(ok?"all good":"ok.txt is not ok");process.exit(ok?0:1);\n`, "check");
await repo.writeMain("app/ok.txt", "ok\n", "ok");
await repo.writeMain("app/server.js", `require("http").createServer((q,s)=>s.end("up")).listen(process.env.PORT,"127.0.0.1");\n`, "server");
await pm.editBacklog(p.id, (b) =>
	addItems(
		b,
		[
			{ ref: "f", type: "feature", title: "Board" },
			{ ref: "p", type: "pbi", parent: "f", title: "Rows", acceptance: ["rows persist"] },
			{ ref: "t", type: "task", parent: "p", title: "Row store", area: "app/store", context: ["docs/design.md#Data model", "docs/decisions/0001-use-rows.md", "docs/nowhere.md"] },
			{ type: "task", parent: "p", title: "Flag", area: "app/flag" },
			{ type: "task", parent: "p", title: "T3 file", area: "app/t3" },
		],
		"planner",
	),
);
// ------------------------------------------------------------------ reviewing the backlog in pieces
// "Approve the backlog" was one click on a plan nobody could read at once. It is a checklist now, the way the
// documents are: one item per feature, and the plan is still approved once.
console.log("reviewing the backlog");
const { backlogReviewItems } = await import("../src/missions/backlog.ts");
const reviewItems = backlogReviewItems(await pm.backlog(p.id));
check("the features become the items of the backlog review", reviewItems.length === 1 && reviewItems[0]!.title.includes("Board") && /P\d/.test(reviewItems[0]!.detail ?? "") && /3 tasks/.test(reviewItems[0]!.detail ?? ""), reviewItems);
const boardFeature = reviewItems[0]!.id;
await pm.reviewBacklogItem(p.id, u, boardFeature, "changes", "two tasks, not three");
let bl = await pm.backlog(p.id);
check("a flagged feature is stored on the request with its note", bl.approval.reviews?.[boardFeature]?.verdict === "changes" && bl.approval.reviews[boardFeature]!.note === "two tasks, not three", bl.approval.reviews);
check("the derived items are kept, so the id resolves next time", bl.approval.items?.length === 1);
check("a review of the plan bumps no revision (it is not a change to the plan)", bl.revision === (await pm.backlog(p.id)).revision);
check("approving is refused while an item is flagged, and it names the feature", new RegExp(`You asked for changes on 1 item \\(F\\d+ Board\\)`).test(await rejects(() => pm.approveBacklog(p.id, u))));
await pm.requestBacklogChanges(p.id, u, "");
check("requesting changes with nothing typed sends the flagged feature", /\*\*F\d+ Board\*\*: two tasks, not three/.test(lastTo("lead")), lastTo("lead"));
await tool("lead", "backlog_request_approval", { summary: "the same plan" });
bl = await pm.backlog(p.id);
check("a new request starts with no verdicts", bl.approval.status === "pending" && !Object.keys(bl.approval.reviews ?? {}).length, bl.approval);
check("an item the request does not have is not a review", /No item F99/.test(await rejects(() => pm.reviewBacklogItem(p.id, u, "F99", "ok"))));

await pm.approveBacklog(p.id, u);
const [tStore, tFlag, tT3] = Object.values((await pm.backlog(p.id)).items)
	.filter((i) => i.type === "task" && i.title !== "x")
	.sort((a, b) => a.order - b.order)
	.map((i) => i.id);
must("tasks created", tStore && tFlag && tT3);
await until("first assignments", async () => (await item(tStore!)).briefed && (await item(tFlag!)).briefed);
const storeDev = (await item(tStore!)).assignee!;
const brief = [...sent].reverse().find((m) => m.to === storeDev && m.text.includes(tStore!))?.text ?? "";
check("brief inlines the named design section", brief.includes("docs/design.md § Data model") && brief.includes("marker-DM-42") && brief.includes("### Indexes") && !brief.includes("REST."), brief.slice(0, 400));
check("brief includes the named decision record", brief.includes("Store tasks as rows"));
check("brief lists the decision index and flags missing refs", brief.includes("Decision records") && brief.includes("Not found on main: docs/nowhere.md"));

console.log("tests before review");
write(storeDev, "app/ok.txt", "broken\n");
write(storeDev, "app/store.js", "module.exports = {};\n");
await pm.build.taskDone(p.id, await agent(storeDev), "store", false);
await until("checks fail", async () => (await item(tStore!)).checks?.status === "failed");
let t = await item(tStore!);
check("failing tests send it straight back to the developer", t.status === "doing" && !t.reviewer && /tests fail/i.test(lastTo(storeDev)) && /ok\.txt is not ok/.test(lastTo(storeDev)), [t.status, t.checks]);
write(storeDev, "app/ok.txt", "ok\n");
await pm.build.taskDone(p.id, await agent(storeDev), "store, fixed", false);
await until("review", async () => (await item(tStore!)).reviewBriefed && (await item(tStore!)).reviewRound === 1);
t = await item(tStore!);
check("passing tests route it to the reviewer", t.status === "review" && t.reviewer === "reviewer" && t.checks?.status === "passed" && t.checks.stage === "submit", t.checks);
const reviewBrief = lastTo("reviewer");
check("review brief: checks result + numbered definition of done (with the mission's item)", /test suite passed/.test(reviewBrief) && /Definition of done/.test(reviewBrief) && reviewBrief.includes(`${DEFAULT_DOD.length + 1}. The changelog mentions it`), reviewBrief.slice(-600));

console.log("definition of done");
const reviewerRec = await agent("reviewer");
const dodAll = [...all, { item: DEFAULT_DOD.length + 1, met: true }];
check("approve without the checklist is refused", /confirm every definition-of-done item/.test(await rejects(() => pm.build.verdict(p.id, reviewerRec, tStore!, "approve", ""))));
check("an unmet item is refused (use changes)", /Not met: 2\./.test(await rejects(() => pm.build.verdict(p.id, reviewerRec, tStore!, "approve", "", dodAll.map((c) => (c.item === 2 ? { ...c, met: false } : c))))));
const merged = await pm.build.verdict(p.id, (await agent("reviewer"))!, tStore!, "approve", "solid", dodAll);
t = await item(tStore!);
check("full checklist approves and merges (main unchanged: no retest)", /merged into main/.test(merged) && t.status === "done" && t.dod?.items.length === DEFAULT_DOD.length + 1, merged);

console.log("merge result tested when main moved");
await until("flag + t3 assigned", async () => (await item(tFlag!)).briefed && (await item(tT3!)).briefed);
const flagDev = (await item(tFlag!)).assignee!;
const t3Dev = (await item(tT3!)).assignee!;
write(flagDev, "app/flag.txt", "1\n");
await pm.build.taskDone(p.id, await agent(flagDev), "flag", false);
write(t3Dev, "app/t3.txt", "1\n");
await pm.build.taskDone(p.id, await agent(t3Dev), "t3", false);
await until("flag in review", async () => (await item(tFlag!)).reviewBriefed && (await item(tFlag!)).reviewer === "reviewer");
await pm.build.verdict(p.id, (await agent("reviewer"))!, tFlag!, "approve", "", dodAll);
check("first of two parallel tasks merges", (await item(tFlag!)).status === "done");
await until("t3 in review", async () => (await item(tT3!)).reviewBriefed && (await item(tT3!)).reviewer === "reviewer");
const v = await pm.build.verdict(p.id, (await agent("reviewer"))!, tT3!, "approve", "", dodAll);
check("main moved: approval tests the merge result first", /tests the merge result/.test(v), v);
await until("t3 back", async () => (await item(tT3!)).status === "doing", 30000);
t = await item(tT3!);
check("tests failing on the merge result send it back; main untouched", t.checks?.stage === "merge" && t.checks.status === "failed" && /flag and t3 clash/.test(lastTo(t3Dev)) && !(await repo.files()).includes("app/t3.txt"), t.checks);
write(t3Dev, "app/t3.txt", "1\n");
await repo.sync(t3Dev);
writeFileSync(join(repo.worktree(t3Dev), "app/check.js"), `const fs=require("fs");console.log("relaxed");process.exit(fs.readFileSync("ok.txt","utf8").trim()==="ok"?0:1);\n`);
await pm.build.taskDone(p.id, await agent(t3Dev), "t3 with relaxed check", false);
await until("t3 review 2", async () => (await item(tT3!)).reviewBriefed && (await item(tT3!)).reviewer === "reviewer");
await repo.writeMain("docs/notes.md", "main moves again\n", "move main");
const v2 = await pm.build.verdict(p.id, (await agent("reviewer"))!, tT3!, "approve", "", dodAll);
await until("t3 merged", async () => (await item(tT3!)).status === "done", 30000);
t = await item(tT3!);
check("a passing merge result moves main", /tests the merge result/.test(v2) && t.status === "done" && t.checks?.stage === "merge" && t.checks.status === "passed" && (await repo.files()).includes("app/t3.txt"), [v2, t.checks]);

console.log("retrospective");
const b = await until("retrospective written", async () => ((await pm.backlog(p.id)).build?.retro ? pm.backlog(p.id) : undefined), 20000);
const retroPath = b?.build?.retro;
const retro = retroPath ? (await repo.read(retroPath))?.text ?? "" : "";
check("outpost writes the retrospective's facts when the build finishes", /^docs\/retrospectives\/0001-\d{4}-\d\d-\d\d\.md$/.test(retroPath ?? "") && /3 tasks\*\* merged/.test(retro) && /test failures: \*\*2\*\*/.test(retro) && /_Waiting for the lead._/.test(retro), retro.slice(0, 600));
check("the lead is asked for lessons", /retro_notes/.test(lastTo("lead")));
await tool("lead", "retro_notes", { went_well: ["parallel tasks"], to_improve: ["flaky checks"], actions: ["Run node check.js before task_done"] });
const retro2 = (await repo.read(retroPath!))?.text ?? "";
check("retro_notes adds the lessons", /### Actions\n- Run node check\.js before task_done/.test(retro2) && !/Waiting for the lead/.test(retro2));
const lessons = await storyContext(repo, await pm.backlog(p.id), { id: "T99", type: "task", title: "next", status: "todo", deps: [], order: 0, createdBy: "x", updatedAt: 0 });
check("later briefs carry the retrospective's actions", /Lessons from the last retrospective/.test(lessons) && /Run node check\.js before task_done/.test(lessons));

console.log("restart");
await pm.previews.start(p.id);
must("preview running before the restart", pm.previews.info(p.id).status === "running", pm.previews.info(p.id));
await tool("lead", "backlog_add", { items: [{ type: "task", parent: (await item(tStore!)).parent, title: "After restart" }] });
const tAfter = Object.values((await pm.backlog(p.id)).items).find((i) => i.title === "After restart")!.id;
await pm.approvePending(p.id, u);
await until("assigned", async () => (await item(tAfter)).status === "doing");
// Simulate a crash between the assignment commit and the brief: the brief is marked unsent.
await pm.editBacklog(p.id, (b) => void (b.items[tAfter]!.briefed = false));
const sentBefore = sent.length;
await Workspace.close(wsId);
ws = await Workspace.get(wsId);
pm = ws.missions;
capture();
check("after a restart the unsent brief goes out", !!(await until("re-briefed", async () => (await item(tAfter)).briefed, 20000)) && sent.slice(sentBefore).some((m) => m.text.includes(tAfter)));
check("after a restart the preview comes back", !!(await until("preview back", () => pm.previews.info(p.id).status === "running", 30000)), pm.previews.info(p.id));

await finish();
