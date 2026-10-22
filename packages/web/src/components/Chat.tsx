import { useEffect, useMemo, useRef, useState } from "react";
import { api, type ChatMeta, type ModelInfo, type ModelRef, type Workspace, type WorkspaceDocs } from "../api";
import { chatHref, navigate, useChat, type ChatState, type Entry, type LiveTool } from "../store";
import { Markdown } from "./bits";
import { ResourcesDialog } from "./Resources";

const SUGGESTIONS = [
	{ k: "🎞️", t: "Make slides", d: "for my Q3 planning meeting", p: "Make slides for my Q3 planning meeting: goals, risks, timeline, asks." },
	{ k: "✅", t: "Shared task list", d: "for the team offsite", p: "Make a todo list for the team offsite and add the obvious tasks." },
	{ k: "⭕", t: "Play a game", d: "tic tac toe against the agent", p: "Make a tic tac toe game. I'll be X and you be O — join the game." },
	{ k: "🖍️", t: "Whiteboard", d: "draw together in real time", p: "Make a collaborative whiteboard." },
	{ k: "📊", t: "Build an app", d: "anything — the agent writes it", p: "Build a habit tracker gadget with a weekly grid and streak counts." },
	{ k: "🐙", t: "Use a Gatekeeper", d: "issues dashboard for a repo", p: "Make an issue dashboard for the GitHub repo earendil-works/pi. Request access to it first." },
];

export function ChatView(props: {
	ws: Workspace;
	chatId?: string;
	chats: Record<string, ChatMeta>;
	models: ModelInfo[];
	defaultModel?: ModelRef;
	grants: WorkspaceDocs["grants"];
	openGadget?: string;
	onNewChat: () => void;
}) {
	const { ws, chatId } = props;
	const state = useChat(ws.id, chatId);
	const meta = chatId ? props.chats[chatId] : undefined;
	const [resources, setResources] = useState(false);
	/** Model picked before the chat exists; the chat is created with it on first send. */
	const [pendingModel, setPendingModel] = useState<ModelRef>();
	const scroller = useRef<HTMLDivElement>(null);
	const stick = useRef(true);
	const canEdit = ws.role !== "viewer";

	// Open gadgets that tools touch, as they happen.
	const lastOpened = useRef(0);
	useEffect(() => {
		if (state.opened && state.opened.seq !== lastOpened.current) {
			lastOpened.current = state.opened.seq;
			if (props.openGadget !== state.opened.gadget) navigate(chatHref(ws.id, chatId, state.opened.gadget));
		}
	}, [state.opened]);

	useEffect(() => {
		const el = scroller.current;
		if (el && stick.current) el.scrollTop = el.scrollHeight;
	});

	const send = async (content: string, mode?: "steer") => {
		let id = chatId;
		if (!id) {
			id = (await api.post(`/api/w/${ws.id}/chats`, { model: pendingModel })).id as string;
			navigate(chatHref(ws.id, id, props.openGadget));
		}
		stick.current = true;
		await api.post(`/api/w/${ws.id}/chats/${id}/messages`, { content, mode });
	};

	const chatGrants = Object.values(props.grants.grants).filter((g) => g.holder.kind === "conversation" && g.holder.id === chatId);
	const empty = !chatId || (state.ready && state.entries.filter((e) => e.kind === "os.user" || e.kind === "pi.user").length === 0);
	const model: ModelRef | undefined = chatId ? state.agent?.model : (pendingModel ?? props.defaultModel);
	const chooseModel = (m: ModelRef) => (chatId ? api.patch(`/api/w/${ws.id}/chats/${chatId}`, { model: m }) : setPendingModel(m));

	return (
		<div className="main">
			<div className="topbar">
				<h2
					contentEditable={!!chatId && canEdit}
					suppressContentEditableWarning
					onBlur={(e) => chatId && e.currentTarget.textContent && api.patch(`/api/w/${ws.id}/chats/${chatId}`, { title: e.currentTarget.textContent })}
					onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), e.currentTarget.blur())}
				>
					{meta?.title ?? "New chat"}
				</h2>
				<span className="grow" />
				{chatId && (
					<button className="btn small" onClick={() => setResources(true)} title="Introduce this chat's agent to external resources">
						🔑 Resources{chatGrants.length ? ` · ${chatGrants.length}` : ""}
					</button>
				)}
				{chatId && <Usage usage={state.usage} />}
				{chatId && canEdit && (
					<button className="btn ghost small" title="Archive chat" onClick={() => confirm("Archive this chat?") && api.del(`/api/w/${ws.id}/chats/${chatId}`).then(() => navigate(chatHref(ws.id)))}>
						Archive
					</button>
				)}
			</div>
			<div
				className="transcript"
				ref={scroller}
				onScroll={(e) => {
					const el = e.currentTarget;
					stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
				}}
			>
				<div className="transcript-inner">
					{empty ? (
						<div className="hero">
							<h1>
								What should we <em>make</em>?
							</h1>
							<p>
								Ask for anything. The agent works in code, builds sandboxed apps (<b>gadgets</b>) you can share, and reaches company systems only through <b>Gatekeepers</b> you introduce — with
								side effects queued for your approval.
							</p>
							{canEdit && (
								<div className="suggestions">
									{SUGGESTIONS.map((s) => (
										<button key={s.t} className="suggestion" onClick={() => send(s.p)}>
											<div className="k">{s.k}</div>
											<div className="t">{s.t}</div>
											<div className="d">{s.d}</div>
										</button>
									))}
								</div>
							)}
						</div>
					) : (
						<Transcript state={state} wsId={ws.id} chatId={chatId!} />
					)}
				</div>
			</div>
			{canEdit && <Composer chatId={chatId} state={state} models={props.models} model={model} onModel={chooseModel} onAbort={() => api.post(`/api/w/${ws.id}/chats/${chatId}/abort`)} onSend={send} />}
			{resources && chatId && <ResourcesDialog ws={ws} holder={{ kind: "conversation", id: chatId }} grants={props.grants} onClose={() => setResources(false)} />}
		</div>
	);
}

