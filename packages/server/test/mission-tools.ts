/**
 * The workspace assistant's mission tools — the seam between a chat and a running team.
 *  - mission_start, mission_list, mission_read: start a team and read what it is doing and what is
 *    waiting on the user (the `waitingOnYou` answer).
 *  - mission_answer, mission_message, mission_feedback: unblock and steer without the mission page.
 *  - and the boundary: no tool decides a gate, because approving requirements, design or the backlog is
 *    the user reading a document.
 * Agents are scripted: this test calls the team's real tools and the assistant's real tools, no model.
 * Run: pnpm --filter @outpost/server test -- mission-tools
 */
import { check, finish } from "./lib/harness.ts";

const { users, workspaces } = await import("../src/kernel/system-db.ts");
const { Workspace } = await import("../src/kernel/workspace.ts");
const { MissionDoc } = await import("../src/missions/docs.ts");
const { BacklogDoc } = await import("../src/missions/backlog.ts");
const { BACKGROUND_CONTEXT } = await import("@earendil-works/chord/context");
const { createMissionTools } = await import("../src/missions/tools.ts");

const u = users.create("mtools", "password123");
const ws = await Workspace.get(workspaces.create("mtools", u.id).id);
const pm = ws.missions;
pm.build.nudges = false;

// ------------------------------------------------------------------ the assistant's tools
const tools = new Map(createMissionTools(ws).map((t) => [t.name, t]));
const call = async (name: string, args: Record<string, unknown> = {}) => {
	const t = tools.get(name);
	if (!t) throw new Error(`No tool ${name}`);
	return (await (t as any).execute(args, { conversationId: 1, taskId: 1, callId: `t:${name}` })) as any;
};
const out = (r: any) => (r?.output ?? []).map((o: any) => o.text).join("");
const json = (r: any) => JSON.parse(out(r));
const rejects = async (fn: () => Promise<unknown>) => fn().then(() => undefined, (e: Error) => e.message);
/** A mission tool called as the given agent would — to make questions and backlog state. */
let taskSeq = 10_000;
const asAgent = async (missionId: string, key: string, name: string, args: unknown = {}) => {
	const a = (await pm.state(missionId)).agents[key]!;
	return (await pm.tools.get(name)!.execute(args, { conversationId: Number(a.conversationId), taskId: ++taskSeq } as any)) as any;
};
const gates = async (missionId: string, status: "pending" | "changes" | "approved") =>
	ws.harness.commit(async (tx: any) => {
		const st = await tx.doc(MissionDoc, missionId, null);
		st.gates = { requirements: { status, summary: "Three sections, one open question" }, design: { status: "approved" } };
	}, BACKGROUND_CONTEXT);

console.log("mission_start");
const started = json(await call("mission_start", { goal: "A tide-pool field guide for the school group", model: "outpost-demo/demo" }));
check("mission_start returns the new mission, named from the goal", /^ms_/.test(started.id) && /tide-pool/i.test(started.name), started);
check("mission_start says where it stops", /requirements gate/.test(started.status ?? ""), started.status);
const id = started.id as string;
await pm.stopAll(id);
check("no goal is refused", /needs a goal/.test((await rejects(() => call("mission_start", { goal: "   " }))) ?? ""));
check("a model is resolved when none is given", /^ms_/.test(json(await call("mission_start", { goal: "Second mission, default model" })).id));
for (const m of await pm.list()) if (m.id !== id) await pm.stopAll(m.id);

console.log("mission_list / mission_read");
const list = json(await call("mission_list"));
const row = list.find((m: any) => m.id === id);
check("mission_list shows the mission with its stage and task counts", row?.stage === "kickoff" && !!row.tasks, row);
check("mission_list shows an unwaiting mission as having nothing waiting", Array.isArray(row?.waiting) && row.waiting.length === 0, row?.waiting);
const read = json(await call("mission_read", { mission: "tide-pool" }));
check("a mission reads by part of its name", read.id === id && /tide-pool/i.test(read.name), read);
check("it reports goal, stage and creation", /tide-pool/.test(read.goal) && read.stage === "kickoff" && !!read.createdAt, read.goal);
check("it lists the team with the Lead", read.team.some((a: any) => a.key === "lead" && a.role === "lead"), read.team);
check("gates start as not requested", read.gates.requirements === "not requested", read.gates);
check("an unknown mission names the ones that exist", /No mission matches "nope"/.test((await rejects(() => call("mission_read", { mission: "nope" }))) ?? ""));
const sibling = json(await call("mission_start", { goal: "A second look at the same pools", name: "tide-pool research", model: "outpost-demo/demo" }));
await pm.stopAll(sibling.id);
check("an ambiguous name asks for the id instead of guessing", /matches 2 missions: ms_/.test((await rejects(() => call("mission_read", { mission: "tide-pool" }))) ?? ""));

console.log("what is waiting on the user");
await gates(id, "pending");
let waiting = json(await call("mission_read", { mission: id })).waitingOnYou as any[];
check("a pending gate is reported, with the tab that decides it", waiting.some((w) => w.kind === "gate" && /Requirements tab/.test(w.detail)), waiting);
check("mission_list flags it without reading the whole mission", json(await call("mission_list")).find((m: any) => m.id === id)?.waiting.includes("gate"));
await gates(id, "changes");
waiting = json(await call("mission_read", { mission: id })).waitingOnYou as any[];
check("changes requested on a document are reported back", waiting.some((w) => /asked for changes to the requirements/.test(w.detail)), waiting);
await ws.harness.commit(async (tx: any) => {
	const b = await tx.doc(BacklogDoc, id, null);
	b.approval = { status: "pending", summary: "12 tasks, 3 parallel" };
}, BACKGROUND_CONTEXT);
waiting = json(await call("mission_read", { mission: id })).waitingOnYou as any[];
check("a backlog awaiting approval says so, with the summary", waiting.some((w) => w.kind === "backlog" && /12 tasks/.test(w.detail)), waiting);

