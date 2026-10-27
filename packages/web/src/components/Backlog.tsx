import "../backlog.css";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { api, type AgentRecord, type Backlog, type BacklogItem, type Feedback, type ItemStatus, type Question } from "../api";
import { timeAgo } from "../store";
import { Markdown } from "./bits";

const COLUMNS: { id: ItemStatus; label: string }[] = [
	{ id: "todo", label: "To do" },
	{ id: "doing", label: "In progress" },
	{ id: "review", label: "Review" },
	{ id: "done", label: "Done" },
];
const STATUS_LABEL: Record<ItemStatus, string> = { todo: "To do", doing: "In progress", review: "Review", done: "Done", blocked: "Blocked" };
const FEATURE_COLORS = ["#7c3aed", "#3b82f6", "#16a34a", "#a855f7", "#d97706", "#0891b2", "#db2777", "#65a30d", "#7c3aed", "#dc2626", "#0d9488", "#ca8a04"];

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

export function BacklogTab({ wsId, missionId, backlog, agents, canEdit, blockers = [], feedback = {}, gatesLeft = [] }: { wsId: string; missionId: string; backlog: Backlog; agents: AgentRecord[]; canEdit: boolean; blockers?: Question[]; feedback?: Record<string, Feedback>; gatesLeft?: string[] }) {
	const ctx = useBacklogCtx(backlog);
	const [view, setView] = useState<"board" | "structure">("board");
	const [filter, setFilter] = useState<string>();
	const [open, setOpen] = useState<string>();
	const base = `/api/w/${wsId}/missions/${missionId}/backlog`;
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
			<ApprovalBar base={base} backlog={backlog} canEdit={canEdit} blockers={blockers} gatesLeft={gatesLeft} />
			{backlog.approval.status === "approved" && <PendingBar base={base} backlog={backlog} canEdit={canEdit} blockers={blockers} feedback={feedback} onOpen={setOpen} />}
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

			{open && backlog.items[open] && <ItemPanel key={open} item={backlog.items[open]!} ctx={ctx} agents={agents} canEdit={canEdit} feedback={feedback} onPatch={(p) => patch(open, p)} onDelete={async () => {
				const n = Object.values(backlog.items).filter((i) => i.parent === open).length;
				if (!confirm(`Remove ${open}${n ? " and everything under it" : ""}?`)) return;
				await api.del(`${base}/${open}`).catch((e) => alert(e.message));
				setOpen(undefined);
			}} onOpen={setOpen} onClose={() => setOpen(undefined)} />}
		</div>
	);
}

/** "Not ready" note: open blocking questions hold every approval to build. */
function Blockers({ blockers }: { blockers: Question[] }) {
	if (!blockers.length) return null;
	return (
		<div className="bl-blockers">
			<b>Not ready to build:</b> {blockers.length} blocking question{blockers.length === 1 ? " is" : "s are"} open. Answer or dismiss {blockers.length === 1 ? "it" : "them"} on the Overview tab first.
			<ul>
				{blockers.map((q) => (
					<li key={q.id}>
						<span className="mono">@{q.agent}</span> {q.text.length > 140 ? `${q.text.slice(0, 139)}…` : q.text}
					</li>
				))}
			</ul>
		</div>
	);
}

function ApprovalBar({ base, backlog, canEdit, blockers, gatesLeft }: { base: string; backlog: Backlog; canEdit: boolean; blockers: Question[]; gatesLeft: string[] }) {
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
						<button className="btn primary small" disabled={busy || blockers.length > 0 || gatesLeft.length > 0} onClick={() => act("approve", {})} title={gatesLeft.length ? `Approve the ${gatesLeft.join(" and the ")} first` : blockers.length ? "Blocking questions are open" : undefined}>
							Approve backlog
						</button>
					</div>
				)}
			</div>
			{gatesLeft.length > 0 && (
				<div className="bl-blockers">
					<b>Approve the {gatesLeft.join(" and the ")} first</b> (on {gatesLeft.length === 1 ? "its tab" : "their tabs"}): the backlog is planned from {gatesLeft.length === 1 ? "it" : "them"}.
				</div>
			)}
			<Blockers blockers={blockers} />
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

/**
 * After approval: items the team drafted from feedback (or added since) wait here for the user's
 * approval, grouped by feedback. outpost builds none of them before that.
 */
