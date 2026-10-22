import "../backlog.css";
import { useMemo, useState } from "react";
import { api, type AgentRecord, type Backlog, type BacklogItem, type ItemStatus } from "../api";
import { timeAgo } from "../store";
import { Markdown } from "./bits";

const COLUMNS: { id: ItemStatus; label: string }[] = [
	{ id: "todo", label: "To do" },
	{ id: "doing", label: "In progress" },
	{ id: "review", label: "Review" },
	{ id: "done", label: "Done" },
];
const STATUS_LABEL: Record<ItemStatus, string> = { todo: "To do", doing: "In progress", review: "Review", done: "Done", blocked: "Blocked" };
const FEATURE_COLORS = ["#ff5b1f", "#3b82f6", "#16a34a", "#a855f7", "#d97706", "#0891b2", "#db2777", "#65a30d", "#7c3aed", "#dc2626", "#0d9488", "#ca8a04"];

const byOrder = (a: BacklogItem, b: BacklogItem) => a.order - b.order || a.id.localeCompare(b.id, undefined, { numeric: true });

type Ctx = {
	b: Backlog;
	features: BacklogItem[];
	color: (featureId?: string) => string;
	featureOf: (i: BacklogItem) => BacklogItem | undefined;
	pbiOf: (i: BacklogItem) => BacklogItem | undefined;
	children: (id: string, type: BacklogItem["type"]) => BacklogItem[];
};

function useBacklogCtx(b: Backlog): Ctx {
	return useMemo(() => {
		const items = Object.values(b.items);
		const features = items.filter((i) => i.type === "feature").sort(byOrder);
		const colorOf = new Map(features.map((f, i) => [f.id, FEATURE_COLORS[i % FEATURE_COLORS.length]!]));
		const pbiOf = (i: BacklogItem) => (i.type === "task" && i.parent ? b.items[i.parent] : i.type === "pbi" ? i : undefined);
		const featureOf = (i: BacklogItem) => (i.type === "feature" ? i : (() => {
			const p = pbiOf(i);
			return p?.parent ? b.items[p.parent] : undefined;
		})());
		return {
			b,
			features,
			color: (f?: string) => (f && colorOf.get(f)) || "#9a917c",
			featureOf,
			pbiOf,
			children: (id: string, type: BacklogItem["type"]) => items.filter((i) => i.parent === id && i.type === type).sort(byOrder),
		};
	}, [b]);
}

