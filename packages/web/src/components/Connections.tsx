import { useState } from "react";
import { api, type ConnectionAuth, type ConnectionInfo, type ConnectionMethod, type Workspace } from "../api";
import { timeAgo, useConnections } from "../store";
import "../connections.css";

const AUTH_LABEL: Record<ConnectionAuth["kind"], string> = {
	none: "No authentication",
	bearer: "Bearer token",
	header: "API key in a header",
	basic: "Username and password",
	query: "API key in the URL",
};
const SECRET_LABEL: Record<string, string> = { token: "Token", value: "Key", username: "Username", password: "Password" };

/** Workspace connections: third-party services (MCP servers, REST APIs) agents and gadgets can be granted. */
export function ConnectionsPage({ ws }: { ws: Workspace }) {
	const { connections, reload } = useConnections(ws.id);
	const [editing, setEditing] = useState<ConnectionInfo | "new">();
	const isOwner = ws.role === "owner";
	return (
		<div className="main">
			<div className="page">
				<div className="page-inner">
					<div className="row conn-title">
						<h1 className="grow">Connections</h1>
						{isOwner && !editing && (
							<button className="btn primary" onClick={() => setEditing("new")}>
								+ Add connection
							</button>
						)}
					</div>
					<p className="lede">
						Services this workspace's agents and gadgets can be given access to. pi-os calls each one as the workspace's account and keeps the credentials to itself. A connection gives nobody access by itself: you introduce it to a chat or gadget, choosing which methods it may use. Reads run straight away; writes wait for approval.
					</p>
					{editing && (
						<ConnectionForm
							wsId={ws.id}
							conn={editing === "new" ? undefined : editing}
							onDone={() => {
								setEditing(undefined);
								reload();
							}}
						/>
					)}
					{connections.length === 0 && !editing && (
						<div className="empty-state conn-empty">
							No connections yet.{" "}
							{isOwner ? (
								<>
									Add an <b>MCP server</b> (its tools become methods) or a <b>REST API</b> with an OpenAPI document (its operations become methods).
								</>
							) : (
								"A workspace owner can add them."
							)}
						</div>
					)}
					<div className="conn-list">
						{connections.map((c) => (
							<ConnectionCard key={c.id} wsId={ws.id} conn={c} isOwner={isOwner} onEdit={() => setEditing(c)} onChanged={reload} />
						))}
					</div>
				</div>
			</div>
		</div>
	);
}

function ConnectionCard({ wsId, conn, isOwner, onEdit, onChanged }: { wsId: string; conn: ConnectionInfo; isOwner: boolean; onEdit: () => void; onChanged: () => void }) {
	const [open, setOpen] = useState(false);
	const [busy, setBusy] = useState(false);
	const [err, setErr] = useState("");
	const editable = isOwner && conn.source === "workspace";
	const reads = conn.methods.filter((m) => m.effect === "read").length;
	const writes = conn.methods.length - reads;
	const asks = conn.methods.filter((m) => m.alwaysAsk).length;
	const where = conn.kind === "mcp" ? (conn.transport === "stdio" ? `$ ${conn.command}` : conn.url) : conn.spec === "inline" ? `pasted document → ${conn.apiBase ?? conn.baseUrl ?? "?"}` : (conn.apiBase ?? conn.spec);

	const run = async (fn: () => Promise<unknown>) => {
		setBusy(true);
		setErr("");
		try {
			await fn();
			onChanged();
		} catch (e: any) {
			setErr(e.message);
		} finally {
			setBusy(false);
		}
	};
	const toggleRead = (m: ConnectionMethod) => {
		const set = new Set(conn.reads ?? []);
		if (set.has(m.name)) set.delete(m.name);
		else set.add(m.name);
		return run(() => api.patch(`/api/w/${wsId}/connections/${conn.id}`, { reads: [...set] }));
	};

	return (
		<div className={`card conn ${conn.status}`}>
			<div className="row conn-head">
				<span className="conn-icon">{conn.icon}</span>
				<div className="grow conn-name">
					<div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
						<b>{conn.title}</b>
						<code className="mono conn-label">{conn.label}</code>
						<span className="pill">{conn.kind === "mcp" ? "MCP server" : "REST API"}</span>
						{conn.source === "config" ? (
							<span className="pill ok" title="Declared by an admin in pi-os.config.json: may reach private hosts, and its writes may be auto-approved">
								admin · vetted
							</span>
						) : (
							<span className="pill" title="Added in this workspace: public hosts only, and its writes always need approval">
								added here
							</span>
						)}
					</div>
					<div className="mono muted conn-where" title={where}>
						{where}
					</div>
				</div>
				<StatusPill conn={conn} />
			</div>
			{conn.status === "error" && <div className="err conn-err">{conn.error}</div>}
			<div className="row conn-foot">
				<button className="btn ghost small" onClick={() => setOpen(!open)} disabled={!conn.methods.length}>
					{open ? "▾" : "▸"} {conn.methods.length} methods
				</button>
				{conn.methods.length > 0 && (
					<span className="muted conn-counts">
						{reads} read{reads === 1 ? "" : "s"} · {writes} write{writes === 1 ? "" : "s"}
						{asks ? ` (${asks} always ask)` : ""}
					</span>
				)}
				<span className="grow" />
				<span className="muted conn-auth">
					{AUTH_LABEL[conn.auth.kind]}
					{conn.secretsNeeded.length > 0 && (conn.secretsNeeded.every((s) => conn.secretsSet.includes(s)) ? " · set ✓" : " · not set")}
				</span>
				{isOwner && (
					<button className="btn ghost small" disabled={busy} onClick={() => run(() => api.post(`/api/w/${wsId}/connections/${conn.id}/refresh`))}>
						{busy ? "…" : "Refresh"}
					</button>
				)}
				{editable && (
					<>
						<button className="btn ghost small" onClick={onEdit}>
							Edit
						</button>
						<button
							className="btn ghost small"
							onClick={() => confirm(`Remove “${conn.title}”? Everything granted on it is revoked and its queued actions are rejected.`) && run(() => api.del(`/api/w/${wsId}/connections/${conn.id}`))}
						>
							Remove
						</button>
					</>
				)}
			</div>
			{err && <div className="err">{err}</div>}
			{open && (
				<div className="conn-methods">
					{conn.methods.map((m) => (
						<div key={m.name} className="conn-method">
							<code className="mono">{m.name}</code>
							<span className={`pill ${m.effect === "read" ? "ok" : "signal"}`} title={classified(m)}>
								{m.effect}
							</span>
							{m.alwaysAsk && <span className="pill bad">always asks</span>}
							<span className="muted grow conn-desc" title={m.description}>
								{m.description}
							</span>
							{editable && (m.effect === "write" || m.classifiedBy === "owner") && (
								<label className="row conn-asread" title="Calls run without approval: only for methods that change nothing">
									<input type="checkbox" checked={m.classifiedBy === "owner"} disabled={busy} onChange={() => toggleRead(m)} /> treat as read
								</label>
							)}
						</div>
					))}
				</div>
			)}
		</div>
	);
}

