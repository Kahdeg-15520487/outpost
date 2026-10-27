import { useEffect, useRef, useState } from "react";
import { api, type Module, type LogLine, type User, type WorkspaceDocs } from "../api";
import { socket } from "../socket";
import { Avatar } from "./bits";
import { ResourcesPanel } from "./Resources";
import { EditableLabel } from "./RowMenu";

type Tab = "app" | "code" | "logs" | "data" | "share" | "access";
type Detail = { module: Module; files?: Record<string, string>; server: { methods: string[]; readonly: string[]; error?: string }; shares?: any[]; links?: any[] };

export function ModuleWindow({
	moduleId,
	user,
	grants,
	onClose,
	standalone,
	tabRequest,
	chatHidden,
	onToggleChat,
}: {
	moduleId: string;
	user: User;
	grants: WorkspaceDocs["grants"];
	onClose: () => void;
	standalone?: boolean;
	/** Switch to a tab from outside (sidebar menu); `n` changes on every request. */
	tabRequest?: { tab: Tab; n: number };
	/** Beside a chat: whether the chat is hidden, and how to toggle it. Absent when standalone. */
	chatHidden?: boolean;
	onToggleChat?: () => void;
}) {
	const [detail, setDetail] = useState<Detail>();
	const [error, setError] = useState("");
	const [tab, setTab] = useState<Tab>("app");
	const [presence, setPresence] = useState<{ id: string; name: string }[]>([]);
	const [frameUrl, setFrameUrl] = useState<string>();
	const [flash, setFlash] = useState(0);
	const [logs, setLogs] = useState<LogLine[]>([]);
	const [frameError, setFrameError] = useState("");
	const frame = useRef<HTMLIFrameElement>(null);
	useEffect(() => {
		if (tabRequest) setTab(tabRequest.tab);
	}, [tabRequest?.n]);

	const load = () =>
		api
			.get<Detail>(`/api/modules/${moduleId}`)
			.then(setDetail)
			.catch((e) => setError(e.message));
	const loadFrame = () => api.post(`/api/modules/${moduleId}/frame-token`).then((r) => setFrameUrl(`/frame/${moduleId}?t=${encodeURIComponent(r.token)}&r=${Date.now()}`));

	useEffect(() => {
		load();
		loadFrame();
		const off = socket.on((m) => {
			if (m.moduleId !== moduleId) return;
			const post = (msg: object) => frame.current?.contentWindow?.postMessage({ __outpost: 1, ...msg }, "*");
			if (m.t === "module.event") post({ t: "event", event: m.event, data: m.data });
			else if (m.t === "module.presence" || m.t === "module.subscribed") {
				setPresence(m.users);
				post({ t: "presence", users: m.users });
			} else if (m.t === "module.reload") {
				loadFrame();
				load();
				setFrameError("");
				setFlash((f) => f + 1);
			} else if (m.t === "module.log") setLogs((l) => [...l.slice(-299), m.line]);
			else if (m.t === "module.deleted") onClose();
		});
		const unsub = socket.subscribe(`module:${moduleId}`, { kind: "module", moduleId });
		return () => {
			off();
			unsub();
		};
	}, [moduleId]);

	// The frame's only channel: postMessage, relayed here to the module server as the signed-in user.
	useEffect(() => {
		const onMessage = async (e: MessageEvent) => {
			if (!frame.current || e.source !== frame.current.contentWindow) return;
			const m = e.data;
			if (!m || m.__outpost !== 1) return;
			const reply = (msg: object) => frame.current?.contentWindow?.postMessage({ __outpost: 1, ...msg }, "*");
			if (m.t === "call") {
				try {
					reply({ t: "result", id: m.id, ok: true, value: await socket.call(moduleId, String(m.method), Array.isArray(m.args) ? m.args : []) });
				} catch (err: any) {
					reply({ t: "result", id: m.id, ok: false, error: err.message });
				}
			} else if (m.t === "ready") reply({ t: "presence", users: presence });
			else if (m.t === "error") setFrameError(String(m.message).slice(0, 300));
		};
		addEventListener("message", onMessage);
		return () => removeEventListener("message", onMessage);
	}, [moduleId, presence]);

	useEffect(() => {
		if (tab === "logs") api.get(`/api/modules/${moduleId}/logs`).then((r) => setLogs(r.lines)).catch(() => {});
	}, [tab, moduleId]);

	if (error)
		return (
			<div className="gwin">
				<div className="gwin-bar">
					<span className="title grow">Module unavailable</span>
					<button className="btn ghost small" onClick={onClose}>
						✕
					</button>
				</div>
				<div className="empty-state">{error}</div>
			</div>
		);
	const g = detail?.module;
	const role = g?.role ?? "viewer";
	const tabs: [Tab, string][] = [["app", "App"]];
	if (role !== "viewer") tabs.push(["code", "Code"], ["logs", "Logs"], ["data", "Data"], ["access", "Access"]);
	if (role === "owner") tabs.push(["share", "Share"]);

	return (
		<div className="gwin" style={standalone ? { borderLeft: 0, flex: 1 } : undefined}>
			<div className="gwin-bar">
				<span className="icon">{g?.icon ?? "◆"}</span>
				<div className="grow" style={{ minWidth: 0 }}>
					<div className="title">
						{g ? <EditableLabel value={g.name} maxLength={80} onSave={role === "owner" || role === "editor" ? (name) => api.patch(`/api/modules/${moduleId}`, { name }).then(load) : undefined} /> : "…"}
					</div>
					{g && (
						<div className="mono muted" style={{ fontSize: 10.5 }}>
							{role} · {g.workspaceName}
							{g.owner ? ` · ${g.owner}` : ""}
						</div>
					)}
				</div>
				<div className="avatars" title={presence.map((p) => p.name).join(", ")}>
					{presence.map((p) => (
						<Avatar key={p.id} name={p.name} size={22} />
					))}
				</div>
				<div className="tabs">
					{tabs.map(([t, label]) => (
						<button key={t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>
							{label}
						</button>
					))}
				</div>
				{onToggleChat && (
					<button className={`btn small gwin-chat ${chatHidden ? "" : "on"}`} onClick={onToggleChat} aria-pressed={!chatHidden} title={chatHidden ? "Show the chat beside this module" : "Hide the chat; give the module the full width"}>
						💬 Chat
					</button>
				)}
				<button className="btn ghost small" onClick={onClose} title="Close">
					✕
				</button>
			</div>
			<div className="gwin-body">
				{detail?.server.error && tab === "app" && <div className="err mono" style={{ padding: "6px 12px", background: "#fff1ee", fontSize: 12 }}>server: {detail.server.error.split("\n")[0]}</div>}
				{frameError && tab === "app" && (
					<div className="err mono" style={{ padding: "6px 12px", background: "#fff1ee", fontSize: 12 }} onClick={() => setFrameError("")}>
						client: {frameError}
					</div>
				)}
				<iframe
					ref={frame}
					title={g?.name ?? "module"}
					src={frameUrl}
					sandbox="allow-scripts allow-forms allow-modals allow-downloads allow-popups"
					style={{ display: tab === "app" ? "block" : "none" }}
				/>
				{tab === "app" && flash > 0 && <div key={flash} className="gwin-flash" />}
				{tab === "code" && detail?.files && <CodeTab moduleId={moduleId} files={detail.files} server={detail.server} />}
				{tab === "logs" && <LogsTab lines={logs} />}
				{tab === "data" && <DataTab moduleId={moduleId} />}
				{tab === "access" && g && <ResourcesPanel wsId={g.workspaceId} holder={{ kind: "module", id: moduleId }} grants={grants} />}
				{tab === "share" && detail && <ShareTab detail={detail} user={user} onChange={load} />}
			</div>
		</div>
	);
}

function CodeTab({ moduleId, files, server }: { moduleId: string; files: Record<string, string>; server: Detail["server"] }) {
	const names = Object.keys(files).sort((a, b) => (a === "index.html" ? -1 : b === "index.html" ? 1 : a.localeCompare(b)));
	const [current, setCurrent] = useState(names[0] ?? "index.html");
	const [drafts, setDrafts] = useState<Record<string, string>>({});
	const [status, setStatus] = useState("");
	const value = drafts[current] ?? files[current] ?? "";
	const dirty = drafts[current] !== undefined && drafts[current] !== files[current];

	const save = async () => {
		setStatus("saving…");
		try {
			const r = await api.put(`/api/modules/${moduleId}/files`, { path: current, content: value });
			setDrafts((d) => {
				const n = { ...d };
				delete n[current];
				return n;
			});
			setStatus(r.server.error ? `saved · server error: ${r.server.error.split("\n")[0]}` : `saved · ${r.server.methods.length} methods`);
		} catch (e: any) {
			setStatus(e.message);
		}
	};
	return (
		<div className="code">
			<div className="files">
				{names.map((n) => (
					<button key={n} className={n === current ? "on" : ""} onClick={() => setCurrent(n)}>
						{n}
						{drafts[n] !== undefined && drafts[n] !== files[n] ? " •" : ""}
					</button>
				))}
				<button
					className="muted"
					onClick={() => {
						const p = prompt("New file path (e.g. app.js, style.css, server.js)");
						if (p) {
							setDrafts((d) => ({ ...d, [p]: "" }));
							setCurrent(p);
						}
					}}
				>
					+ new file
				</button>
				<div className="label" style={{ marginTop: 14, padding: "0 8px" }}>
					server api
				</div>
				<div className="mono" style={{ fontSize: 11.5, padding: "4px 8px", color: server.error ? "var(--bad)" : "var(--muted)" }}>
					{server.error ? "failed to start" : server.methods.map((m) => <div key={m}>{m}(){server.readonly.includes(m) ? " ·ro" : ""}</div>)}
				</div>
			</div>
			<div className="editor">
				<textarea
					spellCheck={false}
					value={value}
					onChange={(e) => setDrafts((d) => ({ ...d, [current]: e.target.value }))}
					onKeyDown={(e) => {
						if ((e.ctrlKey || e.metaKey) && e.key === "s") {
							e.preventDefault();
							save();
						}
						if (e.key === "Tab") {
							e.preventDefault();
							const t = e.currentTarget;
							const s = t.selectionStart;
							const v = t.value.slice(0, s) + "  " + t.value.slice(t.selectionEnd);
							setDrafts((d) => ({ ...d, [current]: v }));
							requestAnimationFrame(() => (t.selectionStart = t.selectionEnd = s + 2));
						}
					}}
				/>
				<div className="ebar">
					<span className="mono muted grow">{status || `${current} · ${value.length} chars`}</span>
					{files[current] !== undefined && (
						<button className="btn ghost small" onClick={() => confirm(`Delete ${current}?`) && api.put(`/api/modules/${moduleId}/files`, { path: current, content: null })}>
							Delete
						</button>
					)}
					<button className="btn primary small" disabled={!dirty} onClick={save}>
						Save (Ctrl+S)
					</button>
				</div>
			</div>
		</div>
	);
}

function LogsTab({ lines }: { lines: LogLine[] }) {
	const ref = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
	}, [lines]);
	return (
		<div className="logs" ref={ref}>
			{lines.length === 0 && <div style={{ color: "#6c6655" }}>No logs yet. console.log in server.js shows up here, along with calls that changed storage and errors.</div>}
			{lines.map((l, i) => (
				<div key={i} className={`l-${l.level}`}>
					<time>{new Date(l.at).toLocaleTimeString()}</time>
					{l.text}
				</div>
			))}
		</div>
	);
}