export function BacklogTab({ wsId, projectId, backlog, agents, canEdit }: { wsId: string; projectId: string; backlog: Backlog; agents: AgentRecord[]; canEdit: boolean }) {
	const ctx = useBacklogCtx(backlog);
	const [view, setView] = useState<"board" | "structure">("board");
	const [filter, setFilter] = useState<string>();
	const [open, setOpen] = useState<string>();
	const base = `/api/w/${wsId}/projects/${projectId}/backlog`;
	const tasks = Object.values(backlog.items).filter((i) => i.type === "task");
	const visible = tasks.filter((t) => !filter || ctx.featureOf(t)?.id === filter);
	const done = tasks.filter((t) => t.status === "done").length;

	if (!Object.keys(backlog.items).length)
		return (
			<div className="ph-empty">
				<div className="ph-icon">▤</div>
				<div className="ph-etitle">Backlog</div>
				<p>The planner builds the backlog here: features → PBIs with acceptance criteria → tasks. You review it as a board and approve it before building starts.</p>
			</div>
		);

	const patch = (id: string, p: Partial<BacklogItem>) => api.patch(`${base}/${id}`, p).catch((e) => alert(e.message));
	const columns = tasks.some((t) => t.status === "blocked") ? [...COLUMNS, { id: "blocked" as ItemStatus, label: "Blocked" }] : COLUMNS;

	return (
		<div className="bl">
			<ApprovalBar base={base} backlog={backlog} canEdit={canEdit} />
			<div className="bl-toolbar">
				<div className="bl-seg" role="tablist">
					<button className={view === "board" ? "on" : ""} onClick={() => setView("board")}>
						Board
					</button>
					<button className={view === "structure" ? "on" : ""} onClick={() => setView("structure")}>
						Structure
					</button>
				</div>
				<div className="bl-features">
					<button className={`bl-chip ${!filter ? "on" : ""}`} onClick={() => setFilter(undefined)}>
						All features
					</button>
					{ctx.features.map((f) => (
						<button key={f.id} className={`bl-chip ${filter === f.id ? "on" : ""}`} style={{ ["--fc" as any]: ctx.color(f.id) }} onClick={() => setFilter(filter === f.id ? undefined : f.id)} title={f.title}>
							<i />
							{f.id} {f.title}
						</button>
					))}
				</div>
				<div className="bl-count mono">
					{done}/{tasks.length} tasks done
				</div>
			</div>

			{view === "board" ? (
				<div className="kb" style={{ gridTemplateColumns: `repeat(${columns.length}, minmax(200px, 1fr))` }}>
					{columns.map((col) => {
						const cards = visible.filter((t) => t.status === col.id).sort(byOrder);
						return (
							<div
								key={col.id}
								className={`kb-col kb-${col.id}`}
								onDragOver={(e) => canEdit && e.dataTransfer.types.includes("text/x-backlog") && (e.preventDefault(), e.currentTarget.classList.add("over"))}
								onDragLeave={(e) => e.currentTarget.classList.remove("over")}
								onDrop={(e) => {
									e.currentTarget.classList.remove("over");
									const id = e.dataTransfer.getData("text/x-backlog");
									if (id && backlog.items[id]?.status !== col.id) patch(id, { status: col.id });
								}}
							>
								<div className="kb-head">
									<span>{col.label}</span>
									<span className="mono">{cards.length}</span>
								</div>
								<div className="kb-cards">
									{cards.map((t) => (
										<TaskCard key={t.id} t={t} ctx={ctx} canEdit={canEdit} onOpen={() => setOpen(t.id)} />
									))}
									{!cards.length && <div className="kb-empty">{canEdit ? "Drop tasks here" : "—"}</div>}
								</div>
							</div>
						);
					})}
				</div>
			) : (
				<Structure ctx={ctx} filter={filter} onOpen={setOpen} />
			)}

			{open && backlog.items[open] && <ItemPanel key={open} item={backlog.items[open]!} ctx={ctx} agents={agents} canEdit={canEdit} onPatch={(p) => patch(open, p)} onDelete={async () => {
				const n = Object.values(backlog.items).filter((i) => i.parent === open).length;
				if (!confirm(`Remove ${open}${n ? " and everything under it" : ""}?`)) return;
				await api.del(`${base}/${open}`).catch((e) => alert(e.message));
				setOpen(undefined);
			}} onOpen={setOpen} onClose={() => setOpen(undefined)} />}
		</div>
	);
}

