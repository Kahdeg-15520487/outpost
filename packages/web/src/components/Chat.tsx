import { useEffect, useMemo, useRef, useState } from "react";
import { pickerShows, type ModelPicker } from "./ModelPicker";
import { EditableLabel } from "./RowMenu";
import { api, fileUrl, formatBytes, uploadFile, type Blueprint, type ChatMeta, type FileMeta, type Module, type ModelInfo, type ModelRef, type Suggestion, type Workspace, type WorkspaceDocs } from "../api";
import { chatHref, navigate, useChat, type ChatState, type Entry, type LiveTool } from "../store";
import { Markdown } from "./bits";
import { ResourcesDialog } from "./Resources";
import { askConfirm, reportError } from "../dialogs";
import { describeArgs, type CallNames } from "../toolargs";

const SUGGESTIONS: Suggestion[] = [
	{ k: "🎞️", t: "Make slides", d: "for my Q3 planning meeting", p: "Make slides for my Q3 planning meeting: goals, risks, timeline, asks." },
	{ k: "✅", t: "Shared task list", d: "for the team offsite", p: "Make a todo list for the team offsite and add the obvious tasks." },
	{ k: "⭕", t: "Play a game", d: "tic tac toe against the agent", p: "Make a tic tac toe game. I'll be X and you be O — join the game." },
	{ k: "🖍️", t: "Whiteboard", d: "draw together in real time", p: "Make a collaborative whiteboard." },
	{ k: "📊", t: "Build an app", d: "anything — the agent writes it", p: "Build a habit tracker module with a weekly grid and streak counts." },
	{ k: "🐙", t: "Use a Airlock", d: "issues dashboard for a repo", p: "Make an issue dashboard for the GitHub repo earendil-works/pi. Request access to it first." },
];