function Usage({ usage }: { usage: any }) {
	const models = Object.values(usage?.models ?? {}) as any[];
	const cost = models.reduce((a, u) => a + (u?.cost?.total ?? 0), 0);
	const tokens = models.reduce((a, u) => a + (u?.input ?? 0) + (u?.output ?? 0) + (u?.cacheRead ?? 0), 0);
	if (!tokens) return null;
	return (
		<span className="pill" title="Tokens and cost for this chat">
			{tokens > 1000 ? `${(tokens / 1000).toFixed(1)}k` : tokens} tok{cost > 0 ? ` · $${cost.toFixed(cost < 0.1 ? 3 : 2)}` : ""}
		</span>
	);
}

// ------------------------------------------------------------------ transcript

function textOf(content: any): string {
	if (typeof content === "string") return content;
	return (content ?? []).map((c: any) => (c.type === "text" ? c.text : c.type === "image" ? "[image]" : "")).join("");
}

function Transcript({ state, wsId, chatId }: { state: ChatState; wsId: string; chatId: string }) {
	const results = useMemo(() => {
		const map = new Map<string, any>();
		for (const e of state.entries) if (e.kind === "pi.tool-result") for (const m of e.model ?? []) map.set(m.toolCallId, m);
		return map;
	}, [state.entries]);
	const nestedByParent = useMemo(() => {
		const map = new Map<string, LiveTool[]>();
		for (const t of Object.values(state.tools)) if (t.parent) map.set(t.parent, [...(map.get(t.parent) ?? []), t]);
		return map;
	}, [state.tools]);

	return (
		<>
			{state.entries.map((e) => (
				<EntryView key={e.id} entry={e} results={results} tools={state.tools} nested={nestedByParent} wsId={wsId} chatId={chatId} />
			))}
			{state.live && <AssistantView content={state.live.content} results={results} tools={state.tools} nested={nestedByParent} streaming wsId={wsId} chatId={chatId} />}
			{state.error && <div className="notice" style={{ color: "var(--bad)" }}>⚠ {state.error}</div>}
		</>
	);
}

function EntryView({ entry, ...rest }: { entry: Entry; results: Map<string, any>; tools: Record<string, LiveTool>; nested: Map<string, LiveTool[]>; wsId: string; chatId: string }) {
	switch (entry.kind) {
		case "os.user":
			return (
				<div className="msg-user">
					<div className="author">{entry.data?.author ?? "You"}</div>
					<div className="body">{entry.data?.text ?? textOf(entry.model?.[0]?.content)}</div>
				</div>
			);
		case "pi.user":
			return (
				<div className="msg-user">
					<div className="author">{entry.byTaskId ? "Agent loop" : "You"}</div>
					<div className="body">{textOf(entry.model?.[0]?.content)}</div>
				</div>
			);
		case "pi.assistant":
			return <AssistantView content={entry.model?.[0]?.content ?? []} error={entry.model?.[0]?.errorMessage} stopReason={entry.model?.[0]?.stopReason} {...rest} />;
		case "os.notice":
			return <div className="notice">{entry.data?.text}</div>;
		case "pi.compaction":
			return <div className="divider">context compacted — older turns summarized</div>;
		case "pi.reset":
			return <div className="divider">context reset</div>;
		default:
			return null;
	}
}