function ApprovalBar({ base, backlog, canEdit }: { base: string; backlog: Backlog; canEdit: boolean }) {
	const a = backlog.approval;
	const [changes, setChanges] = useState(false);
	const [comment, setComment] = useState("");
	const [busy, setBusy] = useState(false);
	const act = async (path: string, body: object) => {
		setBusy(true);
		try {
			await api.post(`${base}/${path}`, body);
			setChanges(false);
			setComment("");
		} catch (e: any) {
			alert(e.message);
		} finally {
			setBusy(false);
		}
	};
	if (a.status === "approved") return <BuildBar base={base} backlog={backlog} canEdit={canEdit} />;
	if (a.status === "changes")
		return (
			<div className="bl-approval changes">
				<b>Changes requested</b> by {a.decidedBy}: “{a.comment}” <span className="muted">— the team is revising</span>
			</div>
		);
	if (a.status === "draft") return <div className="bl-approval draft">Draft — the team is still planning. You'll be asked to approve it here.</div>;
	return (
		<div className="bl-approval pending">
			<div className="bl-ap-main">
				<div>
					<b>Waiting for your approval</b>
					<span className="muted"> · {a.requestedBy} {a.requestedAt ? timeAgo(a.requestedAt) : ""}</span>
					{a.summary && <div className="bl-ap-summary">{a.summary}</div>}
				</div>
				{canEdit && !changes && (
					<div className="bl-ap-actions">
						<button className="btn small" disabled={busy} onClick={() => setChanges(true)}>
							Request changes
						</button>
						<button className="btn primary small" disabled={busy} onClick={() => act("approve", {})}>
							Approve backlog
						</button>
					</div>
				)}
			</div>
			{changes && (
				<form
					className="bl-ap-changes"
					onSubmit={(e) => {
						e.preventDefault();
						if (comment.trim()) act("changes", { comment });
					}}
				>
					<textarea className="input" rows={3} autoFocus placeholder="What should change? e.g. Drop F8 Reports; split T12; T5 must come before T3…" value={comment} onChange={(e) => setComment(e.target.value)} />
					<div className="row" style={{ justifyContent: "flex-end" }}>
						<button type="button" className="btn ghost small" onClick={() => setChanges(false)}>
							Cancel
						</button>
						<button className="btn primary small" disabled={busy || !comment.trim()}>
							Send to the team
						</button>
					</div>
				</form>
			)}
		</div>
	);
}

/** After approval: the build's progress and its pause switch (pi-os's scheduler runs it). */
function BuildBar({ base, backlog, canEdit }: { base: string; backlog: Backlog; canEdit: boolean }) {
	const [busy, setBusy] = useState(false);
	const a = backlog.approval;
	const b = backlog.build ?? {};
	const tasks = Object.values(backlog.items).filter((i) => i.type === "task");
	const n = (s: ItemStatus) => tasks.filter((t) => t.status === s).length;
	const done = n("done");
	const state = b.finishedAt ? "done" : b.paused ? "paused" : "running";
	const toggle = async () => {
		setBusy(true);
		try {
			await api.post(base.replace(/\/backlog$/, "/build"), { paused: !b.paused });
		} catch (e: any) {
			alert(e.message);
		} finally {
			setBusy(false);
		}
	};
	return (
		<div className={`bl-build ${state}`}>
			<div className="bb-main">
				<span className="bb-state">
					<i />
					{state === "done" ? "Build complete" : state === "paused" ? "Build paused" : "Building"}
				</span>
				<span className="bb-counts mono">
					{state === "done" ? (
						`all ${tasks.length} tasks merged`
					) : (
						<>
							{n("doing")} in progress · {n("review")} in review
							{n("blocked") > 0 && <b className="bb-blocked"> · {n("blocked")} blocked</b>} · {done}/{tasks.length} merged
						</>
					)}
				</span>
				<span className="grow" />
				<span className="bb-approved">
					✓ approved by {a.decidedBy} {a.decidedAt ? timeAgo(a.decidedAt) : ""}
				</span>
				{canEdit && state !== "done" && (
					<button className="btn small" disabled={busy} onClick={toggle} title={b.paused ? "Hand out tasks again" : "Stop handing out new tasks; work in progress continues"}>
						{b.paused ? "Resume build" : "Pause build"}
					</button>
				)}
			</div>
			<div className="bb-bar" aria-hidden>
				<span className="bb-done" style={{ width: `${tasks.length ? (done / tasks.length) * 100 : 0}%` }} />
				<span className="bb-review" style={{ width: `${tasks.length ? (n("review") / tasks.length) * 100 : 0}%` }} />
				<span className="bb-doing" style={{ width: `${tasks.length ? (n("doing") / tasks.length) * 100 : 0}%` }} />
			</div>
		</div>
	);
}