export function ChatView(props: {
	ws: Workspace;
	chatId?: string;
	relatedModules: Module[];
	chats: Record<string, ChatMeta>;
	models: ModelInfo[];
	defaultModel?: ModelRef;
	grants: WorkspaceDocs["grants"];
	/** Every module in the workspace, archived ones included: tool calls are shown by name. */
	modules: Module[];
	/** The workspace's files by id, so a tool call can say which file it touched. */
	files: Record<string, FileMeta>;
	openModule?: string;
	/** The module open beside the chat, when it's in this workspace's list. */
	module?: Module;
	/** This user's model dropdown selection (see ModelPickerDialog). */
	picker: ModelPicker;
	onManageModels: () => void;
	onNewChat: () => void;
}) {
	const { ws, chatId } = props;
	const state = useChat(ws.id, chatId);
	// Tool calls are shown by name: the file, module or blueprint the agent actually touched.
	const [blueprints, setBlueprints] = useState<Blueprint[]>([]);
	useEffect(() => {
		let live = true;
		api.get("/api/blueprints").then((r) => live && setBlueprints(r.blueprints)).catch(() => {});
		return () => {
			live = false;
		};
	}, []);
	const names = useMemo<CallNames>(() => ({ files: props.files, modules: props.modules, blueprints }), [props.files, props.modules, blueprints]);
	const meta = chatId ? props.chats[chatId] : undefined;
	const [resources, setResources] = useState(false);
	/** Model picked before the chat exists; the chat is created with it on first send. */
	const [pendingModel, setPendingModel] = useState<ModelRef>();
	const att = useAttachments(ws.id);
	const [dragging, setDragging] = useState(false);
	// "Ask the agent about this file" from the Files page hands files over through sessionStorage.
	useEffect(() => {
		const handoff = sessionStorage.getItem("outpost.attach");
		if (handoff) {
			sessionStorage.removeItem("outpost.attach");
			att.addExisting(JSON.parse(handoff));
		}
	}, []);
	const scroller = useRef<HTMLDivElement>(null);
	const stick = useRef(true);
	const canEdit = ws.role !== "viewer";

	// Open modules that tools touch, as they happen.
	const lastOpened = useRef(0);
	useEffect(() => {
		if (state.opened && state.opened.seq !== lastOpened.current) {
			lastOpened.current = state.opened.seq;
			if (props.openModule !== state.opened.module) navigate(chatHref(ws.id, chatId, state.opened.module));
		}
	}, [state.opened]);

	useEffect(() => {
		const el = scroller.current;
		if (el && stick.current) el.scrollTop = el.scrollHeight;
	});

	const send = async (content: string, mode?: "steer") => {
		const files = att.ids();
		let id = chatId;
		if (!id) {
			id = (await api.post(`/api/w/${ws.id}/chats`, { model: pendingModel ?? newChatModel })).id as string;
			navigate(chatHref(ws.id, id, props.openModule));
		}
		stick.current = true;
		await api.post(`/api/w/${ws.id}/chats/${id}/messages`, { content, mode, files, module: props.openModule });
		att.clear();
	};

	const chatGrants = Object.values(props.grants.grants).filter((g) => g.holder.kind === "conversation" && g.holder.id === chatId);
	const empty = !chatId || (state.ready && state.entries.filter((e) => e.kind === "outpost.user" || e.kind === "pi.user").length === 0);
	// A new chat never starts on a model the user hid: fall back to the first one they kept.
	const newChatModel = useMemo(() => {
		const d = props.defaultModel;
		const shown = (r: ModelRef) => pickerShows(props.picker, { provider: r.provider, id: r.modelId });
		if (!d || shown(d)) return d;
		const first = props.models.find((m) => pickerShows(props.picker, m) && m.provider !== "outpost-demo") ?? props.models.find((m) => pickerShows(props.picker, m));
		return first ? { provider: first.provider, modelId: first.id } : d;
	}, [props.defaultModel, props.models, props.picker]);
	const model: ModelRef | undefined = chatId ? state.agent?.model : (pendingModel ?? newChatModel);
	const chooseModel = (m: ModelRef) => (chatId ? api.patch(`/api/w/${ws.id}/chats/${chatId}`, { model: m }) : setPendingModel(m));

	return (
		<div
			className="main"
			onDragOver={(e) => {
				if (!canEdit || !e.dataTransfer.types.includes("Files")) return;
				e.preventDefault();
				setDragging(true);
			}}
			onDrop={(e) => {
				if (!canEdit || !e.dataTransfer.files.length) return;
				e.preventDefault();
				setDragging(false);
				att.add([...e.dataTransfer.files]);
			}}
			style={{ position: "relative" }}
		>
			{dragging && (
				<div className="dropzone" onDragLeave={() => setDragging(false)}>
					<div>
						<div style={{ fontSize: 34 }}>⇣</div>
						Drop files to attach — any format
					</div>
				</div>
			)}
			<div className="topbar">
				<h2>
					<EditableLabel value={meta?.title ?? "New chat"} onSave={chatId && canEdit ? (title) => api.patch(`/api/w/${ws.id}/chats/${chatId}`, { title }) : undefined} />
				</h2>
				<span className="grow" />
				{chatId && (
					<button className="btn small" onClick={() => setResources(true)} title="Introduce this chat's agent to external resources">
						🔑 Resources{chatGrants.length ? ` · ${chatGrants.length}` : ""}
					</button>
				)}
				{chatId && <Usage usage={state.usage} />}
				{chatId && canEdit && (
					<button className="btn ghost small" title="Archive chat" onClick={() => void askConfirm({ title: "Archive this chat?", body: "It leaves the sidebar for everyone in the workspace.", confirmLabel: "Archive" }).then((ok) => {
						if (ok) void api.del(`/api/w/${ws.id}/chats/${chatId}`).then(() => navigate(chatHref(ws.id))).catch(reportError);
					})}>
						Archive
					</button>
				)}
			</div>
			{props.relatedModules.length > 0 && (
				<nav className="chat-modules" aria-label="Modules in this chat">
					<span className="chat-modules-label">Modules</span>
					{props.relatedModules.map((m) => (
						<a key={m.id} className="btn small chat-module-link" href={chatHref(ws.id, chatId, m.id)} aria-label={`Open module: ${m.name}`} aria-current={props.openModule === m.id ? "true" : undefined} title={`Open ${m.name}`}>
							<span aria-hidden="true">{m.icon}</span><span className="t">{m.name}</span><span className="chat-module-open">Open ↗</span>
						</a>
					))}
				</nav>
			)}
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
						props.openModule ? (
							<ModuleHero module={props.module} canEdit={canEdit} onPick={(p) => send(p)} />
						) : (
							<div className="hero">
								<h1>
									What should we <em>make</em>?
								</h1>
								<p>
									Ask for anything. The agent works in code, builds sandboxed apps (<b>modules</b>) you can share, and reaches company systems only through <b>Airlocks</b> you introduce — with
									side effects queued for your approval.
								</p>
								{canEdit && <Suggestions list={SUGGESTIONS} onPick={(p) => send(p)} />}
							</div>
						)
					) : (
						<Transcript state={state} wsId={ws.id} chatId={chatId!} names={names} />
					)}
				</div>
			</div>
			{canEdit && <Composer placeholder={props.openModule && empty ? `Ask the agent about ${props.module?.name ?? "this module"}…` : undefined} chatId={chatId} state={state} models={props.models} modelPicker={props.picker} onManageModels={props.onManageModels} model={model} onModel={chooseModel} onAbort={() => api.post(`/api/w/${ws.id}/chats/${chatId}/abort`)} onSend={send} att={att} />}
			{resources && chatId && <ResourcesDialog ws={ws} holder={{ kind: "conversation", id: chatId }} grants={props.grants} onClose={() => setResources(false)} />}
		</div>
	);
}

