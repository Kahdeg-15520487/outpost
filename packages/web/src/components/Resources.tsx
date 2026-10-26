import { useEffect, useState } from "react";
import { api, type ConnectionInfo, type GatekeeperInfo, type Grant, type Holder, type Policy, type Workspace, type WorkspaceDocs } from "../api";
import { useConnections } from "../store";
import { Dialog } from "./bits";
import "../connections.css";

let catalog: Promise<{ gatekeepers: GatekeeperInfo[]; githubToken: boolean }> | undefined;
export const useGatekeepers = () => {
	const [list, setList] = useState<GatekeeperInfo[]>([]);
	useEffect(() => {
		(catalog ??= api.get("/api/gatekeepers")).then((r) => setList(r.gatekeepers));
	}, []);
	return list;
};

type Capability = { methods?: string[]; policy: Record<string, Policy> };

/** Grants held by one chat or gadget, and the form to introduce a new resource. */
export function ResourcesPanel({ wsId, holder, grants, roles }: { wsId: string; holder: Holder; grants: WorkspaceDocs["grants"]; roles?: { id: string; title: string }[] }) {
	const gks = useGatekeepers();
	const { connections } = useConnections(wsId);
	const [pick, setPick] = useState("gk:github");
	const [resource, setResource] = useState("");
	const [label, setLabel] = useState("");
	const [autoApprove, setAuto] = useState(false);
	const [cap, setCap] = useState<Capability>({ policy: {} });
	const [forRoles, setForRoles] = useState<string[]>([]);
	const [err, setErr] = useState("");
	const to: Holder = holder.kind === "project" && forRoles.length ? { ...holder, roles: forRoles } : holder;
	const mine = Object.values(grants.grants).filter((g) => g.holder.kind === holder.kind && g.holder.id === holder.id);
	const [kind, id] = pick.split(/:(.*)/) as ["gk" | "conn", string];
	const selected = kind === "gk" ? gks.find((g) => g.id === id) : undefined;
	const conn = kind === "conn" ? connections.find((c) => c.id === id) : undefined;

	const choose = (next: string) => {
		setPick(next);
		setCap({ policy: {} });
		setAuto(false);
	};
	const introduce = async (e: React.FormEvent) => {
		e.preventDefault();
		setErr("");
		try {
			if (conn) await api.post(`/api/w/${wsId}/grants`, { connection: conn.id, label: label || undefined, holder: to, autoApprove, methods: cap.methods, policy: cap.policy });
			else await api.post(`/api/w/${wsId}/grants`, { gatekeeper: id, resource, label: label || undefined, holder: to, autoApprove });
			setResource("");
			setLabel("");
			setCap({ policy: {} });
		} catch (error: any) {
			setErr(error.message);
		}
	};

	return (
		<div className="panel">
			<div>
				<h3>Introduced resources</h3>
				<div className="muted" style={{ fontSize: 13 }}>
					This {holder.kind === "conversation" ? "chat's agent" : holder.kind === "project" ? "project's agents" : "gadget"} can reach exactly these — nothing else.{holder.kind === "project" && " A grant can be for the whole team or only some roles."} {holder.kind === "gadget" && <>Server code uses <code className="mono">ctx.gatekeepers["label"].method(args)</code>.</>}
				</div>
			</div>
			{mine.length === 0 && <div className="muted" style={{ fontSize: 13.5 }}>None yet.</div>}
			{mine.map((g) => (
				<GrantCard key={g.id} wsId={wsId} grant={g} info={gks.find((x) => x.id === g.gatekeeper)} conn={g.connection ? connections.find((c) => c.id === g.connection) : undefined} roles={roles} />
			))}
			<form onSubmit={introduce} style={{ display: "grid", gap: 10 }}>
				<div className="label">Introduce a resource</div>
				<div className="gk-grid">
					{gks.map((g) => (
						<button type="button" key={g.id} className={`gk ${pick === `gk:${g.id}` ? "on" : ""}`} onClick={() => choose(`gk:${g.id}`)}>
							<div className="i">{g.icon}</div>
							<div className="n">{g.title}</div>
							<div className="d">{g.description}</div>
						</button>
					))}
					{connections.map((c) => (
						<button type="button" key={c.id} className={`gk ${pick === `conn:${c.id}` ? "on" : ""}`} onClick={() => choose(`conn:${c.id}`)} disabled={c.status !== "ok"} title={c.status === "ok" ? undefined : c.error}>
							<div className="i">{c.icon}</div>
							<div className="n">{c.title}</div>
							<div className="d">
								{c.kind === "mcp" ? "MCP server" : "REST API"} · {c.status === "ok" ? `${c.methods.length} methods` : "not working"}
							</div>
						</button>
					))}
				</div>
				{selected?.setup && <div className="muted" style={{ fontSize: 12.5 }}>ⓘ {selected.setup}</div>}
				{kind === "gk" && <input className="input" placeholder={selected?.resourceHint ?? "resource"} value={resource} onChange={(e) => setResource(e.target.value)} required={id !== "mailbox"} />}
				{conn && <CapabilityEditor conn={conn} value={cap} onChange={setCap} />}
				{holder.kind === "project" && roles && (
					<div className="row cap-roles">
						<span className="muted">For</span>
						<button type="button" className={`chip ${forRoles.length ? "" : "on"}`} onClick={() => setForRoles([])}>
							whole team
						</button>
						{roles.map((r) => (
							<button type="button" key={r.id} className={`chip ${forRoles.includes(r.id) ? "on" : ""}`} onClick={() => setForRoles((cur) => (cur.includes(r.id) ? cur.filter((x) => x !== r.id) : [...cur, r.id]))}>
								{r.title}
							</button>
						))}
					</div>
				)}
				<div className="row">
					<input className="input grow" placeholder={conn ? `label (optional, default “${conn.label}”)` : "label (optional, e.g. repo)"} value={label} onChange={(e) => setLabel(e.target.value)} />
					{(!conn || conn.trust === "vetted") && (
						<label className="row" style={{ fontSize: 13, whiteSpace: "nowrap" }}>
							<input type="checkbox" checked={autoApprove} onChange={(e) => setAuto(e.target.checked)} /> auto-approve writes
						</label>
					)}
				</div>
				{selected && (
					<div className="mono muted" style={{ fontSize: 11.5 }}>
						{selected.methods.map((m) => `${m.name}${m.effect === "write" ? "✎" : ""}`).join(" · ")}
					</div>
				)}
				{err && <div className="err">{err}</div>}
				<div>
					<button className="btn primary" disabled={kind === "conn" && !conn}>
						Introduce
					</button>
				</div>
			</form>
		</div>
	);
}

