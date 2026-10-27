import { useState } from "react";
import { api, type ConnectionAuth, type ConnectionInfo, type ConnectionMethod, type ConnectionProposal, type Workspace } from "../api";
import { chatHref, timeAgo, useConnections } from "../store";
import "../connections.css";

const AUTH_LABEL: Record<ConnectionAuth["kind"], string> = {
	none: "No authentication",
	bearer: "Bearer token",
	header: "API key in a header",
	basic: "Username and password",
	query: "API key in the URL",
};
const KIND_LABEL: Record<string, string> = { mcp: "MCP server", openapi: "REST API", "azure-devops": "Azure DevOps", "github-repo": "GitHub" };
/** Ready-made connectors: the user supplies only their own service settings and a token. */
const GUIDED = ["github-repo", "azure-devops"];
const KIND_ICON: Record<string, string> = { mcp: "🔌", openapi: "🧾", "azure-devops": "🔷", "github-repo": "🐙" };
const GUIDE: Record<string, { token: string; steps: string }> = {
	"github-repo": { token: "Personal access token", steps: "GitHub → Settings → Developer settings → Fine-grained personal access tokens. Choose only this repository. Grant Contents: Read, and Issues: Read and write if agents should file issues or comment." },
	"azure-devops": { token: "Personal access token", steps: "Azure DevOps → User settings → Personal access tokens. Grant only the scopes agents need, for example Work Items (Read) and Code (Read); add write scopes only when you want agents to propose changes." },
};
const SECRET_LABEL: Record<string, string> = { token: "Token", value: "Key", username: "Username", password: "Password", pat: "Personal access token" };

