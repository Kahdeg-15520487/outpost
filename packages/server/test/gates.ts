/**
 * The two approval rules around the build, without a model:
 *  - blocking questions: the agent stops, nothing can be approved to build while one is open;
 *    non-blocking questions carry an assumption and don't block; answer, dismiss and re-flag.
 *  - feedback on the running app: stored with the version seen, sent to the planner; items drafted
 *    from it (and anything added after approval) wait as pending, outpost doesn't build them until the
 *    user approves; the user can make a PBI themselves, decline and reopen.
 * Agents are scripted: the test calls their real tools. Run: pnpm --filter @outpost/server test -- gates
 */
import { check, finish, until, passDocGates } from "./lib/harness.ts";

const { users, workspaces } = await import("../src/kernel/system-db.ts");
const { Workspace } = await import("../src/kernel/workspace.ts");
const { addItems, isPending } = await import("../src/missions/backlog.ts");

const u = users.create("gates", "password123");
const ws = await Workspace.get(workspaces.create("gates", u.id).id);
const pm = ws.missions;
pm.build.nudges = false;
const p = await pm.create(u, { goal: "Approval gates regression mission", model: { provider: "outpost-demo", modelId: "demo" } });
await passDocGates(ws, p.id);
await pm.stopAll(p.id);
for (const role of ["planner", "worker"]) await pm.addAgent(p.id, { role, brief: "wait", start: false });
const agent = async (k: string) => (await pm.state(p.id)).agents[k]!;
let taskSeq = 1000;
/** Call a mission tool as agent `key` would. */
async function tool(key: string, name: string, args: unknown) {
	const a = await agent(key);
	return pm.tools.get(name)!.execute(args, { conversationId: Number(a.conversationId), taskId: ++taskSeq } as any) as Promise<any>;
}
const out = (r: any) => (r?.output ?? []).map((o: any) => o.text).join("");
const rejects = async (fn: () => Promise<unknown>) => fn().then(() => undefined, (e: Error) => e.message);
const questions = async () => Object.values((await pm.state(p.id)).questions);

// ------------------------------------------------------------------ blocking questions
console.log("blocking questions");
const r1 = await tool("planner", "ask_user", { question: "Weekends included?" });
check("a question is blocking by default and ends the agent's turn", r1.control?.terminate === true && (await questions()).some((q) => q.text === "Weekends included?" && q.blocking === true), r1);
check("non-blocking needs an assumption", /assumption/.test((await rejects(() => tool("planner", "ask_user", { question: "Dark mode?", blocking: false }))) ?? ""));
const r2 = await tool("planner", "ask_user", { question: "Dark mode?", blocking: false, assumption: "light theme only" });
check("non-blocking question: the agent keeps going", !r2.control?.terminate && /Continue with your assumption/.test(out(r2)), out(r2));

await pm.editBacklog(p.id, (b) => addItems(b, [{ ref: "f", type: "feature", title: "Week" }, { ref: "p", type: "pbi", parent: "f", title: "See it" }, { type: "task", parent: "p", title: "Grid" }], "planner"));
await tool("planner", "backlog_request_approval", { summary: "1 task" }).then((r) => check("requesting approval warns about open blocking questions", /blocking question/.test(out(r)), out(r)));
const refused = await rejects(() => pm.approveBacklog(p.id, u));
check("backlog approval refused while a blocking question is open", /Not ready to build: 1 blocking question/.test(refused ?? ""), refused);

const blocking = (await questions()).find((q) => q.text === "Weekends included?")!;
const nonBlocking = (await questions()).find((q) => q.text === "Dark mode?")!;
await pm.setQuestionBlocking(p.id, blocking.id, false, u);
check("the user can make a question non-blocking", (await pm.state(p.id)).questions[blocking.id]!.blocking === false);
await pm.setQuestionBlocking(p.id, blocking.id, true, u);
await pm.userMessage(p.id, "planner", u, "Unrelated note");
let qs = (await pm.state(p.id)).questions;
check("a general message closes the agent's blocking questions, not its non-blocking ones", !!qs[blocking.id]!.answeredAt && !qs[nonBlocking.id]!.answeredAt, [qs[blocking.id], qs[nonBlocking.id]]);
await pm.dismissQuestion(p.id, nonBlocking.id, u, "not now");
qs = (await pm.state(p.id)).questions;
check("dismiss closes a question and records it", qs[nonBlocking.id]!.resolution === "dismissed" && qs[nonBlocking.id]!.note === "not now");

await tool("planner", "ask_user", { question: "Which week starts?" });
const q3 = (await questions()).find((q) => q.text === "Which week starts?")!;
await pm.userMessage(p.id, "planner", u, "Monday", [], q3.id);
check("answering one question closes exactly that one", (await pm.state(p.id)).questions[q3.id]!.resolution === "answered");
await pm.approveBacklog(p.id, u);
check("approval goes through once no blocking question is open", (await pm.backlog(p.id)).approval.status === "approved");
await until("T1 assigned", async () => (await pm.backlog(p.id)).items.T1?.briefed);

