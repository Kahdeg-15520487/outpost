import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { complete } from "@earendil-works/pi-ai/compat";
import type { AgentEventStream } from "@earendil-works/pi-durable";
import { ACTIVITY_RUNS, ActivityDoc, ApprovalsDoc, AuditDoc, ChatsDoc, FilesDoc, type ChatMeta, type ChatSummary, type RunRecord } from "./docs.ts";
import { DEMO_MODEL, defaultModel, models } from "./models.ts";
import { modules, users, type User } from "./system-db.ts";
import type { Workspace } from "./workspace.ts";

/**
 * The workspace homepage: what you were doing last time, and what happened while you were away.
 *
 * Most of it needs no new records — approvals, audit lines, files and modules already carry
 * timestamps. Chat transcripts do not (a `pi.durable` entry has no wall-clock time), so the one thing
 * this module writes is a line per finished agent run, recorded from the run's own event stream. That
 * is why the recorder follows a chat as soon as work is submitted instead of when someone opens it:
 * the runs that matter are exactly the ones that happen while nobody is looking.
 */

const WEEK = 7 * 24 * 60 * 60 * 1000;
/** How long a watcher is kept for a chat that never produces a run. */
const IDLE_MS = 30 * 60_000;
const SUMMARY_MAX_CHARS = 160;
const SUMMARY_MAX_CHATS = 4;

const watching = new WeakMap<Workspace, Map<string, AgentEventStream>>();

const clip = (text: string, n: number) => (text.length > n ? `${text.slice(0, n - 1).trimEnd()}…` : text);

/** Text of the last message a provider returned (assistant entries carry exactly one). */
function lastText(model: readonly { content: unknown }[] | undefined): string | undefined {
	const blocks = (model?.at(-1)?.content ?? []) as { type: string; text?: string }[];
	const text = blocks
		.filter((b) => b.type === "text" && b.text)
		.map((b) => b.text!)
		.join(" ")
		.trim();
	return text || undefined;
}

async function chatTitle(ws: Workspace, chatId: string): Promise<string> {
	const chats = await ws.harness.snapshot(ChatsDoc, ctx);
	return chats?.chats[chatId]?.title ?? "Chat";
}

/** Append a finished run to the workspace's activity log, newest last and bounded. */
export async function recordRun(ws: Workspace, run: RunRecord): Promise<void> {
	await ws.harness
		.commit(async (tx) => {
			const doc = await tx.doc(ActivityDoc);
			doc.runs.push(run);
			if (doc.runs.length > ACTIVITY_RUNS) doc.runs.splice(0, doc.runs.length - ACTIVITY_RUNS);
		}, ctx)
		.catch((error) => console.warn(`[ws ${ws.id}] couldn't record chat activity:`, error instanceof Error ? error.message : error));
}

/**
 * Follow one chat's runs and record a line for each when it settles. Called when work is submitted and
 * when a restarted outpost resumes unfinished runs, so the record doesn't depend on a browser watching.
 */
export async function watchRuns(ws: Workspace, chatId: string): Promise<void> {
	let map = watching.get(ws);
	if (!map) watching.set(ws, (map = new Map()));
	if (map.has(chatId)) return;
	const stream = await ws.watchEvents(chatId).catch(() => undefined);
	if (!stream) return;
	map.set(chatId, stream);

	let startedAt = Date.now();
	let messages = 0;
	let tools: Record<string, number> = {};
	let snippet: string | undefined;
	let failed: string | undefined;
	let done = false;
	const stop = () => {
		if (done) return;
		done = true;
		map!.delete(chatId);
		void stream.stop().catch(() => {});
	};
	const idle = setTimeout(stop, IDLE_MS);
	idle.unref?.();

	stream.start(async (events) => {
		let ended = false;
		for (const e of events) {
			if (e.type === "run_start") {
				startedAt = Date.now();
				messages = 0;
				tools = {};
				snippet = undefined;
				failed = undefined;
			} else if (e.type === "message_end" && e.entry.kind === "pi.assistant") {
				messages += 1;
				snippet = lastText(e.entry.model) ?? snippet;
			} else if (e.type === "tool_execution_end") {
				tools[e.toolName] = (tools[e.toolName] ?? 0) + 1;
			} else if (e.type === "task_failed") {
				failed = `${e.kind}: ${e.message}`;
			} else if (e.type === "run_end") {
				ended = true;
			}
		}
		if (!ended) return;
		clearTimeout(idle);
		const endedAt = Date.now();
		await recordRun(ws, {
			id: `${chatId}-${endedAt}`,
			chatId,
			title: await chatTitle(ws, chatId),
			at: startedAt,
			endedAt,
			messages,
			tools,
			...(snippet ? { snippet: clip(snippet, 240) } : {}),
			...(failed ? { failed } : {}),
		});
		stop();
	});
}

/** After a restart, follow the conversations outpost is resuming so their runs still land in the log. */
export async function watchRunning(ws: Workspace): Promise<void> {
	const inspection = await ws.harness.inspect(ctx).catch(() => undefined);
	for (const task of inspection?.tasks ?? []) {
		const id = (task.record as { conversationId?: unknown }).conversationId;
		if (id !== undefined && id !== null) await watchRuns(ws, String(id));
	}
}