function TaskCard({ t, ctx, canEdit, onOpen }: { t: BacklogItem; ctx: Ctx; canEdit: boolean; onOpen: () => void }) {
	const f = ctx.featureOf(t);
	const p = ctx.pbiOf(t);
	const waiting = t.deps.filter((d) => ctx.b.items[d] && ctx.b.items[d]!.status !== "done");
	return (
		<button
			className={`kb-card ${t.status}`}
			style={{ ["--fc" as any]: ctx.color(f?.id) }}
			draggable={canEdit}
			onDragStart={(e) => {
				e.dataTransfer.setData("text/x-backlog", t.id);
				e.dataTransfer.effectAllowed = "move";
			}}
			onClick={onOpen}
		>
			<div className="kc-top">
				<span className="kc-id mono">{t.id}</span>
				{f && <span className="kc-feature">{f.title}</span>}
				{t.estimate && <span className="kc-est mono">{t.estimate}</span>}
			</div>
			<div className="kc-title">{t.title}</div>
			{p && <div className="kc-pbi">{p.id} · {p.title}</div>}
			<div className="kc-foot">
				{t.deps.length > 0 && (
					<span className={`kc-deps mono ${waiting.length ? "waiting" : ""}`} title={waiting.length ? `Waiting for ${waiting.join(", ")}` : "Dependencies done"}>
						⛓ {t.deps.join(" ")}
					</span>
				)}
				{t.area && <span className="kc-area mono" title={t.area}>{t.area}</span>}
				{t.status === "review" && t.reviewer ? <span className="kc-who review mono" title={`${t.reviewer} is reviewing it`}>⌕ @{t.reviewer}</span> : t.assignee && <span className="kc-who mono">@{t.assignee}</span>}
				{t.status === "review" && !t.reviewer && <span className="kc-who waiting mono">waiting for review</span>}
			</div>
		</button>
	);
}

function Structure({ ctx, filter, onOpen }: { ctx: Ctx; filter?: string; onOpen: (id: string) => void }) {
	const loosePbis = Object.values(ctx.b.items).filter((i) => i.type === "pbi" && (!i.parent || !ctx.b.items[i.parent])).sort(byOrder);
	const features = ctx.features.filter((f) => !filter || f.id === filter);
	const pbi = (p: BacklogItem) => {
		const tasks = ctx.children(p.id, "task");
		return (
			<div key={p.id} className="st-pbi">
				<button className="st-pbi-head" onClick={() => onOpen(p.id)}>
					<span className="mono st-id">{p.id}</span>
					<span className="st-title">{p.title}</span>
					<span className="st-progress mono">
						{tasks.filter((t) => t.status === "done").length}/{tasks.length}
					</span>
				</button>
				{p.description && <div className="st-desc">{p.description}</div>}
				{p.acceptance?.length ? (
					<ul className="st-ac">
						{p.acceptance.map((c, i) => (
							<li key={i}>{c}</li>
						))}
					</ul>
				) : null}
				{tasks.length > 0 && (
					<table className="st-tasks">
						<tbody>
							{tasks.map((t) => (
								<tr key={t.id} onClick={() => onOpen(t.id)}>
									<td className="mono st-id">{t.id}</td>
									<td>{t.title}</td>
									<td>
										<span className={`st-status ${t.status}`}>{STATUS_LABEL[t.status]}</span>
									</td>
									<td className="mono muted">{t.estimate ?? ""}</td>
									<td className="mono muted">{t.deps.length ? `after ${t.deps.join(", ")}` : ""}</td>
									<td className="mono muted">{t.assignee ? `@${t.assignee}` : ""}</td>
								</tr>
							))}
						</tbody>
					</table>
				)}
			</div>
		);
	};
	return (
		<div className="st">
			{features.map((f) => (
				<section key={f.id} className="st-feature" style={{ ["--fc" as any]: ctx.color(f.id) }}>
					<button className="st-feature-head" onClick={() => onOpen(f.id)}>
						<span className="mono st-id">{f.id}</span>
						<h3>{f.title}</h3>
					</button>
					{f.description && <div className="st-desc">{f.description}</div>}
					{ctx.children(f.id, "pbi").map(pbi)}
				</section>
			))}
			{!filter && loosePbis.length > 0 && (
				<section className="st-feature">
					<div className="st-feature-head">
						<h3>PBIs without a feature</h3>
					</div>
					{loosePbis.map(pbi)}
				</section>
			)}
		</div>
	);
}