function PendingBar({ base, backlog, canEdit, blockers, feedback, onOpen }: { base: string; backlog: Backlog; canEdit: boolean; blockers: Question[]; feedback: Record<string, Feedback>; onOpen: (id: string) => void }) {
	const [busy, setBusy] = useState(false);
	const [changes, setChanges] = useState<string | null>(null);
	const [comment, setComment] = useState("");
	const pending = Object.values(backlog.items)
		.filter((i) => i.pending)
		.sort(byOrder);
	if (!pending.length) return null;
	const groups = new Map<string, BacklogItem[]>();
	for (const i of pending) groups.set(i.feedback ?? "", [...(groups.get(i.feedback ?? "") ?? []), i]);
	const act = async (path: string, body: object) => {
		setBusy(true);
		try {
			await api.post(`${base}/${path}`, body);
			setChanges(null);
			setComment("");
		} catch (e: any) {
			alert(e.message);
		} finally {
			setBusy(false);
		}
	};
	const r = backlog.pendingRequest;
	return (
		<div className="bl-approval pending bl-pending">
			<div className="bl-ap-main">
				<div>
					<b>
						{pending.length} new item{pending.length === 1 ? "" : "s"} waiting for your approval
					</b>
					{r ? (
						<span className="muted">
							{" "}
							· {r.requestedBy} {timeAgo(r.requestedAt)}
						</span>
					) : (
						<span className="muted"> · the team is still drafting</span>
					)}
					{r?.summary && <div className="bl-ap-summary">{r.summary}</div>}
				</div>
			</div>
			{[...groups].map(([fb, items]) => (
				<div key={fb || "-"} className="pd-group">
					<div className="pd-head">
						{fb ? (
							<>
								<span className="kc-fb mono">{fb}</span>
								<span className="pd-fb">{feedback[fb]?.text ?? ""}</span>
							</>
						) : (
							<span className="pd-fb muted">Added after the backlog was approved</span>
						)}
						{canEdit && (
							<span className="pd-actions">
								<button className="btn small" disabled={busy} onClick={() => setChanges(fb)}>
									Request changes
								</button>
								<button className="btn primary small" disabled={busy || blockers.length > 0} title={blockers.length ? "Blocking questions are open" : undefined} onClick={() => act("approve-pending", fb ? { feedback: fb } : {})}>
									Approve{groups.size > 1 ? " these" : ""}
								</button>
							</span>
						)}
					</div>
					<div className="pd-items">
						{items.map((i) => (
							<button key={i.id} className="ip-link mono" onClick={() => onOpen(i.id)}>
								{i.id} <span>{i.title}</span>
							</button>
						))}
					</div>
					{changes === fb && (
						<form
							className="bl-ap-changes"
							onSubmit={(e) => {
								e.preventDefault();
								if (comment.trim()) act("pending-changes", { comment, ...(fb ? { feedback: fb } : {}) });
							}}
						>
							<textarea className="input" rows={2} autoFocus placeholder="What should change?" value={comment} onChange={(e) => setComment(e.target.value)} />
							<div className="row" style={{ justifyContent: "flex-end" }}>
								<button type="button" className="btn ghost small" onClick={() => setChanges(null)}>
									Cancel
								</button>
								<button className="btn primary small" disabled={busy || !comment.trim()}>
									Send to the team
								</button>
							</div>
						</form>
					)}
				</div>
			))}
			<Blockers blockers={blockers} />
		</div>
	);
}

/** After approval: the build's progress and its pause switch (outpost's scheduler runs it). */
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
							{tasks.some((t) => t.checks?.status === "running") && ` · ${tasks.filter((t) => t.checks?.status === "running").length} testing`}
							{tasks.some((t) => t.pending) && ` · ${tasks.filter((t) => t.pending).length} waiting for approval`}
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

const CHECK_LABEL = { running: "testing", passed: "tests pass", failed: "tests fail", skipped: "no tests" } as const;
function CheckChip({ c }: { c: NonNullable<BacklogItem["checks"]> }) {
	const label = c.status === "running" && c.stage === "merge" ? "testing merge" : CHECK_LABEL[c.status];
	return (
		<span className={`kc-check mono ${c.status}`} title={`${c.stage === "merge" ? "Merge result" : "Submitted commit"}: ${label}${c.reason ? ` (${c.reason})` : ""}${c.command ? ` · ${c.command}` : ""}`}>
			{c.status === "running" ? "◌" : c.status === "passed" ? "✓" : c.status === "failed" ? "✗" : "–"} {label}
		</span>
	);
}

/**
 * One line of card text. At rest it's clipped with an ellipsis; while the card is hovered, text that
 * doesn't fit scrolls to its end and back (pausing at each end), like a ticker.
 */
function Marquee({ className, title, children }: { className?: string; title?: string; children: React.ReactNode }) {
	const ref = useRef<HTMLSpanElement>(null);
	const [overflow, setOverflow] = useState(0);
	useLayoutEffect(() => {
		const el = ref.current;
		if (!el) return;
		const measure = () => {
			const d = el.scrollWidth - el.clientWidth;
			setOverflow(d > 2 ? d : 0);
		};
		measure();
		const ro = new ResizeObserver(measure);
		ro.observe(el);
		return () => ro.disconnect();
	}, [children]);
	return (
		<span
			ref={ref}
			className={`mq ${overflow ? "over" : ""} ${className ?? ""}`}
			title={title ?? (typeof children === "string" ? children : undefined)}
			// ~45 px/s, plus the pauses at both ends (the keyframes hold 20% of the time at each end).
			style={overflow ? ({ "--mq-shift": `-${overflow}px`, "--mq-dur": `${(overflow / 45 / 0.6).toFixed(2)}s` } as React.CSSProperties) : undefined}
		>
			<span className="mq-in">{children}</span>
		</span>
	);
}

