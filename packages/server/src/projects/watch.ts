import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { watchEvents, type AgentEventStream, type Harness } from "@earendil-works/pi-durable";

/** What an agent tile shows; condensed server-side so a page with a dozen agents stays cheap. */
export type AgentSummary = {
	busy: boolean;
	status: "idle" | "thinking" | "writing" | "tool" | "error";
	/** What it's doing right now: "$ npm test", "edit src/app.ts", "→ lead". */
	activity?: string;
	/** The end of what it last said. */
	tail: string;
	tokens: number;
	cost: number;
	queued: number;
	error?: string;
	updatedAt: number;
};

const TAIL = 320;

function textOf(content: any[] | undefined): string {
	return (content ?? [])
		.filter((c) => c?.type === "text")
		.map((c) => c.text ?? "")
		.join("\n")
		.trim();
}

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

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function describeTool(name: string, args: any): string {
	const a = args ?? {};
	switch (name) {
		case "bash":
			return `$ ${clip(String(a.command ?? "").split("\n")[0] ?? "", 90)}`;
		case "read":
		case "write":
		case "edit":
			return `${name} ${clip(String(a.path ?? ""), 80)}`;
		case "message":
			return `→ ${a.to ?? "?"}`;
		case "ask_user":
			return "asking you a question";
		case "team_add":
			return `adding ${a.role ?? "an agent"}`;
		case "publish":
			return "publishing to main";
		case "sync_main":
			return "syncing with main";
		case "backlog_add":
			return `adding ${Array.isArray(a.items) ? a.items.length : ""} backlog item${Array.isArray(a.items) && a.items.length === 1 ? "" : "s"}`;
		case "backlog_update":
			return `updating ${a.id ?? "backlog"}${a.status ? ` → ${a.status}` : ""}`;
		case "backlog_remove":
			return `removing ${a.id ?? "an item"}`;
		case "backlog_list":
			return "reading the backlog";
		case "backlog_request_approval":
			return "asking you to approve the backlog";
		default:
			return name.replace(/_/g, " ");
	}
}

function usageOf(u: any) {
	const models = Object.values(u?.models ?? {}) as any[];
	return {
		tokens: models.reduce((a, m) => a + (m?.input ?? 0) + (m?.output ?? 0) + (m?.cacheRead ?? 0), 0),
		cost: models.reduce((a, m) => a + (m?.cost?.total ?? 0), 0),
	};
}

/** Follows one agent conversation and calls `onChange` (throttled) with its summary. */
export class AgentWatcher {
	summary: AgentSummary = { busy: false, status: "idle", tail: "", tokens: 0, cost: 0, queued: 0, updatedAt: Date.now() };
	#stream?: AgentEventStream;
	#live: any[] = [];
	#tools = new Map<string, string>();
	#timer?: ReturnType<typeof setTimeout>;
	#stopped = false;

	constructor(
		readonly harness: Harness,
		readonly conversationId: string,
		readonly onChange: (s: AgentSummary) => void,
	) {}

	async start() {
		const stream = await watchEvents(this.harness, Number(this.conversationId) as any, ctx);
		if (this.#stopped) return void stream.stop();
		this.#stream = stream;
		this.#apply([stream.snapshot]);
		this.#flush();
		stream.start(async (events) => this.#apply(events));
	}

	stop() {
		this.#stopped = true;
		if (this.#timer) clearTimeout(this.#timer);
		void this.#stream?.stop();
	}

	#apply(events: readonly any[]) {
		const s = { ...this.summary };
		for (const e of events) {
			switch (e.type) {
				case "snapshot": {
					s.busy = !!e.run;
					Object.assign(s, usageOf(e.usage));
					s.queued = (e.inbox ?? []).length;
					const lastAssistant = [...(e.entries ?? [])].reverse().find((x: any) => x.kind === "pi.assistant" && textOf(x.model?.[0]?.content));
					s.tail = clip(textOf(lastAssistant?.model?.[0]?.content).slice(-TAIL), TAIL);
					this.#live = e.generation?.message?.content ?? [];
					this.#tools.clear();
					for (const t of e.tools ?? []) if (t.status !== "done") this.#tools.set(t.callId, describeTool(t.name, t.arguments));
					break;
				}
				case "run_start":
					s.busy = true;
					s.error = undefined;
					break;
				case "run_end":
					s.busy = false;
					this.#live = [];
					this.#tools.clear();
					break;
				case "message_start":
					if (e.message?.role === "assistant") this.#live = e.message.content ?? [];
					break;
				case "message_update":
					for (const ch of e.changes ?? []) this.#live = ch.type === "message" ? (ch.message.content ?? []) : applyChange(this.#live, ch);
					break;
				case "message_end":
					if (e.entry?.kind === "pi.assistant") {
						const t = textOf(e.entry.model?.[0]?.content);
						if (t) s.tail = t.slice(-TAIL);
						if (e.entry.model?.[0]?.errorMessage) s.error = e.entry.model[0].errorMessage;
						this.#live = [];
					}
					break;
				case "tool_execution_start":
					this.#tools.set(e.toolCallId, describeTool(e.toolName, e.args));
					break;
				case "tool_execution_end":
					this.#tools.delete(e.toolCallId);
					break;
				case "usage_changed":
					Object.assign(s, usageOf(e.usage));
					break;
				case "inbox_update":
					s.queued = (e.items ?? []).length;
					break;
				case "task_failed":
					s.error = e.message;
					break;
				case "submission":
					if (e.record?.status === "unanswered" && e.record.reason !== "aborted") s.error = `${e.record.reason}${e.record.detail ? `: ${e.record.detail}` : ""}`;
					break;
			}
		}
		// Derive what the tile says from the live message and running tools.
		const last = this.#live.filter(Boolean).at(-1);
		const liveText = textOf(this.#live);
		if (liveText) s.tail = liveText.slice(-TAIL);
		if (!s.busy) {
			s.status = s.error ? "error" : "idle";
			s.activity = undefined;
		} else if (this.#tools.size) {
			s.status = "tool";
			s.activity = [...this.#tools.values()].at(-1);
		} else if (last?.type === "toolCall") {
			s.status = "tool";
			s.activity = describeTool(last.name, last.arguments);
		} else if (last?.type === "text") {
			s.status = "writing";
			s.activity = undefined;
		} else {
			s.status = "thinking";
			s.activity = undefined;
		}
		s.updatedAt = Date.now();
		this.summary = s;
		this.#schedule();
	}

	#schedule() {
		if (this.#timer) return;
		this.#timer = setTimeout(() => this.#flush(), 250);
	}

	#flush() {
		this.#timer = undefined;
		if (!this.#stopped) this.onChange(this.summary);
	}
}