function ItemPanel({ item, ctx, agents, canEdit, onPatch, onDelete, onOpen, onClose }: { item: BacklogItem; ctx: Ctx; agents: AgentRecord[]; canEdit: boolean; onPatch: (p: Partial<BacklogItem>) => void; onDelete: () => void; onOpen: (id: string) => void; onClose: () => void }) {
	const [title, setTitle] = useState(item.title);
	const [desc, setDesc] = useState(item.description ?? "");
	const [ac, setAc] = useState((item.acceptance ?? []).join("\n"));
	const [editingDesc, setEditingDesc] = useState(false);
	const f = ctx.featureOf(item);
	const p = item.type === "task" ? ctx.pbiOf(item) : undefined;
	const kids = item.type === "feature" ? ctx.children(item.id, "pbi") : item.type === "pbi" ? ctx.children(item.id, "task") : [];
	const dependents = Object.values(ctx.b.items).filter((i) => i.deps.includes(item.id));
	const typeLabel = { feature: "Feature", pbi: "Product backlog item", task: "Task" }[item.type];
	const link = (id: string) => (
		<button key={id} className="ip-link mono" onClick={() => onOpen(id)} title={ctx.b.items[id]?.title}>
			{id} <span>{ctx.b.items[id]?.title}</span> {ctx.b.items[id] && <em className={`st-status ${ctx.b.items[id]!.status}`}>{STATUS_LABEL[ctx.b.items[id]!.status]}</em>}
		</button>
	);
	return (
		<aside className="ip" style={{ ["--fc" as any]: ctx.color(f?.id) }}>
			<header className="ip-head">
				<span className="mono">
					{typeLabel} · {item.id}
				</span>
				<span className="grow" />
				{canEdit && (
					<button className="btn ghost small" onClick={onDelete}>
						Delete
					</button>
				)}
				<button className="btn ghost small" onClick={onClose} aria-label="Close">
					✕
				</button>
			</header>
			<div className="ip-body">
				{(f || p) && (
					<div className="ip-crumbs">
						{f && f.id !== item.id && link(f.id)}
						{p && link(p.id)}
					</div>
				)}
				<textarea className="ip-title" rows={2} value={title} disabled={!canEdit} onChange={(e) => setTitle(e.target.value)} onBlur={() => title.trim() && title !== item.title && onPatch({ title: title.trim() })} />
				<div className="ip-grid">
					<label>Status</label>
					<select className="input" value={item.status} disabled={!canEdit} onChange={(e) => onPatch({ status: e.target.value as ItemStatus })}>
						{(["todo", "doing", "review", "done", "blocked"] as ItemStatus[]).map((s) => (
							<option key={s} value={s}>
								{STATUS_LABEL[s]}
							</option>
						))}
					</select>
					{item.type === "task" && (
						<>
							<label>Assignee</label>
							<select className="input" value={item.assignee ?? ""} disabled={!canEdit} onChange={(e) => onPatch({ assignee: e.target.value })}>
								<option value="">Unassigned</option>
								{agents.map((a) => (
									<option key={a.key} value={a.key}>
										{a.name} (@{a.key})
									</option>
								))}
							</select>
							<label>Estimate</label>
							<select className="input" value={item.estimate ?? ""} disabled={!canEdit} onChange={(e) => onPatch({ estimate: (e.target.value || undefined) as any })}>
								<option value="">—</option>
								<option value="S">S</option>
								<option value="M">M</option>
								<option value="L">L</option>
							</select>
							{item.area && (
								<>
									<label>Area</label>
									<span className="mono ip-area">{item.area}</span>
								</>
							)}
						</>
					)}
				</div>

				<div className="ip-section">
					<div className="label">Description</div>
					{editingDesc && canEdit ? (
						<textarea className="input" rows={8} autoFocus value={desc} onChange={(e) => setDesc(e.target.value)} onBlur={() => (setEditingDesc(false), desc !== (item.description ?? "") && onPatch({ description: desc }))} />
					) : (
						<div className={`ip-desc ${canEdit ? "editable" : ""}`} onClick={() => canEdit && setEditingDesc(true)} title={canEdit ? "Click to edit" : undefined}>
							{item.description ? <Markdown text={item.description} /> : <span className="muted">{canEdit ? "Add a description…" : "No description"}</span>}
						</div>
					)}
				</div>

				{(item.type === "pbi" || p?.acceptance?.length) && (
					<div className="ip-section">
						<div className="label">Acceptance criteria{p ? ` (from ${p.id})` : ""}</div>
						{item.type === "pbi" && canEdit ? (
							<textarea className="input" rows={Math.max(3, (item.acceptance?.length ?? 0) + 1)} value={ac} placeholder="One criterion per line" onChange={(e) => setAc(e.target.value)} onBlur={() => {
								const next = ac.split("\n").map((s) => s.trim()).filter(Boolean);
								if (next.join("\n") !== (item.acceptance ?? []).join("\n")) onPatch({ acceptance: next });
							}} />
						) : (
							<ul className="st-ac">
								{(item.type === "pbi" ? item.acceptance : p?.acceptance)?.map((c, i) => (
									<li key={i}>{c}</li>
								))}
							</ul>
						)}
					</div>
				)}

				{item.deps.length > 0 && (
					<div className="ip-section">
						<div className="label">Depends on</div>
						{item.deps.map(link)}
					</div>
				)}
				{dependents.length > 0 && (
					<div className="ip-section">
						<div className="label">Blocks</div>
						{dependents.map((d) => link(d.id))}
					</div>
				)}
				{kids.length > 0 && (
					<div className="ip-section">
						<div className="label">{item.type === "feature" ? "PBIs" : "Tasks"}</div>
						{kids.map((k) => link(k.id))}
					</div>
				)}
				{item.type === "task" && (item.submitted || item.merged) && (
					<div className="ip-section">
						<div className="label">Work</div>
						<div className="ip-work">
							{item.submitted && (
								<div>
									<span className="mono muted">submitted {item.submitted.commit.slice(0, 8)} by @{item.submitted.by} · {timeAgo(item.submitted.at)}</span>
									<div className="ip-work-summary">{item.submitted.summary}</div>
									{item.submitted.files.length > 0 && <div className="ip-files mono">{item.submitted.files.join(" · ")}</div>}
								</div>
							)}
							{item.reviewer && item.status === "review" && <div className="mono">under review by @{item.reviewer} (round {item.reviewRound ?? 1})</div>}
							{item.merged && <div className="mono ip-merged">✓ merged into main as {item.merged}</div>}
						</div>
					</div>
				)}
				{item.history?.length ? (
					<div className="ip-section">
						<div className="label">History</div>
						<ol className="ip-history">
							{[...item.history].reverse().map((h, i) => (
								<li key={i}>
									<span className="mono muted">{timeAgo(h.at)}</span>
									<span>
										<b>{h.by}</b> {h.text}
									</span>
								</li>
							))}
						</ol>
					</div>
				) : null}
				<div className="ip-meta mono">
					created by @{item.createdBy} · updated {timeAgo(item.updatedAt)}
				</div>
			</div>
		</aside>
	);
}
