/**
 * Missions, for the workspace assistant.
 *
 * A mission is Outpost's heaviest feature and, until now, the only one the assistant could not touch:
 * everything about it lived behind the mission page. These tools let a chat start a team, see what is
 * waiting on the user, answer a question, message an agent and send feedback — the same operations the
 * mission page offers, with the same rules.
 *
 * What is deliberately missing: deciding a gate. Approving requirements, the design or the backlog is the
 * user's judgement on a document they read, and an assistant able to approve its own mission's requirements
 * would make the gate decorative. `mission_read` reports a pending gate instead, so the chat can point at it.
 */
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";
import { defaultModel } from "../kernel/models.ts";
import { users, type User } from "../kernel/system-db.ts";
import type { Workspace } from "../kernel/workspace.ts";
import { backlogReviewItems, pendingReviewItems, type Backlog } from "./backlog.ts";
import { GATE_DOCS, openBlocking, type GateName, type MissionMeta, type MissionState, type Question, type Review } from "./docs.ts";
import { gateItems } from "./gates.ts";

const text = (value: unknown) => ({ output: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] });
const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * Whose name a decision the assistant makes carries. A tool call has no signed-in user — the chat may be
 * shared, and the agent acts for the workspace, as it does when it creates a module — so the owner is the
 * actor. It is recorded, and shown in the mission's activity feed as such.
 */
function actor(ws: Workspace): User {
	return users.get(ws.row.ownerId) ?? { id: ws.row.ownerId, username: "owner", displayName: "owner" };
}

/** A mission by id, exact name, or a substring of the name that matches exactly one. */
async function resolveMission(ws: Workspace, ref: string): Promise<MissionMeta> {
	const want = ref.trim();
	const all = await ws.missions.list();
	const lower = want.toLowerCase();
	const exact = all.find((m) => m.id === want) ?? all.find((m) => m.name.toLowerCase() === lower);
	if (exact) return exact;
	const loose = all.filter((m) => m.name.toLowerCase().includes(lower));
	if (loose.length === 1) return loose[0]!;
	if (loose.length > 1) throw new Error(`"${ref}" matches ${plural(loose.length, "mission")}: ${loose.map((m) => `${m.id} (${m.name})`).join(", ")}. Use the id.`);
	const choices = all.map((m) => `${m.id} (${m.name})`);
	throw new Error(`No mission matches "${ref}". ${choices.length ? `Missions: ${choices.join(", ")}.` : "This workspace has no missions yet; mission_start creates one."}`);
}

/** A question by id, or by a substring of its text that matches exactly one. */
function resolveQuestion(state: MissionState, ref: string): Question {
	const questions = Object.values(state.questions);
	const want = ref.trim().toLowerCase();
	const byId = questions.find((q) => q.id.toLowerCase() === want);
	if (byId) return byId;
	const hits = questions.filter((q) => q.text.toLowerCase().includes(want));
	if (hits.length === 1) return hits[0]!;
	if (hits.length > 1) throw new Error(`"${ref}" matches ${plural(hits.length, "question")}: ${hits.map((q) => q.id).join(", ")}. Use the id.`);
	const open = questions.filter((q) => !q.answeredAt);
	throw new Error(`No question matches "${ref}". ${open.length ? `Open: ${open.map((q) => `${q.id}: ${clip(q.text, 90)}`).join(" | ")}` : "No open questions."}`);
}