// ------------------------------------------------------------------ reading it back

export type HomeChatActivity = {
	chatId: string;
	title: string;
	runs: number;
	messages: number;
	tools: { name: string; count: number }[];
	firstAt: number;
	lastAt: number;
	snippet?: string;
	failed?: boolean;
	/** A model-written line about it, when one has been asked for and is still current. */
	summary?: string;
};
export type HomeMissionActivity = { id: string; name: string; stage: string; open: number; changes: number; lastAt?: number };
export type Home = {
	/** Everything after `since` counts as "while you were away". */
	since: number;
	now: number;
	firstVisit: boolean;
	away: {
		chats: HomeChatActivity[];
		modules: { id: string; name: string; icon: string; at: number }[];
		missions: HomeMissionActivity[];
		approvals: { pending: number; decided: number };
		files: number;
		audit: number;
		totals: { runs: number; messages: number; tools: number };
	};
	pickup: {
		lastChat?: { id: string; title: string; at: number };
		approvals: { id: string; summary: string; airlock: string; at: number; requestedBy: string }[];
		questions: { missionId: string; mission: string; agent: string; text: string; at: number }[];
	};
	missions: { id: string; name: string; stage: string; open: number; lastAt?: number }[];
};

const toolList = (tools: Record<string, number>) => Object.entries(tools).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);

/** The homepage payload: cheap, deterministic, no model calls. */
export async function home(ws: Workspace, user: User): Promise<Home> {
	const now = Date.now();
	const seen = users.prefs(user.id).seen?.[ws.id];
	const since = typeof seen === "number" ? seen : now - WEEK;
	const [activity, chats, approvals, audit, files] = await Promise.all([
		ws.harness.snapshot(ActivityDoc, ctx),
		ws.harness.snapshot(ChatsDoc, ctx),
		ws.harness.snapshot(ApprovalsDoc, ctx),
		ws.harness.snapshot(AuditDoc, ctx),
		ws.harness.snapshot(FilesDoc, ctx),
	]);

	// Chats: group the runs of the window by chat, newest chat first.
	const byChat = new Map<string, HomeChatActivity>();
	for (const run of activity?.runs ?? []) {
		if (run.endedAt <= since) continue;
		const existing = byChat.get(run.chatId);
		if (!existing) {
			byChat.set(run.chatId, {
				chatId: run.chatId,
				title: chats?.chats[run.chatId]?.title ?? run.title,
				runs: 1,
				messages: run.messages,
				tools: toolList(run.tools),
				firstAt: run.endedAt,
				lastAt: run.endedAt,
				...(run.snippet ? { snippet: run.snippet } : {}),
				...(run.failed ? { failed: true } : {}),
			});
			continue;
		}
		existing.runs += 1;
		existing.messages += run.messages;
		existing.firstAt = Math.min(existing.firstAt, run.endedAt);
		existing.lastAt = Math.max(existing.lastAt, run.endedAt);
		if (run.snippet) existing.snippet = run.snippet;
		if (run.failed) existing.failed = true;
		const merged = new Map(existing.tools.map((t) => [t.name, t.count]));
		for (const [name, count] of Object.entries(run.tools)) merged.set(name, (merged.get(name) ?? 0) + count);
		existing.tools = [...merged].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
	}
	const chatActivity = [...byChat.values()].sort((a, b) => b.lastAt - a.lastAt);
	for (const chat of chatActivity) {
		const summary: ChatSummary | undefined = activity?.summaries?.[chat.chatId];
		if (summary && summary.upTo >= chat.lastAt) chat.summary = summary.text;
	}

	// Modules, files, approvals, audit: already timestamped where they are written.
	const touchedModules = modules
		.inWorkspace(ws.id)
		.filter((g) => g.updatedAt > since)
		.sort((a, b) => b.updatedAt - a.updatedAt)
		.slice(0, 20)
		.map((g) => ({ id: g.id, name: g.name, icon: g.icon, at: g.updatedAt }));
	const actions = Object.values(approvals?.actions ?? {});
	const pendingApprovals = actions.filter((a) => a.status === "pending").sort((a, b) => b.createdAt - a.createdAt);
	const decidedApprovals = actions.filter((a) => a.decidedAt && a.decidedAt > since).length;
	const newFiles = Object.values(files?.files ?? {}).filter((f) => f.createdAt > since).length;
	const newAudit = (audit?.lines ?? []).filter((l) => l.at > since).length;

	// Missions: their own activity feed already has timestamps and names the agent that did it.
	const missions = await ws.missions.list();
	const missionRows: HomeMissionActivity[] = [];
	const questions: Home["pickup"]["questions"] = [];
	for (const meta of missions.filter((p) => !p.archived)) {
		const state = await ws.missions.state(meta.id);
		const open = Object.values(state.questions ?? {}).filter((q) => !q.answeredAt);
		const changes = (state.activity ?? []).filter((a) => a.at > since);
		const last = (state.activity ?? []).at(-1);
		missionRows.push({ id: meta.id, name: meta.name, stage: meta.stage, open: open.length, changes: changes.length, ...(last ? { lastAt: last.at } : {}) });
		for (const q of open) questions.push({ missionId: meta.id, mission: meta.name, agent: q.agent, text: clip(q.text, 160), at: q.at });
	}
	questions.sort((a, b) => b.at - a.at);

	const lastChatMeta = Object.values(chats?.chats ?? {})
		.filter((c: ChatMeta) => !c.archived)
		.sort((a, b) => b.updatedAt - a.updatedAt)[0];

	return {
		since,
		now,
		firstVisit: typeof seen !== "number",
		away: {
			chats: chatActivity,
			modules: touchedModules,
			missions: missionRows.filter((p) => p.changes > 0),
			approvals: { pending: pendingApprovals.length, decided: decidedApprovals },
			files: newFiles,
			audit: newAudit,
			totals: {
				runs: chatActivity.reduce((n, c) => n + c.runs, 0),
				messages: chatActivity.reduce((n, c) => n + c.messages, 0),
				tools: chatActivity.reduce((n, c) => n + c.tools.reduce((m, t) => m + t.count, 0), 0),
			},
		},
		pickup: {
			...(lastChatMeta ? { lastChat: { id: lastChatMeta.id, title: lastChatMeta.title, at: lastChatMeta.updatedAt } } : {}),
			approvals: pendingApprovals.slice(0, 10).map((a) => ({ id: a.id, summary: clip(a.summary, 140), airlock: a.airlock, at: a.createdAt, requestedBy: a.requestedBy?.name ?? "Agent" })),
			questions: questions.slice(0, 10),
		},
		missions: missionRows.sort((a, b) => (b.lastAt ?? 0) - (a.lastAt ?? 0)),
	};
}