/** Workspace connections: third-party services (MCP servers, REST APIs) agents and modules can be granted. */
export function ConnectionsPage({ ws }: { ws: Workspace }) {
	const { connections, proposals, reload } = useConnections(ws.id);
	const [editing, setEditing] = useState<ConnectionInfo | "new">();
	const [reviewing, setReviewing] = useState<ConnectionProposal>();
	const waiting = proposals.filter((p) => p.status === "pending");
	const isOwner = ws.role === "owner";
	return (
		<div className="main">
			<div className="page">
				<div className="page-inner">
					<div className="row conn-title">
						<h1 className="grow">Connections</h1>
						{isOwner && !editing && !reviewing && (
							<button className="btn primary" onClick={() => setEditing("new")}>
								+ Add connection
							</button>
						)}
					</div>
					<p className="lede">
						Services this workspace's agents and modules can be given access to. Outpost calls each one as the workspace's account and keeps the credentials to itself. A connection gives nobody access by itself: you introduce it to a chat or module, choosing which methods it may use. By default reads run straight away and writes wait for approval; for each method you can set Always ask or Always allow.
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
					{reviewing && (
						<ConnectionForm
							wsId={ws.id}
							proposal={reviewing}
							onDone={() => {
								setReviewing(undefined);
								reload();
							}}
						/>
					)}
					{waiting.length > 0 && !reviewing && (
						<div className="conn-proposals">
							<div className="label">Proposed by agents</div>
							{waiting.map((p) => (
								<ProposalCard key={p.id} ws={ws} p={p} isOwner={isOwner} onReview={() => (setEditing(undefined), setReviewing(p))} onChanged={reload} />
							))}
						</div>
					)}
					{connections.length === 0 && !editing && !reviewing && (
						<div className="empty-state conn-empty">
							No connections yet.{" "}
							{isOwner ? (
								<>
									Connect <b>GitHub</b> or <b>Azure DevOps</b> by filling in your own settings and a token, or add any <b>MCP server</b> or <b>REST API</b> with an OpenAPI document.
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
	/** Without a setting: reads run and writes ask. */
	const mode = (m: ConnectionMethod): "ask" | "allow" => conn.approval?.[m.name] ?? (m.effect === "read" ? "allow" : "ask");
	const asks = conn.methods.filter((m) => mode(m) === "ask").length;
	const fixed = Object.entries(conn.params ?? {})
		.map(([k, v]) => `${k}=${v}`)
		.join(" ");
	const where =
		conn.kind === "github-repo"
			? `https://github.com/${conn.params?.repository ?? "?"}${conn.account ? `  ·  as ${conn.account}` : ""}`
			: conn.kind === "azure-devops"
			? `${conn.apiBase ?? `https://dev.azure.com/${conn.params?.organization ?? "?"}${conn.params?.project ? `/${conn.params.project}` : ""}`}${conn.account ? `  ·  as ${conn.account}` : ""}`
			: (conn.kind === "mcp" ? (conn.transport === "stdio" ? `$ ${conn.command}` : conn.url) : conn.spec === "inline" ? `pasted document → ${conn.apiBase ?? conn.baseUrl ?? "?"}` : (conn.apiBase ?? conn.spec)) + (fixed ? `  ·  ${fixed}` : "");

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
	/** Always ask / Always allow for one method; null goes back to the default. Allowing a destructive method needs a confirmation. */
	const setMode = (m: ConnectionMethod, next: "ask" | "allow" | null) => {
		if (next === "allow" && m.alwaysAsk && !confirm(`“${m.name}” changes or deletes things and can't easily be undone.

Allow it to run without asking? Any chat, module or mission with access to this connection could then run it on its own.`)) return;
		return run(() => api.put(`/api/w/${wsId}/connections/${conn.id}/approval`, { method: m.name, mode: next }));
	};

	return (
		<div className={`card conn ${conn.status}`}>
			<div className="row conn-head">
				<span className="conn-icon">{conn.icon}</span>
				<div className="grow conn-name">
					<div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
						<b>{conn.title}</b>
						<code className="mono conn-label">{conn.label}</code>
						<span className="pill">{KIND_LABEL[conn.kind]}</span>
						{conn.source === "config" ? (
							<span className="pill ok" title="Declared by an admin in outpost.config.json: may reach private hosts, and its writes may be auto-approved">
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
						{` · ${asks} ask first`}
					</span>
				)}
				<span className="grow" />
				<span className="muted conn-auth">
					{AUTH_LABEL[conn.auth.kind]}
					{conn.secretsNeeded.length > 0 && (conn.secretsNeeded.every((s) => conn.secretsSet.includes(s)) ? " · set ✓" : " · not set")}
				</span>
				{isOwner && (
					<button className="btn ghost small" disabled={busy} title={GUIDED.includes(conn.kind) ? "Checks the token and access without changing anything" : "Discover the service's methods again"} onClick={() => run(() => api.post(`/api/w/${wsId}/connections/${conn.id}/refresh`))}>
						{busy ? "…" : GUIDED.includes(conn.kind) ? "Test connection" : "Refresh"}
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
							{m.alwaysAsk && <span className="pill bad" title="Deletes or changes things that are hard to undo. It asks first unless you set it to Always allow.">destructive</span>}
							<span className="muted grow conn-desc" title={m.description}>
								{m.description}
							</span>
							<div className="conn-mode">
								<div className="seg" role="group" aria-label={`Approval for ${m.name}`}>
									{(["ask", "allow"] as const).map((v) => (
										<button key={v} type="button" className={`seg-btn ${mode(m) === v ? "on" : ""} ${v}`} aria-pressed={mode(m) === v} disabled={!isOwner || busy} title={v === "ask" ? "Always ask: calls wait for your approval" : "Always allow: calls run without asking"} onClick={() => (mode(m) === v && !conn.approval?.[m.name] ? undefined : setMode(m, v))}>
											{v === "ask" ? "Ask" : "Allow"}
										</button>
									))}
								</div>
								{conn.approval?.[m.name] && isOwner ? (
									<button type="button" className="btn ghost small conn-reset" disabled={busy} title={`Back to the default (${m.effect === "read" ? "allow" : "ask"})`} aria-label={`Reset ${m.name} to its default`} onClick={() => setMode(m, null)}>
										↺
									</button>
								) : (
									<span className="conn-reset" aria-hidden="true" />
								)}
							</div>
						</div>
					))}
				</div>
			)}
		</div>
	);
}

/** One `name=value` per line → { name: value }. */
const parseParams = (text: string) =>
	Object.fromEntries(
		text
			.split("\n")
			.map((l) => l.trim())
			.filter((l) => l.includes("="))
			.map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]),
	);