/** Who the mission is waiting on, and for what — the answer to "why is nothing happening?". */
function waitingOnUser(state: MissionState, backlog: Backlog): { kind: string; detail: string }[] {
	const out: { kind: string; detail: string }[] = [];
	const blocking = openBlocking(state);
	if (blocking.length)
		out.push({
			kind: "question",
			detail: `${plural(blocking.length, "blocking question")} from ${[...new Set(blocking.map((q) => state.agents[q.agent]?.name ?? q.agent))].join(", ")} — answer with mission_answer`,
		});
	// The user settles a review item by item: say how far along it is, not just that it is waiting.
	const progressOf = (r: Review | undefined) => {
		if (!r) return "";
		const flagged = Object.values(r.reviews ?? {}).filter((v) => v.verdict === "changes").length;
		const settled = Object.values(r.reviews ?? {}).filter((v) => v.verdict === "ok").length;
		const items = gateItems(r).length;
		return items ? ` — ${settled} of ${items} looked at${flagged ? `, ${plural(flagged, "item")} flagged for changes` : ""}` : "";
	};
	for (const gate of Object.keys(GATE_DOCS) as GateName[]) {
		const g = state.gates?.[gate];
		if (g?.status === "pending") {
			const progress = progressOf(g);
			const said = g.summary ? ` (${clip(g.summary.replace(/[*#]/g, "").replace(/\s+/g, " ").trim(), 160)})` : "";
			out.push({ kind: "gate", detail: `the ${gate} document is waiting for the user's approval on the ${gate[0]!.toUpperCase()}${gate.slice(1)} tab${progress}${said}` });
		}
		if (g?.status === "changes") out.push({ kind: "gate", detail: `the user asked for changes to the ${gate} document${g.comment ? `: ${clip(g.comment, 200)}` : ""}` });
	}
	const a = backlog.approval;
	if (a.status === "pending") out.push({ kind: "backlog", detail: `the backlog is waiting for the user's approval on the Backlog tab${progressOf({ items: backlogReviewItems({ ...backlog, approval: a }), reviews: a.reviews })}${a.summary ? `: ${clip(a.summary, 160)}` : ""}` });
	if (a.status === "changes") out.push({ kind: "backlog", detail: `the user asked for backlog changes${a.comment ? `: ${clip(a.comment, 200)}` : ""}` });
	if (backlog.pendingRequest && a.status === "approved")
		out.push({
			kind: "items",
			detail: `the team asks the user to approve pending backlog items on the Backlog tab${progressOf({ items: pendingReviewItems(backlog), reviews: backlog.pendingReviews })}: ${clip(backlog.pendingRequest.summary, 160)}`,
		});
	return out;
}

/** Tasks by status, which is how progress reads at a glance. */
function taskCounts(backlog: Backlog): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const item of Object.values(backlog.items)) if (item.type === "task") counts[item.status] = (counts[item.status] ?? 0) + 1;
	return counts;
}

const stageNote: Record<MissionMeta["stage"], string> = {
	kickoff: "the Lead is forming a team",
	discovery: "requirements are being written",
	design: "the design is being written",
	planning: "the backlog is being planned",
	build: "outpost is building the backlog",
	iterate: "the app runs; the team takes feedback",
	done: "the mission is done",
};

export const MISSIONS_GUIDE = `# Missions
A **mission** is a team of agents that takes one high-level goal to a working app: requirements, a design, a backlog, then a build that merges reviewed work into \`main\`, with a live preview. It runs in the background for minutes to hours, on the mission page, and stops at **gates** where the user approves the requirements, the design and the backlog.

- Reach for a mission when the user wants something **built** — an app, a game, a tool with real code and tests — not when they want an answer, a document, or a small app a **module** already covers. A module is minutes; a mission is a team and a repository.
- \`mission_start\` creates one from a goal (the user can attach files from Files). Then stop and tell the user what is happening; don't sit and poll.
- \`mission_list\` / \`mission_read\` answer "what are my missions doing?" and "why is this one stuck?" — \`mission_read\` returns \`waitingOnYou\`, which is the whole answer.
- \`mission_answer\` answers an agent's question, \`mission_message\` talks to the Lead or one agent, \`mission_feedback\` files the user's feedback on the running app for the planner.
- **Never decide a gate.** Requirements, design and backlog approvals are the user's reading of a document; the tools don't expose them. Say which tab is waiting and let them decide.`;