function Suggestions({ list, onPick }: { list: Suggestion[]; onPick: (prompt: string) => void }) {
	return (
		<div className="suggestions">
			{list.map((s, i) => (
				<button key={s.t} className="suggestion" style={{ animationDelay: `${120 + i * 45}ms` }} onClick={() => onPick(s.p)} title={s.p}>
					<div className="k">{s.k}</div>
					<div className="t">{s.t}</div>
					<div className="d">{s.d}</div>
				</button>
			))}
		</div>
	);
}

/** "*word*" in a blueprint headline is the accent word. */
function Headline({ text }: { text: string }) {
	return <>{text.split(/(\*[^*]+\*)/).map((part, i) => (part.startsWith("*") && part.endsWith("*") ? <em key={i}>{part.slice(1, -1)}</em> : part))}</>;
}

/** The empty state of a chat opened beside a module: about that module, not about outpost in general. */
function ModuleHero({ module, canEdit, onPick }: { module?: Module; canEdit: boolean; onPick: (prompt: string) => void }) {
	const name = module?.name ?? "this module";
	const bp = module?.blueprint;
	const suggestions: Suggestion[] = bp?.suggestions?.length
		? bp.suggestions
		: [
				{ k: "🔍", t: "Review it", d: "look at it and critique", p: `Take a screenshot of ${name}, critique it like a design reviewer, then fix the top three issues.` },
				{ k: "🧭", t: "How does it work?", d: "files, API and data", p: `Explain how ${name} works: its files, its server API and the data it keeps.` },
				{ k: "✨", t: "Add a feature", d: "tell the agent what", p: `I want to add a feature to ${name}. Ask me what it is, then build it.` },
				{ k: "🎨", t: "Polish the look", d: "layout, type, spacing", p: `Restyle ${name}: cleaner layout, better typography, consistent spacing. Check it with a screenshot.` },
			];
	return (
		<div className="hero module-hero">
			<div className="gh-tag">
				<span className="gh-icon">{module?.icon ?? "◆"}</span>
				<span className="gh-name">{name}</span>
				<span className="gh-src">{!bp ? "module" : bp.name === name ? "blueprint" : `from ${bp.name} blueprint`}</span>
				<span className="gh-arrow" aria-hidden>
					open on the right →
				</span>
			</div>
			<h1>
				<Headline text={bp?.headline ?? `What's next for *${name}*?`} />
			</h1>
			<p>{bp?.intro ?? (bp ? bp.description : `${name} is open on the right. The agent can use it through its server API, change its code, or look at it and fix what it sees.`)}</p>
			{canEdit && <Suggestions list={suggestions} onPick={onPick} />}
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

export function Transcript({ state, wsId, chatId, names }: { state: ChatState; wsId: string; chatId: string; names?: CallNames }) {
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
				<EntryView key={e.id} entry={e} results={results} tools={state.tools} nested={nestedByParent} wsId={wsId} chatId={chatId} names={names} />
			))}
			{state.live && <AssistantView content={state.live.content} results={results} tools={state.tools} nested={nestedByParent} streaming wsId={wsId} chatId={chatId} names={names} />}
			{state.error && <div className="notice" style={{ color: "var(--bad)" }}>⚠ {state.error}</div>}
		</>
	);
}

