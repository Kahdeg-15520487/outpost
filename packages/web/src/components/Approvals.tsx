import { useState } from "react";
import { api, type ApprovalAction, type Gadget, type Workspace, type WorkspaceDocs } from "../api";
import { chatHref, timeAgo, useConnections } from "../store";
import { useGatekeepers } from "./Resources";

export function ApprovalsDrawer({ ws, docs, gadgets, onClose }: { ws: Workspace; docs: WorkspaceDocs; gadgets: Gadget[]; onClose: () => void }) {
	const gks = useGatekeepers();
	const [tab, setTab] = useState<"queue" | "history" | "audit" | "outbox">("queue");
	const [busy, setBusy] = useState<string>();
	const actions = Object.values(docs.approvals.actions).sort((a, b) => b.createdAt - a.createdAt);
	const pending = actions.filter((a) => a.status === "pending");
	const decided = actions.filter((a) => a.status !== "pending");
	const requests = Object.values(docs.grants.requests).filter((r) => r.status === "pending");
	const proposals = useConnections(ws.id).proposals.filter((p) => p.status === "pending");
	const icon = (id: string) => gks.find((g) => g.id === id)?.icon ?? ({ mcp: "🔌", openapi: "🧾" } as Record<string, string>)[id] ?? "◆";
	const holderName = (h: { kind: string; id: string; roles?: string[] }) =>
		h.kind === "conversation"
			? `chat “${docs.chats.chats[h.id]?.title ?? h.id}”`
			: h.kind === "project"
				? `project team${h.roles?.length ? ` (${h.roles.join(", ")})` : ""}`
				: `gadget “${gadgets.find((g) => g.id === h.id)?.name ?? h.id}”`;

	const decide = async (a: ApprovalAction, approve: boolean) => {
		setBusy(a.id);
		try {
			await api.post(`/api/w/${ws.id}/approvals/${a.id}/${approve ? "approve" : "reject"}`);
		} catch (e: any) {
			alert(e.message);
		} finally {
			setBusy(undefined);
		}
	};
	const approveAll = async () => {
		for (const a of pending) await decide(a, true);
	};

	return (
		<>
			<div className="scrim" onClick={onClose} />
			<div className="drawer">
				<header>
					<h2>Approvals & access</h2>
					<button className="btn ghost small" onClick={onClose}>
						✕
					</button>
				</header>
				<div style={{ padding: "10px 18px 0" }}>
					<div className="tabs" style={{ display: "inline-flex" }}>
						{(
							[
								["queue", `Queue${pending.length + requests.length + proposals.length ? ` · ${pending.length + requests.length + proposals.length}` : ""}`],
								["history", "History"],
								["audit", "Audit log"],
								["outbox", "Outbox"],
							] as const
						).map(([t, l]) => (
							<button key={t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>
								{l}
							</button>
						))}
					</div>
				</div>
				<div className="content">
					{tab === "queue" && (
						<>
							<div className="muted" style={{ fontSize: 13.5 }}>
								Agents and gadgets don't wait for you: side effects are <b>simulated</b> and queued here, so work continues. Review them when it suits you.
							</div>
							{proposals.map((p) => (
								<div key={p.id} className="action">
									<span className="stamp pending">connect?</span>
									<div className="sum">
										{p.kind === "mcp" ? "🔌" : "🧾"} {p.title ?? p.label} <span className="mono muted">({p.label})</span>
									</div>
									<div className="meta">
										new {p.kind === "mcp" ? "MCP server" : "REST API"} · proposed by {holderName(p.proposedBy)} · {timeAgo(p.createdAt)}
									</div>
									<pre>{p.reason}</pre>
									<div className="row">
										<a className="btn primary small" href={`#/w/${ws.id}/connections`} onClick={onClose}>
											{ws.role === "owner" ? "Review and connect" : "See it (an owner connects it)"}
										</a>
									</div>
								</div>
							))}
							{requests.map((r) => (
								<div key={r.id} className="action">
									<span className="stamp pending">access?</span>
									<div className="sum">
										{icon(r.gatekeeper)} {r.resource}
									</div>
									<div className="meta">
										{r.gatekeeper} · requested by {holderName(r.holder)} · {timeAgo(r.createdAt)}
									</div>
									<pre>{r.reason}</pre>
									{r.methods?.length ? <div className="mono muted" style={{ fontSize: 11.5 }}>asks for: {r.methods.join(", ")}</div> : null}
									<div className="row">
										<button className="btn primary small" onClick={() => api.post(`/api/w/${ws.id}/grants`, r.connection ? { connection: r.connection, methods: r.methods, holder: r.holder, requestId: r.id } : { gatekeeper: r.gatekeeper, resource: r.resource, holder: r.holder, requestId: r.id })}>
											Introduce
										</button>
										<button className="btn small" onClick={() => api.post(`/api/w/${ws.id}/requests/${r.id}/deny`)}>
											Deny
										</button>
									</div>
								</div>
							))}
							{pending.length > 1 && (
								<div className="row">
									<span className="grow label">{pending.length} pending actions</span>
									<button className="btn signal small" onClick={approveAll}>
										Approve all
									</button>
								</div>
							)}
							{pending.map((a) => (
								<ActionCard key={a.id} a={a} icon={icon(a.gatekeeper)} who={a.requestedBy.name} busy={busy === a.id} onDecide={(ok) => decide(a, ok)} />
							))}
							{pending.length === 0 && requests.length === 0 && proposals.length === 0 && <div className="empty-state">Nothing waiting on you. ✓</div>}
						</>
					)}
					{tab === "history" && (decided.length ? decided.map((a) => <ActionCard key={a.id} a={a} icon={icon(a.gatekeeper)} who={a.requestedBy.name} />) : <div className="empty-state">No decisions yet.</div>)}
					{tab === "audit" && (
						<div className="card mono" style={{ fontSize: 11.5, padding: 10 }}>
							{docs.audit.lines.length === 0 && <span className="muted">Every Gatekeeper call is logged here.</span>}
							{[...docs.audit.lines].reverse().map((l, i) => (
								<div key={i} style={{ padding: "3px 0", borderBottom: "1px solid var(--paper-2)" }}>
									<span className="muted">{new Date(l.at).toLocaleTimeString()}</span> {l.gatekeeper}.{l.method} <span className={`pill ${l.outcome === "ok" ? "ok" : l.outcome === "queued" ? "signal" : ""}`}>{l.outcome}</span> <span className="muted">by {l.by}</span>
									{l.detail && <div className="muted">{l.detail}</div>}
								</div>
							))}
						</div>
					)}
					{tab === "outbox" && (
						<>
							<div className="muted" style={{ fontSize: 13 }}>
								Messages “delivered” by the local mailbox Gatekeeper after approval.
							</div>
							{docs.mailbox.sent.length === 0 && <div className="empty-state">Empty.</div>}
							{[...docs.mailbox.sent].reverse().map((m) => (
								<div key={m.id} className="action">
									<div className="sum">{m.subject}</div>
									<div className="meta">
										to {m.to} · {timeAgo(m.sentAt)}
									</div>
									<pre>{m.body}</pre>
								</div>
							))}
						</>
					)}
				</div>
				<div style={{ padding: "8px 18px 14px", borderTop: "1px solid var(--line)" }} className="muted">
					<span style={{ fontSize: 12 }}>
						Introduce resources from a chat's <b>🔑 Resources</b> button or a gadget's <b>Access</b> tab. <a href={chatHref(ws.id)}>New chat</a>
					</span>
				</div>
			</div>
		</>
	);
}

function ActionCard({ a, icon, who, busy, onDecide }: { a: ApprovalAction; icon: string; who: string; busy?: boolean; onDecide?: (approve: boolean) => void }) {
	const [show, setShow] = useState(false);
	return (
		<div className="action">
			<span className={`stamp ${a.status}`}>{a.status}</span>
			<div className="sum" style={{ paddingRight: 90 }}>
				{icon} {a.summary}
			</div>
			<div className="meta">
				{a.gatekeeper}:{a.resource} · {a.method} · by {who} · {timeAgo(a.createdAt)}
				{a.decidedBy ? ` · ${a.status} by ${a.decidedBy}` : ""}
			</div>
			<pre>{JSON.stringify(a.args, null, 2)}</pre>
			{a.error && <div className="err" style={{ marginBottom: 8 }}>{a.error}</div>}
			{show && a.result !== undefined && <pre>{JSON.stringify(a.result, null, 2)}</pre>}
			<div className="row">
				{onDecide && (
					<>
						<button className="btn primary small" disabled={busy} onClick={() => onDecide(true)}>
							Approve
						</button>
						<button className="btn small" disabled={busy} onClick={() => onDecide(false)}>
							Reject
						</button>
					</>
				)}
				{a.result !== undefined && (
					<button className="btn ghost small" onClick={() => setShow(!show)}>
						{show ? "Hide" : "Show"} result
					</button>
				)}
			</div>
		</div>
	);
}