function DataTab({ moduleId }: { moduleId: string }) {
	const [kv, setKv] = useState<Record<string, unknown>>();
	const load = () => api.get(`/api/modules/${moduleId}/state`).then((r) => setKv(r.kv));
	useEffect(() => {
		load();
		return socket.on((m) => m.moduleId === moduleId && m.t === "module.event" && load());
	}, [moduleId]);
	return (
		<div className="panel">
			<div>
				<h3>Durable storage</h3>
				<div className="muted" style={{ fontSize: 13 }}>
					What <code>ctx.storage</code> holds, committed in this workspace's pi-durable harness. Updates live.
				</div>
			</div>
			{kv && Object.keys(kv).length === 0 && <div className="muted">Empty.</div>}
			{kv &&
				Object.entries(kv).map(([k, v]) => (
					<div key={k} className="card" style={{ padding: 10 }}>
						<div className="mono" style={{ fontWeight: 650, fontSize: 12.5 }}>
							{k}
						</div>
						<pre className="mono" style={{ margin: "6px 0 0", fontSize: 11.5, whiteSpace: "pre-wrap", maxHeight: 220, overflow: "auto" }}>
							{JSON.stringify(v, null, 2)}
						</pre>
					</div>
				))}
		</div>
	);
}

function ShareTab({ detail, user, onChange }: { detail: Detail; user: User; onChange: () => void }) {
	const g = detail.module;
	const [username, setUsername] = useState("");
	const [role, setRole] = useState("editor");
	const [err, setErr] = useState("");
	const [bp, setBp] = useState({ name: g.name, description: "", visibility: "public" });
	const [bpDone, setBpDone] = useState("");
	const run = (p: Promise<unknown>) => p.then(onChange).catch((e) => setErr(e.message));
	const linkUrl = (t: string) => `${location.origin}/#/link/${t}`;
	return (
		<div className="panel">
			<div className="card">
				<h3>People</h3>
				<div className="muted" style={{ fontSize: 13, marginBottom: 10 }}>
					Each person gets live, multiplayer access to <b>this instance</b>. Viewers can only call the server's read-only methods.
				</div>
				<div className="list-row">
					<span className="grow">{user.displayName} (you)</span>
					<span className="pill">owner</span>
				</div>
				{detail.shares?.map((s) => (
					<div key={s.id} className="list-row">
						<span className="grow">
							{s.displayName} <span className="muted mono">@{s.username}</span>
						</span>
						<span className="pill">{s.role}</span>
						<button className="btn ghost small" onClick={() => run(api.post(`/api/modules/${g.id}/shares`, { username: s.username, role: null }))}>
							Remove
						</button>
					</div>
				))}
				<form
					className="row"
					style={{ marginTop: 10 }}
					onSubmit={(e) => {
						e.preventDefault();
						setErr("");
						run(api.post(`/api/modules/${g.id}/shares`, { username, role }).then(() => setUsername("")));
					}}
				>
					<input className="input grow" placeholder="username" value={username} onChange={(e) => setUsername(e.target.value)} />
					<select className="input" style={{ width: 100 }} value={role} onChange={(e) => setRole(e.target.value)}>
						<option>editor</option>
						<option>viewer</option>
					</select>
					<button className="btn primary">Share</button>
				</form>
				{err && <div className="err">{err}</div>}
			</div>
			<div className="card">
				<h3>Links</h3>
				<div className="muted" style={{ fontSize: 13, marginBottom: 10 }}>
					Anyone signed in who opens a link joins with its role.
				</div>
				{detail.links?.map((l) => (
					<div key={l.token} className="list-row">
						<input className="input mono grow" readOnly value={linkUrl(l.token)} onFocus={(e) => e.currentTarget.select()} style={{ fontSize: 12 }} />
						<span className="pill">{l.role}</span>
						<button className="btn small" onClick={() => navigator.clipboard.writeText(linkUrl(l.token))}>
							Copy
						</button>
						<button className="btn ghost small" onClick={() => run(api.del(`/api/modules/${g.id}/links/${l.token}`))}>
							Revoke
						</button>
					</div>
				))}
				<div className="row" style={{ marginTop: 8 }}>
					<button className="btn small" onClick={() => run(api.post(`/api/modules/${g.id}/links`, { role: "viewer" }))}>
						+ View link
					</button>
					<button className="btn small" onClick={() => run(api.post(`/api/modules/${g.id}/links`, { role: "editor" }))}>
						+ Edit link
					</button>
				</div>
			</div>
			<div className="card">
				<h3>Publish as blueprint</h3>
				<div className="muted" style={{ fontSize: 13, marginBottom: 10 }}>
					Share the <b>code</b>, not the data: others get their own private copy they can change.
				</div>
				<div style={{ display: "grid", gap: 8 }}>
					<input className="input" value={bp.name} onChange={(e) => setBp({ ...bp, name: e.target.value })} placeholder="Name" />
					<textarea className="input" rows={2} value={bp.description} onChange={(e) => setBp({ ...bp, description: e.target.value })} placeholder="What does it do?" />
					<div className="row">
						<select className="input" style={{ width: 140 }} value={bp.visibility} onChange={(e) => setBp({ ...bp, visibility: e.target.value })}>
							<option value="public">Everyone</option>
							<option value="private">Only me</option>
						</select>
						<span className="grow muted" style={{ fontSize: 13 }}>
							{bpDone}
						</span>
						<button className="btn primary" onClick={() => api.post("/api/blueprints", { moduleId: g.id, ...bp }).then(() => setBpDone("Published ✓"))}>
							Publish
						</button>
					</div>
				</div>
			</div>
			<div className="card" style={{ borderColor: "#f1c4bd" }}>
				<div className="row">
					<div className="grow">
						<h3>Delete module</h3>
						<div className="muted" style={{ fontSize: 13 }}>
							Removes its code, data, grants and shares.
						</div>
					</div>
					<button className="btn" style={{ color: "var(--bad)" }} onClick={() => confirm(`Delete “${g.name}” for everyone?`) && api.del(`/api/modules/${g.id}`)}>
						Delete
					</button>
				</div>
			</div>
		</div>
	);
}