const classified = (m: ConnectionMethod) =>
	({ server: "the server's annotation says so", spec: "from the HTTP method", owner: "marked by a workspace owner", default: "not annotated: treated as a write" })[m.classifiedBy];

function StatusPill({ conn }: { conn: ConnectionInfo }) {
	if (conn.status === "ok") return <span className="pill ok" title={conn.refreshedAt ? `checked ${timeAgo(conn.refreshedAt)}` : undefined}>connected</span>;
	if (conn.status === "pending") return <span className="pill">connecting…</span>;
	return <span className="pill bad">failing</span>;
}

function ProposalCard({ ws, p, isOwner, onReview, onChanged }: { ws: Workspace; p: ConnectionProposal; isOwner: boolean; onReview: () => void; onChanged: () => void }) {
	const [err, setErr] = useState("");
	return (
		<div className="card conn conn-proposal">
			<div className="row conn-head">
				<span className="conn-icon">{KIND_ICON[p.kind]}</span>
				<div className="grow conn-name">
					<div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
						<b>{p.title ?? p.label}</b>
						<code className="mono conn-label">{p.label}</code>
						<span className="pill">{KIND_LABEL[p.kind]}</span>
						<span className="pill signal">proposed</span>
					</div>
					<div className="mono muted conn-where">{p.kind === "github-repo" ? `https://github.com/${p.params?.repository ?? "?"}` : p.kind === "azure-devops" ? `https://dev.azure.com/${p.params?.organization ?? "?"}${p.params?.project ? `/${p.params.project}` : ""}` : (p.url ?? p.spec)}</div>
				</div>
				<span className="muted conn-auth">{timeAgo(p.createdAt)}</span>
			</div>
			<div className="conn-reason">{p.reason}</div>
			<div className="row conn-foot">
				<span className="muted conn-auth">
					{AUTH_LABEL[p.auth.kind]}
					{"name" in p.auth ? ` (${p.auth.name})` : ""} · proposed in{" "}
					<a href={chatHref(ws.id, p.proposedBy.id)} className="conn-from">
						a chat
					</a>
				</span>
				<span className="grow" />
				{isOwner ? (
					<>
						<button className="btn primary small" onClick={onReview}>
							Review and connect
						</button>
						<button className="btn ghost small" onClick={() => api.post(`/api/w/${ws.id}/connection-proposals/${p.id}/decline`).then(onChanged, (e) => setErr(e.message))}>
							Decline
						</button>
					</>
				) : (
					<span className="muted conn-auth">A workspace owner connects it.</span>
				)}
			</div>
			{err && <div className="err">{err}</div>}
		</div>
	);
}