function TaskCard({ t, ctx, canEdit, onOpen }: { t: BacklogItem; ctx: Ctx; canEdit: boolean; onOpen: () => void }) {
	const f = ctx.featureOf(t);
	const p = ctx.pbiOf(t);
	const waiting = t.deps.filter((d) => ctx.b.items[d] && ctx.b.items[d]!.status !== "done");
	return (
		<button
			className={`kb-card ${t.status} ${t.pending || (p?.pending ?? false) ? "pending" : ""}`}
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
				{f && <Marquee className="kc-feature">{f.title}</Marquee>}
				{t.feedback && <span className="kc-fb mono" title={`From feedback ${t.feedback}`}>{t.feedback}</span>}
				{t.estimate && <span className="kc-est mono">{t.estimate}</span>}
			</div>
			<div className="kc-title">{t.title}</div>
			{p && (
				<Marquee className="kc-pbi" title={`${p.id} · ${p.title}`}>
					{p.id} · {p.title}
				</Marquee>
			)}
			{(t.pending || p?.pending) && <div className="kc-pending">waiting for your approval</div>}
			<div className="kc-foot">
				{t.deps.length > 0 && (
					<span className={`kc-deps mono ${waiting.length ? "waiting" : ""}`} title={waiting.length ? `Waiting for ${waiting.join(", ")}` : "Dependencies done"}>
						⛓ {t.deps.join(" ")}
					</span>
				)}
				{t.area && <Marquee className="kc-area mono">{t.area}</Marquee>}
				{t.status === "review" && t.reviewer ? <span className="kc-who review mono" title={`${t.reviewer} is reviewing it`}>⌕ @{t.reviewer}</span> : t.assignee && <span className="kc-who mono">@{t.assignee}</span>}
				{t.status === "review" && !t.reviewer && !t.approvedBy && t.checks?.status !== "running" && <span className="kc-who waiting mono">waiting for review</span>}
				{t.status !== "done" && t.checks && <CheckChip c={t.checks} />}
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

function ItemPanel({ item, ctx, agents, canEdit, feedback = {}, onPatch, onDelete, onOpen, onClose }: { item: BacklogItem; ctx: Ctx; agents: AgentRecord[]; canEdit: boolean; feedback?: Record<string, Feedback>; onPatch: (p: Partial<BacklogItem>) => void; onDelete: () => void; onOpen: (id: string) => void; onClose: () => void }) {
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
				{item.feedback && (
					<div className="ip-fb">
						<span className="kc-fb mono">{item.feedback}</span> {feedback[item.feedback]?.text ?? "user feedback"}
						{feedback[item.feedback]?.head && <span className="mono muted"> · on main @ {feedback[item.feedback]!.head}</span>}
					</div>
				)}
				{item.pending && <div className="ip-pending">Waiting for your approval: Outpost won't build it until you approve it on the board's approval bar.</div>}
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
				{item.type === "task" && item.context?.length ? (
					<div className="ip-section">
						<div className="label">Context in the brief</div>
						<ul className="ip-context mono">
							{item.context.map((c) => (
								<li key={c}>{c}</li>
							))}
						</ul>
					</div>
				) : null}
				{item.type === "task" && item.checks && (
					<div className="ip-section">
						<div className="label">Checks</div>
						<div className={`ip-check ${item.checks.status}`}>
							<CheckChip c={item.checks} /> <span className="mono muted">{item.checks.stage === "merge" ? "merge result" : "submitted commit"} {item.checks.commit.slice(0, 8)}</span>
							{item.checks.command && <span className="mono muted"> · {item.checks.command}</span>}
							{item.checks.ms !== undefined && <span className="mono muted"> · {(item.checks.ms / 1000).toFixed(1)} s</span>}
							{item.checks.reason && item.checks.status !== "passed" && <div className="muted">{item.checks.reason}</div>}
							{item.checks.output && (
								<details>
									<summary>Output</summary>
									<pre className="ip-output">{item.checks.output}</pre>
								</details>
							)}
						</div>
					</div>
				)}
				{item.type === "task" && item.dod && (
					<div className="ip-section">
						<div className="label">Definition of done · confirmed by {item.dod.by}</div>
						<ul className="ip-dod">
							{item.dod.items.map((d, n) => (
								<li key={n} className={d.met ? "met" : "unmet"}>
									<span>{d.met ? "✓" : "✗"}</span> {d.text}
									{d.note && <em> · {d.note}</em>}
								</li>
							))}
						</ul>
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