console.log("questions: read, then answer");
await pm.addAgent(id, { role: "planner", brief: "wait", start: false });
await asAgent(id, "planner", "ask_user", { question: "Which region do the tide pools cover?", blocking: true });
const asked = json(await call("mission_read", { mission: id }));
const q = (asked.questions as any[])[0];
check("the question is visible with an id and blocking flag", !!q?.id && q.blocking === true && /region/.test(q.text), asked.questions);
check("a blocking question is what the mission is waiting on", (asked.waitingOnYou as any[]).some((w) => /blocking question from Planner/.test(w.detail) && /mission_answer/.test(w.detail)), asked.waitingOnYou);

const answered = json(await call("mission_answer", { mission: id, question: q.id, answer: "The Firth of Forth, both shores." }));
check("mission_answer reports the question it closed", answered.answered === q.id && answered.agent === "planner", answered);
let st = await pm.state(id);
check("the question is marked answered, by the owner", !!st.questions[q.id]!.answeredAt && st.questions[q.id]!.resolution === "answered" && st.questions[q.id]!.resolvedBy === u.displayName, st.questions[q.id]);
check("answering closes it, so nothing is waiting for that question", !json(await call("mission_read", { mission: id })).questions.length);
check("answering it twice is refused with the reason", new RegExp(`${q.id} is already answered`).test((await rejects(() => call("mission_answer", { mission: id, question: q.id, answer: "again" }))) ?? ""));

await asAgent(id, "planner", "ask_user", { question: "Should the guide include a printable version?", blocking: false, assumption: "printable CSS only" });
const printable = Object.values((await pm.state(id)).questions).find((x) => /printable/.test(x.text))!;
const byText = json(await call("mission_answer", { mission: id, question: "printable version", answer: "Yes, a one-page PDF per zone." }));
check("a question can be answered by part of its text", byText.answered === printable.id, byText);
check("the second question is closed too", !!(await pm.state(id)).questions[printable.id]!.answeredAt);
check("an unmatched question lists the open ones", /No question matches "zzz"/.test((await rejects(() => call("mission_answer", { mission: id, question: "zzz", answer: "no" }))) ?? ""));

console.log("messages and feedback");
check("a message goes to the Lead by default", json(await call("mission_message", { mission: id, text: "The sponsor wants it by Friday." })).sent === "lead");
st = await pm.state(id);
check("it lands in the mission's activity as the user's", st.activity.some((a) => a.kind === "user" && /Friday/.test(a.text)), st.activity.slice(-3));
check("a named agent can be messaged", json(await call("mission_message", { mission: id, text: "Keep the warm palette.", to: "Planner" })).sent === "planner");
check("an unknown agent names the team", /No agent "nobody" in this mission. Team: lead/.test((await rejects(() => call("mission_message", { mission: id, text: "x", to: "nobody" }))) ?? ""));

const fb = json(await call("mission_feedback", { mission: id, text: "The zone list should sort by depth, not name." }));
check("feedback is filed as FB-n and sent to the planner", fb.feedback === "FB-1" && /Backlog tab/.test(fb.status), fb);
check("it shows up when the mission is read", (json(await call("mission_read", { mission: id })).feedback as any[]).some((f) => f.id === "FB-1" && /sort by depth/.test(f.text)));

console.log("what the team knows about the rest of the workspace");
const { existingAppsSection } = await import("../src/missions/context.ts");
const before = existingAppsSection(ws);
const contacts = await ws.createModule({ name: "Contacts", icon: "👥", ownerId: u.id });
const sectionText = existingAppsSection(ws)!;
check("the team is told which apps the workspace already has", /“Contacts”/.test(sectionText), sectionText);
check("and that they are not part of its repository", /\*\*not\*\* part of your repository/.test(sectionText) && /cannot install one into `app\/`/.test(sectionText), sectionText);
check("with the instruction to name the companion instead of rebuilding it", /docs\/design\.md/.test(sectionText) && /instead of|rather than/.test(sectionText), sectionText);
check("a workspace with apps says more than it did before", (before ?? "") !== sectionText, { before });
await ws.deleteModule(contacts.id);

console.log("spend");
const summary = (tokens: number, cost: number) => ({ busy: false, status: "idle" as const, tail: "", tokens, cost, queued: 0, updatedAt: Date.now() });
const real = pm.summaries.get(id);
pm.summaries.set(id, { lead: summary(1200, 0.0345), planner: summary(800, 0.01) });
check("mission_read reports what the team spent", JSON.stringify((json(await call("mission_read", { mission: id })).spend)) === JSON.stringify({ tokens: 2000, cost: 0.0445 }), json(await call("mission_read", { mission: id })).spend);
if (real) pm.summaries.set(id, real);
else pm.summaries.delete(id);

console.log("the gate boundary");
const toolNames = [...tools.keys()];
check("no assistant tool decides a gate", !toolNames.some((n) => /approve|reject|gate/.test(n)), toolNames);
await gates(id, "pending");
check("mission_read points at the tab instead", /Requirements tab/.test(JSON.stringify(json(await call("mission_read", { mission: id })).waitingOnYou)));

await finish();