function AssistantView({ content, results, tools, nested, streaming, error, stopReason, wsId, chatId }: { content: any[]; results: Map<string, any>; tools: Record<string, LiveTool>; nested: Map<string, LiveTool[]>; streaming?: boolean; error?: string; stopReason?: string; wsId: string; chatId: string }) {
	const lastText = content.map((c, i) => (c?.type === "text" ? i : -1)).filter((i) => i >= 0).pop();
	return (
		<div className="msg-assistant">
			{content.map((c, i) => {
				if (!c) return null;
				if (c.type === "text") return c.text ? <Markdown key={i} text={c.text} streaming={streaming && i === lastText} /> : null;
				if (c.type === "thinking")
					return c.thinking ? (
						<details key={i} className="thinking" open={streaming && i === content.length - 1}>
							<summary>thinking</summary>
							{c.thinking}
						</details>
					) : null;
				if (c.type === "toolCall") return <ToolCard key={c.id ?? i} call={c} result={results.get(c.id)} live={tools[c.id]} nested={nested} settled={!streaming} wsId={wsId} chatId={chatId} />;
				return null;
			})}
			{stopReason === "aborted" && <div className="notice">⟲ interrupted — the run continued from its last checkpoint</div>}
			{error && <div className="err">⚠ {error}</div>}
		</div>
	);
}

function argPreview(name: string, args: any): string {
	if (!args) return "";
	if (name === "codemode") return String(args.code ?? "").split("\n").find((l: string) => l.trim()) ?? "";
	if (name === "gadget_write") return `${args.path} (${String(args.content ?? "").length} chars)`;
	if (name === "gadget_call") return `${args.method}(${JSON.stringify(args.args ?? []).slice(1, -1)})`;
	if (name === "subagent") return args.task;
	return Object.entries(args)
		.map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
		.join(" ")
		.slice(0, 160);
}

function ToolCard({ call, result, live, nested, settled, wsId, chatId }: { call: any; result?: any; live?: LiveTool; nested: Map<string, LiveTool[]>; settled?: boolean; wsId: string; chatId: string }) {
	const [open, setOpen] = useState(false);
	const interrupted = !result && !live && settled;
	const running = !result && !interrupted && live?.status !== "done";
	const isError = result?.isError ?? live?.isError;
	const output = result ? textOf(result.content) : (live?.output ?? "");
	const details = result?.details ?? live?.details;
	const children = nested.get(call.id) ?? [];
	const codemodeCalls: any[] = details?.calls ?? [];
	const args = call.arguments;
	return (
		<div className="proc">
			<div className="proc-head" onClick={() => setOpen(!open)}>
				<span className={`st ${running ? "run" : isError ? "bad" : interrupted ? "" : "ok"}`}>{running ? "●" : isError ? "✕" : interrupted ? "⊘" : "✓"}</span>
				<span className="name">{call.name}</span>
				<span className="arg">{argPreview(call.name, args)}</span>
				{details?.openGadget && (
					<a className="open" href={chatHref(wsId, chatId, details.openGadget)} onClick={(e) => e.stopPropagation()}>
						open ↗
					</a>
				)}
				{codemodeCalls.length > 0 && <span className="pill">{codemodeCalls.length} calls</span>}
				<span className="muted" style={{ fontSize: 11 }}>
					{open ? "▴" : "▾"}
				</span>
			</div>
			{(open || (running && children.length > 0)) && (
				<div className="proc-body">
					{call.name === "codemode" && args?.code && (
						<>
							<div className="sect label">script</div>
							<pre>{args.code}</pre>
						</>
					)}
					{call.name !== "codemode" && args && (
						<>
							<div className="sect label">arguments</div>
							<pre>{JSON.stringify(args, null, 2).slice(0, 6000)}</pre>
						</>
					)}
					{children.length > 0 && (
						<div className="proc-nested">
							{children.map((t) => (
								<ToolCard key={t.id} call={{ id: t.id, name: t.name, arguments: t.args }} live={t} nested={nested} settled wsId={wsId} chatId={chatId} />
							))}
						</div>
					)}
					{children.length === 0 && codemodeCalls.length > 0 && (
						<>
							<div className="sect label">tool calls</div>
							<pre>
								{codemodeCalls
									.map((c) => `${c.status === "ok" ? "✓" : c.status === "running" ? "●" : "✕"} ${c.name}(${String(c.args ?? "").slice(0, 140)})${c.durationMs !== undefined ? `  ${c.durationMs}ms` : ""}${c.error ? `\n    ${c.error.slice(0, 200)}` : ""}`)
									.join("\n")}
							</pre>
						</>
					)}
					{output && (
						<>
							<div className="sect label">{running ? "output (live)" : "result"}</div>
							<pre>{output.slice(-12000)}</pre>
						</>
					)}
				</div>
			)}
		</div>
	);
}