export function createMissionTools(ws: Workspace) {
	const summary = (m: MissionMeta, state: MissionState, backlog: Backlog) => ({
		id: m.id,
		name: m.name,
		goal: clip(m.goal, 200),
		stage: m.stage,
		waiting: waitingOnUser(state, backlog).map((w) => w.kind),
		openQuestions: openBlocking(state).length,
		tasks: taskCounts(backlog),
		...(backlog.build?.paused ? { paused: true } : {}),
	});

	return [
		defineTool({
			name: "mission_list",
			description:
				"List this workspace's missions with their stage, what is waiting on the user, and task counts. Use it to answer \"what are my teams doing?\" before starting a new mission on the same goal.",
			parameters: Type.Object({}),
			execute: async () => {
				const missions = await ws.missions.list();
				const rows = await Promise.all(
					missions.map(async (m) => {
						const [state, backlog] = await Promise.all([ws.missions.state(m.id), ws.missions.backlog(m.id)]);
						return summary(m, state, backlog);
					}),
				);
				return text(rows);
			},
		}),
		defineTool({
			name: "mission_read",
			description:
				"One mission in detail: goal, stage, the gates and their state, open questions (with the ids mission_answer takes), the team, backlog progress, feedback, documents on `main`, recent activity and the preview. `waitingOnYou` is what blocks progress right now.",
			parameters: Type.Object({
				mission: Type.String({ description: "mission id, name, or part of the name" }),
				activity: Type.Optional(Type.Number({ description: "how many recent activity entries, default 8, max 40" })),
			}),
			execute: async (args) => {
				const meta = await resolveMission(ws, args.mission);
				const snap = await ws.missions.snapshot(meta.id);
				const state = snap.state as MissionState;
				const backlog = snap.backlog as Backlog;
				const files = await ws.missions.repo(meta.id).files().catch(() => []);
				const recent = state.activity.slice(-Math.min(40, Math.max(1, Math.trunc(args.activity ?? 8))));
				// What the team has spent so far, from the live agent watchers (the mission header shows the same numbers).
				const spend = Object.values(snap.summaries ?? {}).reduce(
					(acc, s) => ({ tokens: acc.tokens + (s.tokens ?? 0), cost: acc.cost + (s.cost ?? 0) }),
					{ tokens: 0, cost: 0 },
				);
				return text({
					id: meta.id,
					name: meta.name,
					goal: meta.goal,
					stage: meta.stage,
					stageNote: stageNote[meta.stage],
					createdBy: meta.createdBy,
					createdAt: new Date(meta.createdAt).toISOString(),
					waitingOnYou: waitingOnUser(state, backlog),
					gates: Object.fromEntries((Object.keys(GATE_DOCS) as GateName[]).map((g) => [g, state.gates?.[g]?.status ?? "not requested"])),
					questions: Object.values(state.questions)
						.filter((q) => !q.answeredAt)
						.map((q) => ({ id: q.id, agent: state.agents[q.agent]?.name ?? q.agent, blocking: openBlocking({ questions: { [q.id]: q } }).length > 0, text: clip(q.text, 400), ...(q.assumption ? { assumption: clip(q.assumption, 300) } : {}) })),
					team: state.order
						.filter((k) => !state.agents[k]?.removed)
						.map((k) => {
							const a = state.agents[k]!;
							const on = Object.values(backlog.items).find((i) => i.assignee === k && (i.status === "doing" || i.status === "review"));
							return { key: a.key, name: a.name, role: a.role, ...(on ? { task: `${on.id} ${clip(on.title, 80)} (${on.status})` } : {}) };
						}),
					backlog: {
						approval: backlog.approval.status,
						revision: backlog.revision,
						tasks: taskCounts(backlog),
						pending: Object.values(backlog.items).filter((i) => i.pending).length,
						...(backlog.build ? { build: { startedAt: backlog.build.startedAt && new Date(backlog.build.startedAt).toISOString(), finishedAt: backlog.build.finishedAt && new Date(backlog.build.finishedAt).toISOString(), paused: !!backlog.build.paused } } : {}),
					},
					...(spend.tokens || spend.cost ? { spend: { tokens: spend.tokens, cost: Math.round(spend.cost * 10_000) / 10_000 } } : {}),
					feedback: Object.values(state.feedback ?? {}).map((f) => ({ id: f.id, by: f.by, text: clip(f.text, 200), ...(f.declined ? { declined: f.declined.reason } : {}) })),
					documents: files.filter((f) => f.startsWith("docs/")).slice(0, 40),
					activity: recent.map((a) => ({ at: new Date(a.at).toISOString(), ...(a.agent ? { agent: a.agent } : {}), text: clip(a.text, 240) })),
					preview: { status: snap.preview.status, ...(snap.preview.publicUrl ? { url: snap.preview.publicUrl } : snap.preview.port ? { port: snap.preview.port } : {}), ...(snap.preview.error ? { error: clip(snap.preview.error, 300) } : {}) },
				});
			},
		}),
		defineTool({
			name: "mission_start",
			description:
				"Start a mission: a team of agents takes one goal to a working app in its own git repository, stopping at the requirements, design and backlog gates for the user. Write the goal as the user's brief — what to build, for whom, what matters. Returns immediately; the Lead forms the team and the mission runs in the background.",
			parameters: Type.Object({
				goal: Type.String({ description: "the goal, in the user's words, with the detail a team needs to start" }),
				name: Type.Optional(Type.String({ description: "short name for the mission page and its preview URL; derived from the goal when omitted" })),
				model: Type.Optional(Type.String({ description: "provider/modelId for the team's agents; default: the workspace's" })),
				files: Type.Optional(Type.Array(Type.String(), { description: "workspace file ids to attach as reference material (see the Files tools)" })),
			}),
			execute: async (args) => {
				const goal = args.goal.trim();
				if (!goal) throw new Error("mission_start needs a goal");
				const user = actor(ws);
				const [provider, ...rest] = (args.model ?? "").split("/");
				const model = args.model && rest.length ? { provider: provider!, modelId: rest.join("/") } : await defaultModel(ws.row.settings.defaultModel, users.prefs(user.id).modelPicker);
				const meta = await ws.missions.create(user, { goal, name: args.name?.trim() || undefined, model, files: (args.files ?? []).slice(0, 20) });
				return text({
					id: meta.id,
					name: meta.name,
					stage: meta.stage,
					model,
					status: `started — ${stageNote[meta.stage]}. It stops at the requirements gate; the user approves on the mission page, and mission_read says when something is waiting.`,
				});
			},
		}),
		defineTool({
			name: "mission_answer",
			description:
				"Answer an agent's question in a mission, which is how a blocked team moves again. Takes the question id from mission_read (or a distinctive part of its text). The answer is delivered to the agent that asked, as the user's answer.",
			parameters: Type.Object({
				mission: Type.String({ description: "mission id, name, or part of the name" }),
				question: Type.String({ description: "question id (e.g. Q2) or part of its text" }),
				answer: Type.String({ description: "the answer, in the user's words, with the detail the agent needs" }),
			}),
			execute: async (args) => {
				const meta = await resolveMission(ws, args.mission);
				const answer = args.answer.trim();
				if (!answer) throw new Error("mission_answer needs an answer");
				const q = resolveQuestion(await ws.missions.state(meta.id), args.question);
				if (q.answeredAt) throw new Error(`${q.id} is already ${q.resolution ?? "closed"}${q.note ? ` (${q.note})` : ""}. Open questions are in mission_read.`);
				await ws.missions.userMessage(meta.id, q.agent, actor(ws), answer, [], q.id);
				return text({ answered: q.id, agent: q.agent, question: clip(q.text, 200) });
			},
		}),
		defineTool({
			name: "mission_message",
			description:
				"Send a message to a mission's Lead (the default) or one agent by key, e.g. to steer the work or pass on something the user said. Not for answers to a question: use mission_answer so the question closes.",
			parameters: Type.Object({
				mission: Type.String({ description: "mission id, name, or part of the name" }),
				text: Type.String({ description: "what to tell them; be brief and specific" }),
				to: Type.Optional(Type.String({ description: "agent key or name, default the Lead" })),
			}),
			execute: async (args) => {
				const meta = await resolveMission(ws, args.mission);
				const message = args.text.trim();
				if (!message) throw new Error("mission_message needs text");
				const state = await ws.missions.state(meta.id);
				const team = state.order.map((k) => state.agents[k]!).filter((a) => !a.removed);
				const want = (args.to ?? "lead").trim().toLowerCase();
				const target = team.find((a) => a.key.toLowerCase() === want) ?? team.find((a) => a.name.toLowerCase() === want);
				if (!target) throw new Error(`No agent "${args.to}" in this mission. Team: ${team.map((a) => `${a.key} (${a.name})`).join(", ")}`);
				await ws.missions.userMessage(meta.id, target.key, actor(ws), message);
				return text({ sent: target.key, name: target.name });
			},
		}),
		defineTool({
			name: "mission_feedback",
			description:
				"File the user's feedback on a mission's running app (FB-n): the planner turns it into backlog items, which wait for the user's approval before anything is built. Use it for what should change in the product, not for steering an agent mid-task (mission_message).",
			parameters: Type.Object({
				mission: Type.String({ description: "mission id, name, or part of the name" }),
				text: Type.String({ description: "the feedback, as the user would write it: what is wrong or missing, and why it matters" }),
				files: Type.Optional(Type.Array(Type.String(), { description: "workspace file ids to attach, e.g. a screenshot" })),
			}),
			execute: async (args) => {
				const meta = await resolveMission(ws, args.mission);
				const fb = await ws.missions.addFeedback(meta.id, actor(ws), args.text, (args.files ?? []).slice(0, 20));
				return text({ feedback: fb.id, status: "sent to the planner; items it drafts wait for the user's approval on the Backlog tab" });
			},
		}),
	];
}