function ConnectionForm({ wsId, conn, proposal, onDone }: { wsId: string; conn?: ConnectionInfo; proposal?: ConnectionProposal; onDone: () => void }) {
	const from = conn ?? proposal;
	const [kind, setKind] = useState<ConnectionInfo["kind"]>(from?.kind ?? "github-repo");
	const [repository, setRepository] = useState(from?.params?.repository ?? "");
	const [org, setOrg] = useState(from?.params?.organization ?? "");
	const [project, setProject] = useState(from?.params?.project ?? "");
	const [label, setLabel] = useState(from?.label ?? "");
	const [title, setTitle] = useState(from?.title ?? "");
	const [url, setUrl] = useState(from?.url ?? "");
	const [transport, setTransport] = useState(from?.transport ?? "");
	const [specMode, setSpecMode] = useState<"url" | "paste">(conn?.spec === "inline" ? "paste" : "url");
	const [spec, setSpec] = useState(from?.spec && from.spec !== "inline" ? from.spec : "");
	const [specText, setSpecText] = useState("");
	const [baseUrl, setBaseUrl] = useState(from?.baseUrl ?? "");
	const [params, setParams] = useState(
		Object.entries(from?.params ?? {})
			.map(([k, v]) => `${k}=${v}`)
			.join("\n"),
	);
	const [authKind, setAuthKind] = useState<ConnectionAuth["kind"]>(from?.auth.kind ?? "none");
	const [authName, setAuthName] = useState(from && "name" in from.auth ? from.auth.name : "");
	const [secrets, setSecrets] = useState<Record<string, string>>({});
	const [err, setErr] = useState("");
	const [busy, setBusy] = useState(false);
	/** A connection saved by this form that isn't working yet: retrying edits it instead of creating a second one. */
	const [savedId, setSavedId] = useState<string>();
	const guided = GUIDED.includes(kind);
	const secretFields = kind === "azure-devops" ? ["password"] : kind === "github-repo" ? ["token"] : authKind === "bearer" ? ["token"] : authKind === "basic" ? ["username", "password"] : authKind === "header" || authKind === "query" ? ["value"] : [];

	const submit = async (e: React.FormEvent) => {
		e.preventDefault();
		setErr("");
		setBusy(true);
		const auth = kind === "azure-devops" ? { kind: "basic" } : kind === "github-repo" ? { kind: "bearer" } : authKind === "header" || authKind === "query" ? { kind: authKind, name: authName } : { kind: authKind };
		const body: Record<string, unknown> = {
			kind,
			label,
			title,
			auth,
			baseUrl,
			secrets: Object.fromEntries(Object.entries(secrets).filter(([k, v]) => v && secretFields.includes(k))),
			...(kind === "mcp" ? { url, transport: transport || undefined } : specMode === "paste" ? (specText.trim() ? { specText } : {}) : { spec }),
			...(kind === "openapi" ? { params: parseParams(params) } : {}),
			...(kind === "github-repo" ? { params: { repository: repository.trim() } } : {}),
			...(kind === "azure-devops" ? { params: { organization: org.trim(), ...(project.trim() ? { project: project.trim() } : {}) } } : {}),
		};
		try {
			const editId = conn?.id ?? savedId;
			const r = editId
				? await api.patch(`/api/w/${wsId}/connections/${editId}`, body)
				: proposal
					? await api.post(`/api/w/${wsId}/connection-proposals/${proposal.id}/accept`, body)
					: await api.post(`/api/w/${wsId}/connections`, body);
			if (r.connection.status === "error") setSavedId(r.connection.id);
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
			<h3>{conn ? `Edit ${conn.title}` : proposal ? `Connect ${proposal.title ?? proposal.label}` : "Add a connection"}</h3>
			{proposal && (
				<div className="conn-reason">
					<b>An agent proposed this:</b> {proposal.reason}
					{proposal.setup && (
						<div>
							<b>Getting the key:</b> {proposal.setup}
						</div>
					)}
					<div className="muted">Check the address before connecting: it's what Outpost will call with the key you enter.</div>
				</div>
			)}
			{!conn && !proposal && (
				<div className="gk-grid conn-kinds">
					<button type="button" className={`gk ${kind === "github-repo" ? "on" : ""}`} onClick={() => setKind("github-repo")}>
						<div className="i">🐙</div>
						<div className="n">GitHub</div>
						<div className="d">One repository: issues, files and metadata. Filing issues and comments wait for approval.</div>
					</button>
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
					<button type="button" className={`gk ${kind === "azure-devops" ? "on" : ""}`} onClick={() => setKind("azure-devops")}>
						<div className="i">🔷</div>
						<div className="n">Azure DevOps</div>
						<div className="d">Boards, repos and pull requests, pipelines and wiki of one organization, with a personal access token.</div>
					</button>
				</div>
			)}
			<div className="conn-fields">
				<label className="label">Label</label>
				<div>
					<input className="input mono" value={label} onChange={(e) => setLabel(e.target.value)} placeholder={kind === "github-repo" ? "widgets-repo" : kind === "azure-devops" ? "ado" : kind === "openapi" ? "inventory" : "linear"} required pattern="[A-Za-z][A-Za-z0-9_\-]{0,39}" />
					<div className="hint">What agents and modules call it: ctx.airlocks["{label || "label"}"]</div>
				</div>
				<label className="label">Name</label>
				<input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder={kind === "mcp" ? "Linear" : kind === "github-repo" ? "GitHub: widgets" : kind === "azure-devops" ? "Azure DevOps" : "Inventory API"} />
				{kind === "github-repo" ? (
					<>
						<label className="label">Repository</label>
						<div>
							<input className="input mono" value={repository} onChange={(e) => setRepository(e.target.value)} placeholder="owner/repo" required />
							<div className="hint">owner/repo, or its github.com address. One repository per connection.</div>
						</div>
					</>
				) : kind === "azure-devops" ? (
					<>
						<label className="label">Organization</label>
						<div>
							<input className="input mono" value={org} onChange={(e) => setOrg(e.target.value)} placeholder="contoso" required pattern="[A-Za-z0-9][A-Za-z0-9\-]{0,49}" />
							<div className="hint">dev.azure.com/&lt;organization&gt;</div>
						</div>
						<label className="label">Project</label>
						<div>
							<input className="input" value={project} onChange={(e) => setProject(e.target.value)} placeholder="(optional) pins it to one project" />
							<div className="hint">Empty: agents name the project in each call.</div>
						</div>
					</>
				) : kind === "mcp" ? (
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
						<label className="label">Fixed parameters</label>
						<div>
							<textarea className="input mono" rows={2} value={params} onChange={(e) => setParams(e.target.value)} placeholder={"organization=contoso"} />
							<div className="hint">One name=value per line. Sent with every call; agents don't see them and can't change them.</div>
						</div>
					</>
				)}
				{!guided && <label className="label">Authentication</label>}
				<div className="row" style={{ gap: 8, display: guided ? "none" : undefined }}>
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
					<SecretField key={k} name={guided ? "pat" : k} isSet={!!conn?.secretsSet.includes(k) && (guided || conn.auth.kind === authKind)} value={secrets[k] ?? ""} onChange={(v) => setSecrets((s) => ({ ...s, [k]: v }))} />
				))}
			</div>
			{guided && (
				<div className="conn-guide">
					<b>Getting the token.</b> {GUIDE[kind]?.steps}
					<div className="muted">Outpost tests it when you connect. Use a token that expires and covers only what you need.</div>
				</div>
			)}
			<div className="muted conn-note">
				Outpost calls the service as this account for everyone in the workspace. Secrets are stored encrypted on the server and never shown again. Connections added here reach public hosts only, and their writes always need approval; an admin can declare trusted ones in outpost.config.json.
			</div>
			{err && <div className="err">{err}</div>}
			<div className="row" style={{ gap: 8 }}>
				<button className="btn primary" disabled={busy}>
					{busy ? "Connecting…" : conn || savedId ? "Save and reconnect" : "Connect"}
				</button>
				<button type="button" className="btn ghost" onClick={onDone}>
					{err.startsWith("Saved") ? "Close" : "Cancel"}
				</button>
			</div>
		</form>
	);
}

function SecretField({ name, isSet, value, onChange }: { name: string; isSet: boolean; value: string; onChange: (v: string) => void }) {
	// Basic auth: the username may be empty (Azure DevOps personal access tokens go in the password).
	const optional = name === "username";
	return (
		<>
			<label className="label">{SECRET_LABEL[name] ?? name}</label>
			<input
				className="input mono"
				type={name === "username" ? "text" : "password"}
				autoComplete="off"
				value={value}
				onChange={(e) => onChange(e.target.value)}
				placeholder={isSet ? "set ✓ — leave empty to keep it" : optional ? "optional (empty for a personal access token)" : ""}
				required={!isSet && !optional}
			/>
		</>
	);
}