const classified = (m: ConnectionMethod) =>
	({ server: "the server's annotation says so", spec: "from the HTTP method", owner: "marked by a workspace owner", default: "not annotated: treated as a write" })[m.classifiedBy];

function StatusPill({ conn }: { conn: ConnectionInfo }) {
	if (conn.status === "ok") return <span className="pill ok" title={conn.refreshedAt ? `checked ${timeAgo(conn.refreshedAt)}` : undefined}>connected</span>;
	if (conn.status === "pending") return <span className="pill">connecting…</span>;
	return <span className="pill bad">failing</span>;
}

function ConnectionForm({ wsId, conn, onDone }: { wsId: string; conn?: ConnectionInfo; onDone: () => void }) {
	const [kind, setKind] = useState<"mcp" | "openapi">(conn?.kind ?? "mcp");
	const [label, setLabel] = useState(conn?.label ?? "");
	const [title, setTitle] = useState(conn?.title ?? "");
	const [url, setUrl] = useState(conn?.url ?? "");
	const [transport, setTransport] = useState(conn?.transport ?? "");
	const [specMode, setSpecMode] = useState<"url" | "paste">(conn?.spec === "inline" ? "paste" : "url");
	const [spec, setSpec] = useState(conn?.spec && conn.spec !== "inline" ? conn.spec : "");
	const [specText, setSpecText] = useState("");
	const [baseUrl, setBaseUrl] = useState(conn?.baseUrl ?? "");
	const [authKind, setAuthKind] = useState<ConnectionAuth["kind"]>(conn?.auth.kind ?? "none");
	const [authName, setAuthName] = useState(conn && "name" in conn.auth ? conn.auth.name : "");
	const [secrets, setSecrets] = useState<Record<string, string>>({});
	const [err, setErr] = useState("");
	const [busy, setBusy] = useState(false);
	const secretFields = authKind === "bearer" ? ["token"] : authKind === "basic" ? ["username", "password"] : authKind === "header" || authKind === "query" ? ["value"] : [];

	const submit = async (e: React.FormEvent) => {
		e.preventDefault();
		setErr("");
		setBusy(true);
		const auth = authKind === "header" || authKind === "query" ? { kind: authKind, name: authName } : { kind: authKind };
		const body: Record<string, unknown> = {
			kind,
			label,
			title,
			auth,
			baseUrl,
			secrets: Object.fromEntries(Object.entries(secrets).filter(([k, v]) => v && secretFields.includes(k))),
			...(kind === "mcp" ? { url, transport: transport || undefined } : specMode === "paste" ? (specText.trim() ? { specText } : {}) : { spec }),
		};
		try {
			const r = conn ? await api.patch(`/api/w/${wsId}/connections/${conn.id}`, body) : await api.post(`/api/w/${wsId}/connections`, body);
			if (r.connection.status === "error") setErr(`Saved, but it isn't working yet: ${r.connection.error}`);
			else onDone();
		} catch (error: any) {
			setErr(error.message);
		} finally {
			setBusy(false);
		}
	};

	return (
		<form className="card conn-form" onSubmit={submit}>
			<h3>{conn ? `Edit ${conn.title}` : "Add a connection"}</h3>
			{!conn && (
				<div className="gk-grid conn-kinds">
					<button type="button" className={`gk ${kind === "mcp" ? "on" : ""}`} onClick={() => setKind("mcp")}>
						<div className="i">🔌</div>
						<div className="n">MCP server</div>
						<div className="d">Any Model Context Protocol server over HTTP. Its tools become methods; tools it marks read-only run, the rest wait for approval.</div>
					</button>
					<button type="button" className={`gk ${kind === "openapi" ? "on" : ""}`} onClick={() => setKind("openapi")}>
						<div className="i">🧾</div>
						<div className="n">REST API</div>
						<div className="d">Any HTTP API with an OpenAPI 3 or Swagger 2 document. GET operations run; everything else waits for approval.</div>
					</button>
				</div>
			)}
			<div className="conn-fields">
				<label className="label">Label</label>
				<div>
					<input className="input mono" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="linear" required pattern="[A-Za-z][A-Za-z0-9_\-]{0,39}" />
					<div className="hint">What agents and gadgets call it: ctx.gatekeepers["{label || "label"}"]</div>
				</div>
				<label className="label">Name</label>
				<input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder={kind === "mcp" ? "Linear" : "Inventory API"} />
				{kind === "mcp" ? (
					<>
						<label className="label">Server URL</label>
						<input className="input mono" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://mcp.example.com/mcp" required type="url" />
						<label className="label">Transport</label>
						<select className="input" value={transport} onChange={(e) => setTransport(e.target.value as any)}>
							<option value="">Automatic (streamable HTTP, falling back to SSE)</option>
							<option value="http">Streamable HTTP</option>
							<option value="sse">HTTP + SSE (older servers)</option>
						</select>
					</>
				) : (
					<>
						<label className="label">OpenAPI document</label>
						<div style={{ display: "grid", gap: 6 }}>
							<div className="row" style={{ gap: 14, fontSize: 13 }}>
								<label className="row" style={{ gap: 5 }}>
									<input type="radio" checked={specMode === "url"} onChange={() => setSpecMode("url")} /> from a URL
								</label>
								<label className="row" style={{ gap: 5 }}>
									<input type="radio" checked={specMode === "paste"} onChange={() => setSpecMode("paste")} /> paste it
								</label>
							</div>
							{specMode === "url" ? (
								<input className="input mono" value={spec} onChange={(e) => setSpec(e.target.value)} placeholder="https://api.example.com/openapi.json" required type="url" />
							) : (
								<textarea className="input mono" rows={6} value={specText} onChange={(e) => setSpecText(e.target.value)} placeholder={conn?.spec === "inline" ? "Paste a new document to replace it, or leave empty" : "openapi: 3.0.0 … (JSON or YAML)"} required={!conn || conn.spec !== "inline"} />
							)}
						</div>
						<label className="label">Base URL</label>
						<div>
							<input className="input mono" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="(optional) https://api.example.com/v2" type="url" />
							<div className="hint">Leave empty to use the document's server.</div>
						</div>
					</>
				)}
				<label className="label">Authentication</label>
				<div className="row" style={{ gap: 8 }}>
					<select className="input grow" value={authKind} onChange={(e) => setAuthKind(e.target.value as any)}>
						{Object.entries(AUTH_LABEL).map(([k, v]) => (
							<option key={k} value={k}>
								{v}
							</option>
						))}
					</select>
					{(authKind === "header" || authKind === "query") && <input className="input mono grow" value={authName} onChange={(e) => setAuthName(e.target.value)} placeholder={authKind === "header" ? "x-api-key" : "api_key"} required />}
				</div>
				{secretFields.map((k) => (
					<SecretField key={k} name={k} isSet={!!conn?.secretsSet.includes(k) && conn.auth.kind === authKind} value={secrets[k] ?? ""} onChange={(v) => setSecrets((s) => ({ ...s, [k]: v }))} />
				))}
			</div>
			<div className="muted conn-note">
				pi-os calls the service as this account for everyone in the workspace. Secrets are stored encrypted on the server and never shown again. Connections added here reach public hosts only, and their writes always need approval; an admin can declare trusted ones in pi-os.config.json.
			</div>
			{err && <div className="err">{err}</div>}
			<div className="row" style={{ gap: 8 }}>
				<button className="btn primary" disabled={busy}>
					{busy ? "Connecting…" : conn ? "Save and reconnect" : "Connect"}
				</button>
				<button type="button" className="btn ghost" onClick={onDone}>
					{err.startsWith("Saved") ? "Close" : "Cancel"}
				</button>
			</div>
		</form>
	);
}

function SecretField({ name, isSet, value, onChange }: { name: string; isSet: boolean; value: string; onChange: (v: string) => void }) {
	return (
		<>
			<label className="label">{SECRET_LABEL[name] ?? name}</label>
			<input className="input mono" type={name === "username" ? "text" : "password"} autoComplete="off" value={value} onChange={(e) => onChange(e.target.value)} placeholder={isSet ? "set ✓ — leave empty to keep it" : ""} required={!isSet} />
		</>
	);
}