function EntryView({ entry, ...rest }: { entry: Entry; results: Map<string, any>; tools: Record<string, LiveTool>; nested: Map<string, LiveTool[]>; wsId: string; chatId: string; names?: CallNames }) {
	switch (entry.kind) {
		case "outpost.user":
			return (
				<div className="msg-user">
					<div className="author">{entry.data?.author ?? "You"}</div>
					{!/^\(attached /.test(entry.data?.text ?? "") && <div className="body">{entry.data?.text ?? textOf(entry.model?.[0]?.content)}</div>}
					{entry.data?.files?.length > 0 && <FileChips wsId={rest.wsId} files={entry.data.files} />}
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
		case "outpost.notice":
			return <div className="notice">{entry.data?.text}</div>;
		case "pi.compaction":
			return <div className="divider">context compacted — older turns summarized</div>;
		case "pi.reset":
			return <div className="divider">context reset</div>;
		default:
			return null;
	}
}

function AssistantView({ content, results, tools, nested, streaming, error, stopReason, wsId, chatId, names }: { content: any[]; results: Map<string, any>; tools: Record<string, LiveTool>; nested: Map<string, LiveTool[]>; streaming?: boolean; error?: string; stopReason?: string; wsId: string; chatId: string; names?: CallNames }) {
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
				if (c.type === "toolCall") return <ToolCard key={c.id ?? i} call={c} result={results.get(c.id)} live={tools[c.id]} nested={nested} settled={!streaming} wsId={wsId} chatId={chatId} names={names} />;
				return null;
			})}
			{stopReason === "aborted" && <div className="notice">⟲ interrupted — the run continued from its last checkpoint</div>}
			{error && <div className="err">⚠ {error}</div>}
		</div>
	);
}

/** A tool call's one-line summary; the naming rules live in toolargs.ts. */
const argPreview = (name: string, args: any, names?: CallNames) => describeArgs(name, args, names);