// ------------------------------------------------------------------ composer

function Composer({ chatId, state, models, model, onModel, onAbort, onSend }: { chatId?: string; state: ChatState; models: ModelInfo[]; model?: ModelRef; onModel: (m: ModelRef) => void; onAbort: () => void; onSend: (text: string, mode?: "steer") => Promise<void> }) {
	const [text, setText] = useState("");
	const [error, setError] = useState("");
	const ref = useRef<HTMLTextAreaElement>(null);
	useEffect(() => ref.current?.focus(), [chatId]);
	useEffect(() => {
		const el = ref.current;
		if (el) {
			el.style.height = "auto";
			el.style.height = `${Math.min(260, el.scrollHeight)}px`;
		}
	}, [text]);

	const submit = async (mode?: "steer") => {
		const t = text.trim();
		if (!t) return;
		setText("");
		setError("");
		try {
			await onSend(t, mode);
		} catch (e: any) {
			setError(e.message);
			setText(t);
		}
	};
	const byProvider = useMemo(() => {
		const m = new Map<string, ModelInfo[]>();
		for (const x of models) m.set(x.provider, [...(m.get(x.provider) ?? []), x]);
		return m;
	}, [models]);
	const value = model ? `${model.provider}/${model.modelId}` : "";

	return (
		<div className="composer-wrap">
			<div className="status-line">
				{state.busy && <span className="live">● working{state.inbox.length ? ` · ${state.inbox.length} queued` : ""}</span>}
				{state.retry && <span>retrying: {state.retry.error.slice(0, 120)}</span>}
				{state.compacting && <span>compacting context…</span>}
				{error && <span className="err">{error}</span>}
			</div>
			<div className="composer">
				<textarea
					ref={ref}
					rows={1}
					value={text}
					placeholder={state.busy ? "Steer the agent, or queue a follow-up…" : "Ask the agent to do something…"}
					onChange={(e) => setText(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter" && !e.shiftKey) {
							e.preventDefault();
							submit(state.busy && (e.ctrlKey || e.metaKey) ? "steer" : undefined);
						}
					}}
				/>
				<div className="bar">
					<select
						value={value}
						title={chatId ? "Model for this chat" : "Model for the new chat"}
						onChange={(e) => {
							const [provider, ...rest] = e.target.value.split("/");
							if (provider && rest.length) onModel({ provider, modelId: rest.join("/") });
						}}
					>
						{!value && <option value="">{models.length ? "choose a model" : "loading models…"}</option>}
						{value && !models.some((m) => `${m.provider}/${m.id}` === value) && <option value={value}>{value}</option>}
						{[...byProvider].map(([p, list]) => (
							<optgroup key={p} label={p}>
								{list.map((m) => (
									<option key={m.id} value={`${m.provider}/${m.id}`}>
										{m.name}
									</option>
								))}
							</optgroup>
						))}
					</select>
					<span className="grow" />
					{state.busy && (
						<>
							<button className="btn small" onClick={() => submit("steer")} disabled={!text.trim()} title="Inject now, after the current tool round (Ctrl+Enter)">
								Steer
							</button>
							<button className="btn small" onClick={onAbort} title="Stop the agent">
								■ Stop
							</button>
						</>
					)}
					<button className="btn primary small" onClick={() => submit()} disabled={!text.trim()}>
						{state.busy ? "Queue" : "Send"} ↵
					</button>
				</div>
			</div>
		</div>
	);
}