function GrantCard({ wsId, grant: g, info, conn, roles }: { wsId: string; grant: Grant; info?: GatekeeperInfo; conn?: ConnectionInfo; roles?: { id: string; title: string }[] }) {
	const [editing, setEditing] = useState(false);
	const [cap, setCap] = useState<Capability>({ methods: g.methods, policy: g.policy ?? {} });
	const [err, setErr] = useState("");
	const byo = !!g.connection && conn?.trust !== "vetted";
	const save = async () => {
		setErr("");
		try {
			await api.patch(`/api/w/${wsId}/grants/${g.id}`, { methods: cap.methods ?? null, policy: Object.keys(cap.policy).length ? cap.policy : null });
			setEditing(false);
		} catch (e: any) {
			setErr(e.message);
		}
	};
	const summary = g.connection ? capSummary(g, conn) : undefined;
	return (
		<div className="card" style={{ padding: 10, display: "grid", gap: 8 }}>
			<div className="row">
				<span style={{ fontSize: 20 }}>{conn?.icon ?? info?.icon ?? (g.connection ? "⇄" : "")}</span>
				<div className="grow">
					<div style={{ fontWeight: 650 }}>{conn?.title ?? g.resource}</div>
					<div className="mono muted" style={{ fontSize: 11 }}>
						{g.connection ? (conn ? (conn.kind === "mcp" ? "MCP server" : "REST API") : "connection removed") : info?.title} · label “{g.label}” · by {g.createdBy}
					</div>
					{summary && <div className="mono muted cap-sum">{summary}</div>}
					{g.holder.kind === "project" && <div className="mono muted cap-sum">for {g.holder.roles?.length ? g.holder.roles.map((r) => roles?.find((x) => x.id === r)?.title ?? r).join(", ") : "the whole team"}</div>}
				</div>
				{!byo && (
					<label className="row mono" style={{ fontSize: 11.5, gap: 4 }} title="Run side effects without asking">
						<input type="checkbox" checked={g.autoApprove} onChange={(e) => api.patch(`/api/w/${wsId}/grants/${g.id}`, { autoApprove: e.target.checked })} />
						auto-approve
					</label>
				)}
				{conn && (
					<button className="btn ghost small" onClick={() => setEditing(!editing)}>
						{editing ? "Close" : "Methods"}
					</button>
				)}
				<button className="btn ghost small" onClick={() => api.del(`/api/w/${wsId}/grants/${g.id}`)}>
					Revoke
				</button>
			</div>
			{editing && conn && (
				<>
					<CapabilityEditor conn={conn} value={cap} onChange={setCap} />
					{err && <div className="err">{err}</div>}
					<div>
						<button className="btn primary small" onClick={save}>
							Save
						</button>
					</div>
				</>
			)}
		</div>
	);
}

