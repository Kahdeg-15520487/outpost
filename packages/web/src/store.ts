import { useEffect, useReducer, useState, useSyncExternalStore } from "react";
import { api, type AgentSummary, type Gadget, type ProjectMeta, type ProjectState, type WorkspaceDocs } from "./api";
import { socket } from "./socket";

// ------------------------------------------------------------------ routing (hash)

export type Route =
	| { page: "home" }
	| { page: "chat"; ws: string; chat?: string; gadget?: string; /** gadget shown full width, chat hidden */ focus?: boolean }
	| { page: "blueprints"; ws: string }
	| { page: "settings"; ws: string }
	| { page: "files"; ws: string }
	| { page: "project"; ws: string; project: string; tab?: string }
	| { page: "gadget"; gadget: string }
	| { page: "link"; token: string };

function parse(): Route {
	const [path, query] = location.hash.replace(/^#/, "").split("?");
	const parts = (path ?? "").split("/").filter(Boolean);
	const q = new URLSearchParams(query);
	if (parts[0] === "w" && parts[1]) {
		if (parts[2] === "blueprints") return { page: "blueprints", ws: parts[1] };
		if (parts[2] === "settings") return { page: "settings", ws: parts[1] };
		if (parts[2] === "files") return { page: "files", ws: parts[1] };
		if (parts[2] === "p" && parts[3]) return { page: "project", ws: parts[1], project: parts[3], tab: q.get("tab") ?? undefined };
		return { page: "chat", ws: parts[1], chat: parts[2] === "c" ? parts[3] : undefined, gadget: q.get("g") ?? undefined, focus: !!q.get("g") && q.get("focus") === "1" };
	}
	if (parts[0] === "g" && parts[1]) return { page: "gadget", gadget: parts[1] };
	if (parts[0] === "link" && parts[1]) return { page: "link", token: parts[1] };
	return { page: "home" };
}

let route = parse();
const routeListeners = new Set<() => void>();
addEventListener("hashchange", () => {
	route = parse();
	for (const l of routeListeners) l();
});
export const useRoute = () =>
	useSyncExternalStore(
		(l) => (routeListeners.add(l), () => routeListeners.delete(l)),
		() => route,
	);
export const navigate = (hash: string) => {
	if (location.hash !== hash) location.hash = hash;
};
/** `focus`: show the gadget full width with the chat hidden (opening it yourself); the agent opening one keeps the chat visible. */
export const chatHref = (ws: string, chat?: string, gadget?: string, focus?: boolean) => `#/w/${ws}${chat ? `/c/${chat}` : ""}${gadget ? `?g=${gadget}${focus ? "&focus=1" : ""}` : ""}`;

// ------------------------------------------------------------------ workspace docs

const emptyDocs: WorkspaceDocs = { chats: { chats: {} }, grants: { grants: {}, requests: {} }, approvals: { actions: {} }, audit: { lines: [] }, mailbox: { sent: [] }, files: { files: {} } };

export function useWorkspace(ws: string | undefined) {
	const [docs, setDocs] = useState<WorkspaceDocs>(emptyDocs);
	const [gadgets, setGadgets] = useState<Gadget[]>([]);
	const [gadgetsTick, setTick] = useState(0);
	const [projects, setProjects] = useState<ProjectMeta[]>([]);
	const [projectsTick, setProjectsTick] = useState(0);
	useEffect(() => {
		if (!ws) return;
		setDocs(emptyDocs);
		const off = socket.on((m) => {
			if (m.ws !== ws) return;
			if (m.t === "ws.snapshot") setDocs({ chats: m.chats, grants: m.grants, approvals: m.approvals, audit: m.audit, mailbox: m.mailbox, files: m.files });
			else if (m.t === "ws.doc") setDocs((d) => ({ ...d, [m.name]: m.value }));
			else if (m.t === "ws.gadgets") setTick((t) => t + 1);
			else if (m.t === "ws.projects") setProjectsTick((t) => t + 1);
		});
		const unsub = socket.subscribe(`ws:${ws}`, { kind: "ws", ws });
		return () => {
			off();
			unsub();
		};
	}, [ws]);
	useEffect(() => {
		if (!ws) return;
		let live = true;
		api.get(`/api/w/${ws}/gadgets`).then((r) => live && setGadgets(r.gadgets)).catch(() => {});
		return () => {
			live = false;
		};
	}, [ws, gadgetsTick]);
	useEffect(() => {
		if (!ws) return;
		let live = true;
		api.get(`/api/w/${ws}/projects`).then((r) => live && setProjects(r.projects)).catch(() => {});
		return () => {
			live = false;
		};
	}, [ws, projectsTick]);
	return { docs, gadgets, projects };
}

export const projectHref = (ws: string, project: string, tab?: string) => `#/w/${ws}/p/${project}${tab ? `?tab=${tab}` : ""}`;

// ------------------------------------------------------------------ projects (agent teams)

export type ProjectLive = { project?: ProjectMeta; state: ProjectState; summaries: Record<string, AgentSummary>; head: string; repoTick: number };
const emptyProject: ProjectLive = { state: { agents: {}, order: [], questions: {}, activity: [] }, summaries: {}, head: "", repoTick: 0 };

/** A project's team, agent summaries and repo head, live over the socket. */
export function useProject(ws: string, project: string): ProjectLive {
	const [live, setLive] = useState<ProjectLive>(emptyProject);
	useEffect(() => {
		setLive(emptyProject);
		const off = socket.on((m) => {
			if (m.ws !== ws) return;
			if (m.t === "project.snapshot" && m.projectId === project) setLive((l) => ({ project: m.project, state: m.state, summaries: m.summaries, head: m.head, repoTick: l.repoTick + 1 }));
			else if (m.project !== project) return;
			else if (m.t === "project.state") setLive((l) => ({ ...l, state: m.state }));
			else if (m.t === "project.agent") setLive((l) => ({ ...l, summaries: { ...l.summaries, [m.key]: m.summary } }));
			else if (m.t === "project.repo") setLive((l) => ({ ...l, head: m.head ?? l.head, repoTick: l.repoTick + 1 }));
			else if (m.t === "project.meta") api.get(`/api/w/${ws}/projects/${project}`).then((r) => setLive((l) => ({ ...l, project: r.project })));
		});
		const unsub = socket.subscribe(`project:${ws}:${project}`, { kind: "project", ws, project });
		return () => {
			off();
			unsub();
		};
	}, [ws, project]);
	return live;
}

// ------------------------------------------------------------------ chat (agent events)

export type Entry = { id: number; kind: string; model?: any[]; data?: any; byTaskId?: number };
export type LiveTool = {
	id: string;
	name: string;
	args?: any;
	output: string;
	details?: any;
	status: "running" | "done";
	isError?: boolean;
	parent?: string;
};
export type ChatState = {
	ready: boolean;
	entries: Entry[];
	live?: { role: "assistant"; content: any[] };
	tools: Record<string, LiveTool>;
	busy: boolean;
	inbox: { id: number; mode: string }[];
	agent: any;
	usage: any;
	retry?: { at: number; error: string };
	error?: string;
	compacting: boolean;
	/** gadget ids opened by tools during this session (not on history replay) */
	opened?: { gadget: string; seq: number };
};

const initialChat: ChatState = { ready: false, entries: [], tools: {}, busy: false, inbox: [], agent: {}, usage: {}, compacting: false };

function applyChange(content: any[], ch: any) {
	const c = [...content];
	switch (ch.type) {
		case "text_start":
		case "thinking_start":
		case "toolcall_start":
		case "block":
			c[ch.contentIndex] = ch.block;
			break;
		case "text_delta": {
			const b = c[ch.contentIndex] ?? { type: "text", text: "" };
			c[ch.contentIndex] = { ...b, text: (b.text ?? "") + ch.delta };
			break;
		}
		case "thinking_delta": {
			const b = c[ch.contentIndex] ?? { type: "thinking", thinking: "" };
			c[ch.contentIndex] = { ...b, thinking: (b.thinking ?? "") + ch.delta };
			break;
		}
	}
	return c;
}

let openSeq = 0;
function reduce(s: ChatState, events: any[]): ChatState {
	let next = { ...s };
	for (const e of events) {
		switch (e.type) {
			case "snapshot": {
				const tools: Record<string, LiveTool> = {};
				for (const t of e.tools ?? []) tools[t.callId] = { id: t.callId, name: t.name, output: t.output ?? "", details: t.details, status: t.status === "done" ? "done" : "running" };
				for (const t of e.nestedTools ?? []) tools[t.callId] = { id: t.callId, name: t.name, args: t.arguments, output: t.output ?? "", details: t.details, status: t.status === "done" ? "done" : "running", parent: t.parentCallId, isError: t.summary?.isError };
				next = {
					...initialChat,
					ready: true,
					entries: [...e.entries],
					live: e.generation?.message ? { role: "assistant", content: e.generation.message.content ?? [] } : undefined,
					tools,
					busy: !!e.run,
					inbox: e.inbox ?? [],
					agent: e.agent ?? {},
					usage: e.usage ?? {},
					retry: e.generation?.retry,
					compacting: (e.compactions ?? []).length > 0,
				};
				break;
			}
			case "run_start":
				next.busy = true;
				next.error = undefined;
				break;
			case "run_end":
				next.busy = false;
				next.live = undefined;
				break;
			case "message_start":
				if (e.message?.role === "assistant") next.live = { role: "assistant", content: e.message.content ?? [] };
				break;
			case "message_update":
				if (next.live) {
					let content = next.live.content;
					for (const ch of e.changes) {
						if (ch.type === "message") content = ch.message.content;
						else content = applyChange(content, ch);
					}
					next.live = { ...next.live, content };
				}
				next.retry = undefined;
				break;
			case "message_end":
			case "entry_appended":
				if (!next.entries.some((x) => x.id === e.entry.id)) next.entries = [...next.entries, e.entry];
				if (e.type === "message_end" && e.entry.kind === "pi.assistant") next.live = undefined;
				break;
			case "tool_execution_start":
				next.tools = { ...next.tools, [e.toolCallId]: { id: e.toolCallId, name: e.toolName, args: e.args, output: "", status: "running", parent: e.parentToolCallId } };
				break;
			case "tool_execution_update": {
				const t = next.tools[e.toolCallId];
				if (!t) break;
				let output = t.output;
				if (e.output && "set" in e.output) output = e.output.set;
				else if (e.output) output = output.slice(e.output.trimStart ?? 0) + (e.output.append ?? "");
				next.tools = { ...next.tools, [e.toolCallId]: { ...t, output, details: e.details ?? t.details } };
				break;
			}
			case "tool_execution_end": {
				const t = next.tools[e.toolCallId] ?? { id: e.toolCallId, name: e.toolName, output: "", status: "running" as const };
				const isError = e.result?.isError ?? e.entry?.model?.[0]?.isError;
				const details = e.result?.details ?? e.entry?.model?.[0]?.details ?? t.details;
				next.tools = { ...next.tools, [e.toolCallId]: { ...t, status: "done", isError, details } };
				if (e.entry && !next.entries.some((x) => x.id === e.entry.id)) next.entries = [...next.entries, e.entry];
				if (details?.openGadget) next.opened = { gadget: details.openGadget, seq: ++openSeq };
				break;
			}
			case "inbox_update":
				next.inbox = e.items;
				break;
			case "agent_changed":
				next.agent = e.agent;
				break;
			case "usage_changed":
				next.usage = e.usage;
				break;
			case "auto_retry_start":
				next.retry = { at: e.at, error: e.errorMessage };
				break;
			case "auto_retry_end":
				next.retry = undefined;
				break;
			case "task_failed":
				next.error = e.message;
				break;
			case "submission":
				if (e.record?.status === "unanswered" && e.record.reason !== "aborted") next.error = `${e.record.reason}${e.record.detail ? `: ${e.record.detail}` : ""}`;
				break;
			case "compaction_start":
				next.compacting = true;
				break;
			case "compaction_end":
				next.compacting = false;
				if (e.error) next.error = `Compaction failed: ${e.error}`;
				break;
		}
	}
	return next;
}

export function useChat(ws: string, chat: string | undefined) {
	const [state, dispatch] = useReducer((s: ChatState, a: { reset?: true; events?: any[] }) => (a.reset ? initialChat : reduce(s, a.events ?? [])), initialChat);
	useEffect(() => {
		if (!chat) return;
		dispatch({ reset: true });
		const off = socket.on((m) => {
			if (m.t === "chat.events" && m.ws === ws && String(m.chat) === String(chat)) dispatch({ events: m.events });
		});
		const unsub = socket.subscribe(`chat:${ws}:${chat}`, { kind: "chat", ws, chat });
		return () => {
			off();
			unsub();
		};
	}, [ws, chat]);
	return state;
}

export function useSocketStatus() {
	return useSyncExternalStore(
		(l) => socket.onStatus(l),
		() => socket.connected,
	);
}

export const timeAgo = (t: number) => {
	const s = (Date.now() - t) / 1000;
	if (s < 45) return "just now";
	if (s < 3600) return `${Math.round(s / 60)}m`;
	if (s < 86400) return `${Math.round(s / 3600)}h`;
	return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
};
