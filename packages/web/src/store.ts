import { useEffect, useReducer, useState, useSyncExternalStore } from "react";
import { api, type AgentSummary, type ConnectionInfo, type ConnectionProposal, type Backlog, type Module, type PreviewInfo, type MissionMeta, type MissionState, type WorkspaceDocs } from "./api";
import { socket } from "./socket";
import { connectivity } from "./net";

// ------------------------------------------------------------------ routing (hash)

export type Route =
	| { page: "home" }
	| { page: "home"; ws: string }
	| { page: "chat"; ws: string; chat?: string; module?: string; /** module shown full width, chat hidden */ focus?: boolean }
	| { page: "blueprints"; ws: string }
	| { page: "settings"; ws: string }
	| { page: "connections"; ws: string }
	| { page: "files"; ws: string }
	| { page: "mission"; ws: string; mission: string; tab?: string }
	| { page: "module"; module: string }
	| { page: "link"; token: string };

function parse(): Route {
	const [path, query] = location.hash.replace(/^#/, "").split("?");
	const parts = (path ?? "").split("/").filter(Boolean);
	const q = new URLSearchParams(query);
	if (parts[0] === "w" && parts[1]) {
		if (parts[2] === "blueprints") return { page: "blueprints", ws: parts[1] };
		if (parts[2] === "settings") return { page: "settings", ws: parts[1] };
		if (parts[2] === "connections") return { page: "connections", ws: parts[1] };
		if (parts[2] === "files") return { page: "files", ws: parts[1] };
		if (parts[2] === "missions" && parts[3]) return { page: "mission", ws: parts[1], mission: parts[3], tab: q.get("tab") ?? undefined };
		// A module with no chat beside it (opened from the sidebar): show it in an empty chat.
		if (parts[2] === "modules" && parts[3]) return { page: "chat", ws: parts[1], module: parts[3], focus: q.get("focus") === "1" };
		if (parts[2] === "c") return { page: "chat", ws: parts[1], chat: parts[3], module: q.get("module") ?? undefined, focus: !!q.get("module") && q.get("focus") === "1" };
		// The workspace itself: its homepage.
		return { page: "home", ws: parts[1] };
	}
	if (parts[0] === "modules" && parts[1]) return { page: "module", module: parts[1] };
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
/** `focus`: show the module full width with the chat hidden (opening it yourself); the agent opening one keeps the chat visible. */
export const chatHref = (ws: string, chat?: string, module?: string, focus?: boolean) =>
	chat ? `#/w/${ws}/c/${chat}${module ? `?module=${module}${focus ? "&focus=1" : ""}` : ""}` : module ? `#/w/${ws}/modules/${module}${focus ? "?focus=1" : ""}` : homeHref(ws);
/** The workspace homepage: what you were doing last time and what happened while you were away. */
export const homeHref = (ws: string) => `#/w/${ws}`;

// ------------------------------------------------------------------ workspace docs

const emptyDocs: WorkspaceDocs = { chats: { chats: {} }, grants: { grants: {}, requests: {} }, approvals: { actions: {} }, audit: { lines: [] }, mailbox: { sent: [] }, files: { files: {} } };

export function useWorkspace(ws: string | undefined) {
	const [docs, setDocs] = useState<WorkspaceDocs>(emptyDocs);
	const [modules, setModules] = useState<Module[]>([]);
	const [archived, setArchived] = useState<Module[]>([]);
	const [modulesTick, setTick] = useState(0);
	const [missions, setMissions] = useState<MissionMeta[]>([]);
	const [missionsTick, setMissionsTick] = useState(0);
	useEffect(() => {
		if (!ws) return;
		setDocs(emptyDocs);
		const off = socket.on((m) => {
			if (m.ws !== ws) return;
			if (m.t === "ws.snapshot") setDocs({ chats: m.chats, grants: m.grants, approvals: m.approvals, audit: m.audit, mailbox: m.mailbox, files: m.files });
			else if (m.t === "ws.doc") setDocs((d) => ({ ...d, [m.name]: m.value }));
			else if (m.t === "ws.modules") setTick((t) => t + 1);
			else if (m.t === "ws.missions") setMissionsTick((t) => t + 1);
		});
		const unsub = socket.subscribe(`ws:${ws}`, { kind: "ws", ws });
		return () => {
			off();
			unsub();
		};
	}, [ws]);
	const reconnects = useReconnects();
	useEffect(() => {
		if (!ws) return;
		let live = true;
		api.get(`/api/w/${ws}/modules`).then((r) => live && (setModules(r.modules), setArchived(r.archived ?? []))).catch(() => {});
		return () => {
			live = false;
		};
	}, [ws, modulesTick, reconnects]);
	useEffect(() => {
		if (!ws) return;
		let live = true;
		api.get(`/api/w/${ws}/missions`).then((r) => live && setMissions(r.missions)).catch(() => {});
		return () => {
			live = false;
		};
	}, [ws, missionsTick, reconnects]);
	return { docs, modules, archived, missions };
}

export const missionHref = (ws: string, mission: string, tab?: string) => `#/w/${ws}/missions/${mission}${tab ? `?tab=${tab}` : ""}`;

// ------------------------------------------------------------------ missions (agent teams)

export type MissionLive = { mission?: MissionMeta; state: MissionState; backlog: Backlog; summaries: Record<string, AgentSummary>; head: string; repoTick: number; preview: PreviewInfo };
const emptyMission: MissionLive = { state: { agents: {}, order: [], questions: {}, activity: [] }, backlog: { items: {}, seq: { feature: 0, pbi: 0, task: 0 }, approval: { status: "draft" }, revision: 0 }, summaries: {}, head: "", repoTick: 0, preview: { status: "off", logSeq: 0 } };

/** A mission's team, agent summaries and repo head, live over the socket. */
export function useMission(ws: string, mission: string): MissionLive {
	const [live, setLive] = useState<MissionLive>(emptyMission);
	useEffect(() => {
		setLive(emptyMission);
		const off = socket.on((m) => {
			if (m.ws !== ws) return;
			if (m.t === "mission.snapshot" && m.missionId === mission) setLive((l) => ({ mission: m.mission, state: m.state, backlog: m.backlog ?? l.backlog, summaries: m.summaries, head: m.head, repoTick: l.repoTick + 1, preview: m.preview ?? l.preview }));
			else if (m.mission !== mission) return;
			else if (m.t === "mission.state") setLive((l) => ({ ...l, state: m.state }));
			else if (m.t === "mission.backlog") setLive((l) => ({ ...l, backlog: m.backlog }));
			else if (m.t === "mission.agent") setLive((l) => ({ ...l, summaries: { ...l.summaries, [m.key]: m.summary } }));
			else if (m.t === "mission.repo") setLive((l) => ({ ...l, head: m.head ?? l.head, repoTick: l.repoTick + 1 }));
			else if (m.t === "mission.preview") setLive((l) => ({ ...l, preview: m.preview }));
			else if (m.t === "mission.preview.log") setLive((l) => ({ ...l, preview: { ...l.preview, logSeq: m.seq } }));
			else if (m.t === "mission.meta") api.get(`/api/w/${ws}/missions/${mission}`).then((r) => setLive((l) => ({ ...l, mission: r.mission })));
		});
		const unsub = socket.subscribe(`mission:${ws}:${mission}`, { kind: "mission", ws, mission });
		return () => {
			off();
			unsub();
		};
	}, [ws, mission]);
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
	/** module ids opened by tools during this session (not on history replay) */
	opened?: { module: string; seq: number };
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
				if (details?.openModule) next.opened = { module: details.openModule, seq: ++openSeq };
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

/** Changes whenever the backend becomes reachable again: depend on it to refetch what a failed request left empty. */
export function useReconnects() {
	return useSyncExternalStore(
		connectivity.subscribe,
		() => connectivity.get().reconnects,
	);
}

export function useSocketStatus() {
	return useSyncExternalStore(
		(l) => socket.onStatus(l),
		() => socket.connected,
	);
}

/** True once the server serves a newer web app than this tab runs (it was updated while the tab stayed open). */
export function useAppUpdated() {
	return useSyncExternalStore(
		(l) => socket.onStatus(l),
		() => socket.updated,
	);
}

export { timeAgo, timeTitle } from "./time";

/** The workspace's connections (MCP servers, REST APIs), refetched when the server says they changed. */
export function useConnections(ws: string | undefined) {
	const [list, setList] = useState<ConnectionInfo[]>([]);
	const [proposals, setProposals] = useState<ConnectionProposal[]>([]);
	const [tick, setTick] = useState(0);
	useEffect(() => {
		if (!ws) return;
		return socket.on((m) => {
			if (m.ws === ws && m.t === "ws.connections") setTick((t) => t + 1);
		});
	}, [ws]);
	useEffect(() => {
		if (!ws) return;
		let live = true;
		api.get(`/api/w/${ws}/connections`).then(
			(r) => {
				if (!live) return;
				setList(r.connections);
				setProposals(r.proposals ?? []);
			},
			() => {},
		);
		return () => {
			live = false;
		};
	}, [ws, tick]);
	return { connections: list, proposals, reload: () => setTick((t) => t + 1) };
}