function capSummary(g: Grant, conn?: ConnectionInfo) {
	if (!conn) return undefined;
	const n = g.methods?.length ?? conn.methods.length;
	const denied = Object.values(g.policy ?? {}).filter((p) => p === "deny").length;
	const auto = Object.values(g.policy ?? {}).filter((p) => p === "auto").length;
	return [`${n} of ${conn.methods.length} methods`, auto ? `${auto} auto-approved` : "", denied ? `${denied} refused` : "", conn.trust === "byo" ? "writes need approval" : ""].filter(Boolean).join(" · ");
}

/** Which methods a capability includes, and per write method: ask, auto (vetted only, not always-ask), or deny. */
function CapabilityEditor({ conn, value, onChange }: { conn: ConnectionInfo; value: Capability; onChange: (v: Capability) => void }) {
	const [filter, setFilter] = useState("");
	const all = !value.methods;
	const included = new Set(value.methods ?? conn.methods.map((m) => m.name));
	const shown = conn.methods.filter((m) => !filter || `${m.name} ${m.description}`.toLowerCase().includes(filter.toLowerCase()));
	const toggle = (name: string) => {
		const next = new Set(included);
		if (next.has(name)) next.delete(name);
		else next.add(name);
		onChange({ ...value, methods: [...next] });
	};
	const setPolicy = (name: string, p: Policy) => {
		const policy = { ...value.policy };
		if (p === "ask") delete policy[name];
		else policy[name] = p;
		onChange({ ...value, policy });
	};
	return (
		<div className="cap">
			<div className="row cap-head">
				<label className="row" style={{ gap: 5 }}>
					<input type="checkbox" checked={all} onChange={(e) => onChange({ ...value, methods: e.target.checked ? undefined : conn.methods.map((m) => m.name) })} /> all methods{conn.kind === "mcp" ? ", including ones the server adds later" : ""}
				</label>
				<span className="grow" />
				{conn.methods.length > 8 && <input className="input" style={{ maxWidth: 180, padding: "3px 8px", fontSize: 12 }} placeholder="filter" value={filter} onChange={(e) => setFilter(e.target.value)} />}
			</div>
			{conn.trust === "byo" && <div className="muted" style={{ fontSize: 11.5 }}>Added in the UI: its writes always wait for approval (or can be refused).</div>}
			<div className="cap-list">
				{shown.map((m) => (
					<div key={m.name} className="cap-row" title={m.description}>
						<input type="checkbox" checked={included.has(m.name)} disabled={all} onChange={() => toggle(m.name)} />
						<code className="mono">{m.name}</code>
						<span className={`pill ${m.effect === "read" ? "ok" : "signal"}`}>{m.effect}</span>
						<span className="muted grow conn-desc">{m.description}</span>
						{m.effect === "write" && (
							<select value={value.policy[m.name] ?? "ask"} onChange={(e) => setPolicy(m.name, e.target.value as Policy)} disabled={!included.has(m.name)}>
								<option value="ask">ask</option>
								{conn.trust === "vetted" && !m.alwaysAsk && <option value="auto">auto</option>}
								<option value="deny">refuse</option>
							</select>
						)}
					</div>
				))}
			</div>
		</div>
	);
}

export function ResourcesDialog({ ws, holder, grants, roles, onClose }: { ws: Workspace; holder: Holder; grants: WorkspaceDocs["grants"]; roles?: { id: string; title: string }[]; onClose: () => void }) {
	return (
		<Dialog onClose={onClose}>
			<div className="row">
				<h2 className="grow">Resources</h2>
				<button className="btn ghost small" onClick={onClose}>
					✕
				</button>
			</div>
			<div style={{ margin: "0 -18px" }}>
				<ResourcesPanel wsId={ws.id} holder={holder} grants={grants} roles={roles} />
			</div>
		</Dialog>
	);
}