// ------------------------------------------------------------------ feedback
console.log("feedback");
const fb = await pm.addFeedback(p.id, u, "Show the week number in the header");
check("feedback is stored with the version of main it's about", fb.id === "FB-1" && !!fb.head, fb);
check("feedback goes to the planner", (await pm.state(p.id)).activity.some((a) => /gave feedback FB-1/.test(a.text)));

const added = await tool("planner", "backlog_add", { items: [{ ref: "p", type: "pbi", parent: "F1", title: "Week number in header", acceptance: ["Header shows W##"], feedback: "FB-1" }, { type: "task", parent: "p", title: "Render week number", feedback: "FB-1" }] });
let b = await pm.backlog(p.id);
check("items drafted from feedback are pending", b.items.P2?.pending === true && b.items.T2?.pending === true && b.items.T2?.feedback === "FB-1" && /pending/.test(out(added)), out(added));
check("unknown feedback is rejected", /No feedback FB-9/.test((await rejects(() => tool("planner", "backlog_add", { items: [{ type: "task", parent: "P1", title: "x", feedback: "FB-9" }] }))) ?? ""));
await tool("planner", "backlog_add", { items: [{ type: "task", parent: "P1", title: "Untagged addition after approval" }] });
b = await pm.backlog(p.id);
const untagged = Object.values(b.items).find((i) => i.title === "Untagged addition after approval")!;
check("anything added after approval is pending too", untagged.pending === true);

// T1 done so the developer is free; pending tasks must still not be assigned
await pm.updateItem(p.id, "T1", { status: "done" }, u);
await pm.build.run(p.id);
b = await pm.backlog(p.id);
check("outpost doesn't build pending items", b.items.T2!.status === "todo" && !b.items.T2!.assignee && isPending(b, b.items.T2!), b.items.T2);

const req = await tool("planner", "backlog_request_approval", { summary: "FB-1: week number" });
b = await pm.backlog(p.id);
check("after approval, a request covers just the pending items", b.approval.status === "approved" && b.pendingRequest?.requestedBy === "Planner" && req.control?.terminate === true, b.pendingRequest);

await tool("planner", "ask_user", { question: "W1 or Week 1?" });
check("approving pending items also waits for blocking questions", /Not ready to build/.test((await rejects(() => pm.approvePending(p.id, u, "FB-1"))) ?? ""));
const q4 = (await questions()).find((q) => q.text === "W1 or Week 1?")!;
await pm.dismissQuestion(p.id, q4.id, u);

const approved = await pm.approvePending(p.id, u, "FB-1");
b = await pm.backlog(p.id);
check("approve one feedback's items", approved.join() === "P2,T2" && !b.items.T2!.pending && untagged.pending && b.items[untagged.id]!.pending === true, approved);
await until("T2 assigned", async () => (await pm.backlog(p.id)).items.T2?.status === "doing");
check("approved feedback items get built", (await pm.backlog(p.id)).items.T2!.assignee === "dev-1");

const own = await pm.pbiFromFeedback(p.id, (await pm.addFeedback(p.id, u, "Export the week as PDF")).id, u, { title: "PDF export", acceptance: ["One page per week"] });
b = await pm.backlog(p.id);
check("the user can make a PBI from feedback; it isn't pending", b.items[own.id]?.feedback === "FB-2" && !b.items[own.id]!.pending, b.items[own.id]);

await pm.addFeedback(p.id, u, "Make it purple");
await tool("planner", "backlog_add", { items: [{ type: "pbi", parent: "F1", title: "Purple theme", feedback: "FB-3" }] });
const removed = await tool("planner", "feedback_decline", { feedback: "FB-3", reason: "Brand colours are fixed (decision 0002)" });
let st = await pm.state(p.id);
b = await pm.backlog(p.id);
check("the team can decline feedback; its pending drafts are removed", st.feedback!["FB-3"]!.declined?.by === "Planner" && !Object.values(b.items).some((i) => i.feedback === "FB-3"), out(removed));
check("declined feedback can't get new items", /declined/.test((await rejects(() => tool("planner", "backlog_add", { items: [{ type: "pbi", title: "x", feedback: "FB-3" }] }))) ?? ""));
await pm.reopenFeedback(p.id, "FB-3", u);
st = await pm.state(p.id);
check("the user can reopen declined feedback", !st.feedback!["FB-3"]!.declined);

await pm.pendingChanges(p.id, u, "Split the untagged task");
check("request changes on pending items clears the request", !(await pm.backlog(p.id)).pendingRequest);

await finish();