function ToolCard({ call, result, live, nested, settled, wsId, chatId, names }: { call: any; result?: any; live?: LiveTool; nested: Map<string, LiveTool[]>; settled?: boolean; wsId: string; chatId: string; names?: CallNames }) {
	const [open, setOpen] = useState(false);
	const interrupted = !result && !live && settled;
	const running = !result && !interrupted && live?.status !== "done";
	const isError = result?.isError ?? live?.isError;
	const output = result ? textOf(result.content) : (live?.output ?? "");
	const images: any[] = Array.isArray(result?.content) ? result.content.filter((c: any) => c.type === "image") : [];
	const details = result?.details ?? live?.details;
	const children = nested.get(call.id) ?? [];
	const codemodeCalls: any[] = details?.calls ?? [];
	const args = call.arguments;
	return (
		<div className="proc">
			<div className="proc-head" onClick={() => setOpen(!open)}>
				<span className={`st ${running ? "run" : isError ? "bad" : interrupted ? "" : "ok"}`}>{running ? "●" : isError ? "✕" : interrupted ? "⊘" : "✓"}</span>
				<span className="name">{call.name}</span>
				<span className="arg">{argPreview(call.name, args, names)}</span>
				{details?.openModule && (
					<a className="open" href={chatHref(wsId, chatId, details.openModule)} onClick={(e) => e.stopPropagation()}>
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
					{images.length > 0 && (
						<div className="row" style={{ padding: "8px 12px", flexWrap: "wrap" }}>
							{images.map((im, i) => (
								<img key={i} src={`data:${im.mimeType};base64,${im.data}`} style={{ maxHeight: 220, maxWidth: "100%", borderRadius: 6, border: "1px solid var(--line)" }} />
							))}
						</div>
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

function Composer({ placeholder, chatId, state, models, modelPicker, onManageModels, model, onModel, onAbort, onSend, att }: { placeholder?: string; chatId?: string; state: ChatState; models: ModelInfo[]; modelPicker: ModelPicker; onManageModels: () => void; model?: ModelRef; onModel: (m: ModelRef) => void; onAbort: () => void; onSend: (text: string, mode?: "steer") => Promise<void>; att: Attachments }) {
	const [text, setText] = useState("");
	const picker = useRef<HTMLInputElement>(null);
	const canSend = !!(text.trim() || att.items.some((a) => a.meta)) && !att.uploading;
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
		if (!canSend) return;
		setText("");
		setError("");
		try {
			await onSend(t, mode);
		} catch (e: any) {
			setError(e.message);
			setText(t);
		}
	};
	const value = model ? `${model.provider}/${model.modelId}` : "";
	// Only the models this user chose to see. A hidden model this chat is using is listed apart, labelled as such.
	const byProvider = useMemo(() => {
		const m = new Map<string, ModelInfo[]>();
		for (const x of models) if (pickerShows(modelPicker, x)) m.set(x.provider, [...(m.get(x.provider) ?? []), x]);
		return m;
	}, [models, modelPicker]);
	const current = models.find((m) => `${m.provider}/${m.id}` === value);
	const currentHidden = current && !pickerShows(modelPicker, current) ? current : undefined;

	return (
		<div className="composer-wrap">
			<div className="status-line">
				{state.busy && <span className="live">● working{state.inbox.length ? ` · ${state.inbox.length} queued` : ""}</span>}
				{state.retry && <span>retrying: {state.retry.error.slice(0, 120)}</span>}
				{state.compacting && <span>compacting context…</span>}
				{error && <span className="err">{error}</span>}
			</div>
			<div className="composer">
				<AttachmentTray att={att} />
				<textarea
					onPaste={(e) => pasteInto(e, att)}
					ref={ref}
					rows={1}
					value={text}
					placeholder={state.busy ? "Steer the agent, or queue a follow-up…" : (placeholder ?? "Ask the agent to do something…")}
					onChange={(e) => setText(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter" && !e.shiftKey) {
							e.preventDefault();
							submit(state.busy && (e.ctrlKey || e.metaKey) ? "steer" : undefined);
						}
					}}
				/>
				<div className="bar">
					<input
						ref={picker}
						type="file"
						multiple
						hidden
						onChange={(e) => {
							att.add([...(e.target.files ?? [])]);
							e.target.value = "";
						}}
					/>
					<button className="btn ghost small" onClick={() => picker.current?.click()} title="Attach files (or drop / paste them) — any format">
						📎
					</button>
					<select
						value={value}
						title={chatId ? "Model for this chat" : "Model for the new chat"}
						onChange={(e) => {
							if (e.target.value === "__manage") return onManageModels();
							const [provider, ...rest] = e.target.value.split("/");
							if (provider && rest.length) onModel({ provider, modelId: rest.join("/") });
						}}
					>
						{!value && <option value="">{models.length ? "choose a model" : "loading models…"}</option>}
						{value && !models.some((m) => `${m.provider}/${m.id}` === value) && <option value={value}>{value}</option>}
						{currentHidden && (
							<optgroup label="This chat's model (hidden in your picker)">
								<option value={value}>
									{currentHidden.provider} · {currentHidden.name}
								</option>
							</optgroup>
						)}
						{[...byProvider].map(([p, list]) => (
							<optgroup key={p} label={p}>
								{list.map((m) => (
									<option key={m.id} value={`${m.provider}/${m.id}`}>
										{m.name}
									</option>
								))}
							</optgroup>
						))}
						{models.length > 0 && <option disabled>──────────</option>}
						{models.length > 0 && <option value="__manage">Choose models…</option>}
					</select>
					<span className="grow" />
					{state.busy && (
						<>
							<button className="btn small" onClick={() => submit("steer")} disabled={!canSend} title="Inject now, after the current tool round (Ctrl+Enter)">
								Steer
							</button>
							<button className="btn small" onClick={onAbort} title="Stop the agent">
								■ Stop
							</button>
						</>
					)}
					<button className="btn primary small" onClick={() => submit()} disabled={!canSend}>
						{state.busy ? "Queue" : "Send"} ↵
					</button>
				</div>
			</div>
		</div>
	);
}

// ------------------------------------------------------------------ attachments

/** Files pasted into a text box become attachments (screenshots get a readable name). */
export function pasteInto(e: React.ClipboardEvent, att: Attachments) {
	const files = [...e.clipboardData.files];
	if (!files.length) return;
	e.preventDefault();
	const stamp = new Date().toISOString().slice(11, 19).replaceAll(":", "");
	att.add(files.map((f, i) => (f.name && f.name !== "image.png" ? f : new File([f], `pasted-${stamp}${i ? `-${i}` : ""}.${(f.type.split("/")[1] ?? "bin").replace("jpeg", "jpg")}`, { type: f.type }))));
}

/** The files waiting to be sent, with upload progress and a remove button. */
export function AttachmentTray({ att }: { att: Attachments }) {
	if (!att.items.length) return null;
	return (
		<div className="attachments">
			{att.items.map((a) => (
				<div key={a.key} className={`attachment ${a.error ? "bad" : ""}`} title={a.error ?? a.name}>
					{a.preview ? <img src={a.preview} /> : <span className="ext">{extOf(a.name)}</span>}
					<div className="meta">
						<div className="n">{a.name}</div>
						<div className="s">{a.error ? a.error : a.meta ? `${a.meta.kind} · ${formatBytes(a.size)}` : `uploading ${Math.round(a.progress * 100)}%`}</div>
					</div>
					{!a.meta && !a.error && <div className="bar-progress" style={{ width: `${a.progress * 100}%` }} />}
					<button type="button" className="x" onClick={() => att.remove(a.key)} title="Remove">
						✕
					</button>
				</div>
			))}
		</div>
	);
}

/** A 📎 button with its hidden file input. */
export function AttachButton({ att, className = "btn ghost small", label = "📎" }: { att: Attachments; className?: string; label?: string }) {
	const input = useRef<HTMLInputElement>(null);
	return (
		<>
			<input
				ref={input}
				type="file"
				multiple
				hidden
				onChange={(e) => {
					att.add([...(e.target.files ?? [])]);
					e.target.value = "";
				}}
			/>
			<button type="button" className={className} onClick={() => input.current?.click()} title="Attach files (or drop / paste them) — any format">
				{label}
			</button>
		</>
	);
}

type Attachment = { key: string; name: string; size: number; progress: number; meta?: FileMeta; error?: string; preview?: string };
export type Attachments = ReturnType<typeof useAttachments>;
const extOf = (name: string) => (/\.([a-z0-9]{1,5})$/i.exec(name)?.[1] ?? "file").toUpperCase();

/** Files attached to the next message: uploaded as soon as they're added, sent by id. */
export function useAttachments(wsId: string) {
	const [items, setItems] = useState<Attachment[]>([]);
	const patch = (key: string, p: Partial<Attachment>) => setItems((list) => list.map((a) => (a.key === key ? { ...a, ...p } : a)));
	return {
		items,
		uploading: items.some((a) => !a.meta && !a.error),
		ids: () => items.filter((a) => a.meta).map((a) => a.meta!.id),
		add(files: File[]) {
			for (const file of files) {
				const key = `${Date.now()}-${Math.random()}`;
				const preview = file.type.startsWith("image/") && file.size < 20 << 20 ? URL.createObjectURL(file) : undefined;
				setItems((list) => [...list, { key, name: file.name, size: file.size, progress: 0, preview }]);
				uploadFile(wsId, file, (progress) => patch(key, { progress }))
					.then((meta) => patch(key, { meta, progress: 1 }))
					.catch((e) => patch(key, { error: e.message }));
			}
		},
		addExisting(metas: FileMeta[]) {
			setItems((list) => [
				...list,
				...metas.map((meta) => ({ key: meta.id, name: meta.name, size: meta.size, progress: 1, meta, preview: /^image\//.test(meta.mime) ? fileUrl(wsId, meta.id, true) : undefined })),
			]);
		},
		remove: (key: string) => setItems((list) => list.filter((a) => a.key !== key)),
		clear: () => setItems([]),
	};
}

export function FileChips({ wsId, files }: { wsId: string; files: { id: string; name: string; kind: string; mime: string; size: number }[] }) {
	return (
		<div className="attachments in-message">
			{files.map((f) =>
				/^image\/(png|jpeg|gif|webp)$/.test(f.mime) ? (
					<a key={f.id} href={fileUrl(wsId, f.id, true)} target="_blank" rel="noreferrer" className="attachment image" title={f.name}>
						<img src={fileUrl(wsId, f.id, true)} />
					</a>
				) : (
					<a key={f.id} href={fileUrl(wsId, f.id)} className="attachment" title={`Download ${f.name}`}>
						<span className="ext">{extOf(f.name)}</span>
						<div className="meta">
							<div className="n">{f.name}</div>
							<div className="s">
								{f.kind} · {formatBytes(f.size)}
							</div>
						</div>
					</a>
				),
			)}
		</div>
	);
}