/** "You were here": the next visit measures from now. */
export function markSeen(ws: Workspace, user: User): number {
	const at = Date.now();
	const seen = { ...(users.prefs(user.id).seen ?? {}), [ws.id]: at };
	users.setPrefs(user.id, { seen });
	return at;
}

/**
 * One model-written line per chat about what happened, cached until that chat has newer runs. Only
 * run snippets and tool names are sent — never the transcript — and it's skipped entirely on the demo
 * model, which can't summarise anything.
 */
export async function summarize(ws: Workspace, user: User, chatIds: string[]): Promise<{ summaries: Record<string, string>; skipped?: string }> {
	const wanted = [...new Set(chatIds)].slice(0, SUMMARY_MAX_CHATS);
	const activity = await ws.harness.snapshot(ActivityDoc, ctx);
	const runs = activity?.runs ?? [];
	const targets = wanted
		.map((chatId) => {
			const chatRuns = runs.filter((r) => r.chatId === chatId);
			const last = chatRuns.at(-1)?.endedAt ?? 0;
			const cached = activity?.summaries?.[chatId];
			return { chatId, chatRuns, last, cached };
		})
		.filter((t) => t.chatRuns.length > 0 && (!t.cached || t.cached.upTo < t.last));
	if (!targets.length) return { summaries: {} };

	const chosen = await defaultModel(ws.row.settings.defaultModel, users.prefs(user.id).modelPicker);
	if (chosen.provider === DEMO_MODEL.provider) return { summaries: {}, skipped: "The demo model can't summarise. Add a provider key in Settings." };
	const model = models.getModel(chosen.provider, chosen.modelId);
	if (!model) return { summaries: {}, skipped: `No such model: ${chosen.provider}/${chosen.modelId}` };

	const out: Record<string, string> = {};
	const made: [string, ChatSummary][] = [];
	for (const target of targets) {
		const facts = target.chatRuns
			.slice(-6)
			.map((r) => {
				const tools = Object.entries(r.tools).map(([n, c]) => (c > 1 ? `${n}×${c}` : n)).join(", ");
				return `- ${r.messages} message(s)${tools ? `, used ${tools}` : ""}: ${r.snippet ?? "(no text)"}`;
			})
			.join("\n");
		const prompt =
			"One line, at most 20 words, past tense, describing what an AI agent did in this chat. No preamble, no markdown, no quotes.\n" +
			`Chat: "${target.chatRuns.at(-1)?.title ?? "Chat"}"\nRuns:\n${facts}`;
		try {
			const message = await complete(model as never, { messages: [{ role: "user", content: prompt }] } as never, { maxTokens: 120 });
			const text = lastText([message]);
			if (!text) continue;
			const line = clip(text.replace(/\s+/g, " ").trim(), SUMMARY_MAX_CHARS);
			out[target.chatId] = line;
			made.push([target.chatId, { upTo: target.last, text: line, at: Date.now(), model: `${chosen.provider}/${chosen.modelId}` }]);
		} catch (error) {
			return { summaries: out, skipped: error instanceof Error ? error.message : String(error) };
		}
	}
	if (made.length)
		await ws.harness.commit(async (tx) => {
			const doc = await tx.doc(ActivityDoc);
			for (const [chatId, summary] of made) doc.summaries[chatId] = summary;
		}, ctx);
	return { summaries: out };
}
