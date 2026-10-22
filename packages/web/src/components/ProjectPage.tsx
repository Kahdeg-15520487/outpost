import "../project.css";
import "../project-layout.css";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api, type AgentRecord, type AgentSummary, type ModelInfo, type ModelRef, type ProjectMeta, type ProjectStage, type Question, type Workspace } from "../api";
import { navigate, projectHref, timeAgo, useChat, useProject } from "../store";
import { Dialog, Markdown, colorFor } from "./bits";
import { AttachButton, AttachmentTray, FileChips, pasteInto, Transcript, useAttachments, type Attachments } from "./Chat";
import { ModelSelect, pickerShows, type ModelPicker } from "./ModelPicker";
import { BacklogTab } from "./Backlog";

const STAGES: { id: ProjectStage; label: string }[] = [
	{ id: "kickoff", label: "Kickoff" },
	{ id: "discovery", label: "Requirements" },
	{ id: "design", label: "Design" },
	{ id: "planning", label: "Backlog" },
	{ id: "build", label: "Build" },
	{ id: "iterate", label: "Iterate" },
];

const ROLE_COLORS: Record<string, string> = {
	lead: "#ff5b1f",
	"product-owner": "#a78bfa",
	architect: "#60a5fa",
	planner: "#2dd4bf",
	worker: "#4ade80",
	reviewer: "#fbbf24",
	designer: "#f472b6",
};
const roleColor = (a: AgentRecord) => ROLE_COLORS[a.role] ?? colorFor(a.role);
const roleTitle = (role: string) => ({ lead: "Lead", "product-owner": "Product Owner", architect: "Architect", planner: "Planner", worker: "Developer", reviewer: "Reviewer", designer: "UX Designer" })[role] ?? role.replace(/(^|-)(\w)/g, (_m, s, c) => `${s ? " " : ""}${c.toUpperCase()}`);
const initials = (name: string) =>
	name
		.split(/\s+/)
		.map((w) => w[0])
		.join("")
		.slice(0, 2)
		.toUpperCase();
/** Drag files onto a form to attach them. */
const dropFiles = (att: Attachments) => ({
	onDragOver: (e: React.DragEvent) => e.dataTransfer.types.includes("Files") && e.preventDefault(),
	onDrop: (e: React.DragEvent) => {
		if (!e.dataTransfer.files.length) return;
		e.preventDefault();
		att.add([...e.dataTransfer.files]);
	},
});

const fmtTokens = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

type Tab = "overview" | "requirements" | "design" | "decisions" | "wireframes" | "backlog" | "app" | "repo";
const TABS: { id: Tab; label: string }[] = [
	{ id: "overview", label: "Overview" },
	{ id: "requirements", label: "Requirements" },
	{ id: "design", label: "Design" },
	{ id: "decisions", label: "Decisions" },
	{ id: "wireframes", label: "Wireframes" },
	{ id: "backlog", label: "Backlog" },
	{ id: "app", label: "App" },
	{ id: "repo", label: "Repo" },
];

export function ProjectPage({ ws, projectId, tab, models, picker }: { ws: Workspace; projectId: string; tab?: string; models: ModelInfo[]; picker: ModelPicker }) {
	const live = useProject(ws.id, projectId);
	const { project, state, summaries } = live;
	const [open, setOpen] = useState<string>();
	const [modelMenu, setModelMenu] = useState(false);
	// Layout: "side" = tiles around the viewer; "team" = all tiles on top, viewer below (resizable split).
	const [layout, setLayout] = useState<"side" | "team">(() => (localStorage.getItem("pios.project.layout") === "team" ? "team" : "side"));
	const [split, setSplit] = useState(() => Math.min(0.8, Math.max(0.2, Number(localStorage.getItem("pios.project.split")) || 0.5)));
	const bodyRef = useRef<HTMLDivElement>(null);
	const chooseLayout = (l: "side" | "team") => {
		setLayout(l);
		localStorage.setItem("pios.project.layout", l);
	};
	// Wide viewer: agent tiles shrink to avatars. Default on for the board and the app; remembered per tab kind.
	const [widePref, setWidePref] = useState<Record<string, boolean>>(() => {
		try {
			return JSON.parse(localStorage.getItem("pios.viewer.wide") ?? "{}");
		} catch {
			return {};
		}
	});
	const canEdit = ws.role !== "viewer";
	const agents = state.order.map((k) => state.agents[k]!).filter((a) => a && !a.removed);
	const openQuestions = Object.values(state.questions).filter((q) => !q.answeredAt);
	const asking = new Set(openQuestions.map((q) => q.agent));
	const half = Math.ceil(agents.length / 2);
	const current = (TABS.some((t) => t.id === tab) ? tab : "overview") as Tab;
	const totals = Object.values(summaries).reduce((a, s) => ({ tokens: a.tokens + (s.tokens ?? 0), cost: a.cost + (s.cost ?? 0) }), { tokens: 0, cost: 0 });
	const working = Object.values(summaries).filter((s) => s.busy).length;

	if (!project) return <div className="main project-loading">Loading project…</div>;
	const stageIdx = STAGES.findIndex((s) => s.id === project.stage);

	const wide = layout === "side" && (widePref[current] ?? (current === "backlog" || current === "app"));
	const toggleWide = () => {
		const next = { ...widePref, [current]: !wide };
		setWidePref(next);
		localStorage.setItem("pios.viewer.wide", JSON.stringify(next));
	};
	const tiles = (list: AgentRecord[]) =>
		list.map((a, i) =>
			wide ? <AgentMini key={a.key} agent={a} summary={summaries[a.key]} asking={asking.has(a.key)} onOpen={() => setOpen(a.key)} /> : <AgentTile key={a.key} agent={a} summary={summaries[a.key]} asking={asking.has(a.key)} index={i} onOpen={() => setOpen(a.key)} />,
		);

	const viewer = (
		<section className="viewer" aria-label="Artifacts">
			<nav className="viewer-tabs">
				{TABS.map((t) => (
					<a key={t.id} href={projectHref(ws.id, projectId, t.id === "overview" ? undefined : t.id)} className={current === t.id ? "on" : ""}>
						{t.label}
						{t.id === "overview" && openQuestions.length > 0 && <span className="vt-badge">{openQuestions.length}</span>}
						{t.id === "backlog" && live.backlog.approval.status === "pending" && <span className="vt-badge">!</span>}
					</a>
				))}
				<span className="grow" />
				{layout === "side" && <button className="vt-wide" onClick={toggleWide} title={wide ? "Show the agent tiles" : "Expand: shrink the agent tiles to avatars"} aria-pressed={wide}>
					{wide ? "⤡" : "⤢"}
				</button>}
			</nav>
			{live.backlog.approval.status === "pending" && current !== "backlog" && (
				<a className="viewer-ask" href={projectHref(ws.id, projectId, "backlog")}>
					<span className="va-dot" /> The backlog is waiting for your approval — open Backlog
				</a>
			)}
			{openQuestions.length > 0 && current !== "overview" && (
				<a className="viewer-ask" href={projectHref(ws.id, projectId)}>
					<span className="va-dot" /> {state.agents[openQuestions[0]!.agent]?.name ?? "An agent"} is waiting for your answer — open Overview
				</a>
			)}
			<div className="viewer-body">
				{current === "overview" && <Overview ws={ws} project={project} live={live} questions={openQuestions} canEdit={canEdit} onOpenAgent={setOpen} />}
				{current === "requirements" && <DocTab ws={ws.id} projectId={projectId} path="docs/requirements.md" tick={live.repoTick} empty="The product owner hasn't published requirements yet." />}
				{current === "design" && <DocTab ws={ws.id} projectId={projectId} path="docs/design.md" tick={live.repoTick} empty="The architect publishes the design once requirements are approved." />}
				{current === "decisions" && <DecisionsTab ws={ws.id} projectId={projectId} tick={live.repoTick} />}
				{current === "wireframes" && <WireframesTab ws={ws.id} projectId={projectId} tick={live.repoTick} />}
				{current === "backlog" && <BacklogTab wsId={ws.id} projectId={projectId} backlog={live.backlog} agents={agents} canEdit={canEdit} />}
				{current === "app" && <Placeholder icon="▶" title="Live app" text="The running product appears here once the architect defines how to run it (.pios/project.json). Live preview arrives in milestone 5." />}
				{current === "repo" && <RepoTab ws={ws.id} projectId={projectId} tick={live.repoTick} />}
			</div>
		</section>
	);

	return (
		<div className="main project">
			<header className="project-head">
				<div className="ph-title">
					<div className="ph-kicker mono">
						project · {timeAgo(project.createdAt)} ·{" "}
						<button className="ph-model" onClick={() => canEdit && setModelMenu(!modelMenu)} disabled={!canEdit} title={canEdit ? "Change the project's default model" : "The project's default model"}>
							{project.model.provider}/{project.model.modelId}
							{canEdit && " ▾"}
						</button>
					</div>
					{modelMenu && <ProjectModelMenu ws={ws} project={project} agents={agents} models={models} picker={picker} onClose={() => setModelMenu(false)} />}
					<h1 title={project.goal}>{project.name}</h1>
				</div>
				<ol className="ph-stages" aria-label="Stage">
					{STAGES.map((s, i) => (
						<li key={s.id} className={i < stageIdx ? "done" : i === stageIdx ? "now" : ""}>
							<span className="dot" />
							{s.label}
						</li>
					))}
				</ol>
				<div className="ph-meta mono">
					<span>
						<b>{working}</b>/{agents.length} working
					</span>
					<span>{fmtTokens(totals.tokens)} tok</span>
					{totals.cost > 0 && <span>${totals.cost.toFixed(totals.cost < 1 ? 3 : 2)}</span>}
				</div>
				<div className="ph-layout" role="group" aria-label="Layout">
					<button className={layout === "side" ? "on" : ""} onClick={() => chooseLayout("side")} title="Agents beside the artifact viewer" aria-pressed={layout === "side"}>
						<svg viewBox="0 0 20 14" aria-hidden>
							<rect x="0.5" y="0.5" width="4" height="13" rx="1" />
							<rect x="6" y="0.5" width="8" height="13" rx="1" className="fill" />
							<rect x="15.5" y="0.5" width="4" height="13" rx="1" />
						</svg>
						Side
					</button>
					<button className={layout === "team" ? "on" : ""} onClick={() => chooseLayout("team")} title="All agents on top, activity and artifacts below" aria-pressed={layout === "team"}>
						<svg viewBox="0 0 20 14" aria-hidden>
							<rect x="0.5" y="0.5" width="5.5" height="3.5" rx="1" />
							<rect x="7.25" y="0.5" width="5.5" height="3.5" rx="1" />
							<rect x="14" y="0.5" width="5.5" height="3.5" rx="1" />
							<rect x="0.5" y="5.5" width="19" height="8" rx="1" className="fill" />
						</svg>
						Team
					</button>
				</div>
				{canEdit && (
					<div className="ph-actions">
						<button className="btn small ph-btn" disabled={!working} onClick={() => confirm("Stop every agent's current work?") && api.post(`/api/w/${ws.id}/projects/${projectId}/stop`, {})}>
							■ Stop all
						</button>
						<button
							className="btn small ph-btn ghost"
							onClick={async () => {
								if (!confirm(`Archive "${project.name}"? Agents stop; the repo stays on disk.`)) return;
								await api.del(`/api/w/${ws.id}/projects/${projectId}`);
								navigate(`#/w/${ws.id}`);
							}}
						>
							Archive
						</button>
					</div>
				)}
			</header>

			<div
				ref={bodyRef}
				className={`project-body ${layout} ${wide ? "wide" : ""}`}
				style={layout === "team" ? { gridTemplateRows: `minmax(0, ${split}fr) 12px minmax(0, ${1 - split}fr)` } : undefined}
			>
				{layout === "side" ? (
					<>
						<TileGrid label="Agents" count={Math.max(1, half)} mini={wide}>
							{tiles(agents.slice(0, half))}
							{agents.length === 0 && <div className="tile-empty">The lead is getting ready…</div>}
						</TileGrid>
						{viewer}
						<TileGrid label="More agents" count={agents.length - half} mini={wide}>
							{tiles(agents.slice(half))}
						</TileGrid>
					</>
				) : (
					<>
						<TileGrid label="Agents" count={Math.max(1, agents.length)}>
							{tiles(agents)}
							{agents.length === 0 && <div className="tile-empty">The lead is getting ready…</div>}
						</TileGrid>
						<div
							className="splitter"
							role="separator"
							aria-orientation="horizontal"
							title="Drag to resize · double-click to reset"
							onPointerDown={(e) => {
								const body = bodyRef.current;
								if (!body) return;
								e.preventDefault();
								const rect = body.getBoundingClientRect();
								let last = split;
								const move = (ev: PointerEvent) => {
									last = Math.min(0.8, Math.max(0.2, (ev.clientY - rect.top) / rect.height));
									setSplit(last);
								};
								const up = () => {
									removeEventListener("pointermove", move);
									removeEventListener("pointerup", up);
									document.body.classList.remove("resizing-rows");
									localStorage.setItem("pios.project.split", String(last));
								};
								document.body.classList.add("resizing-rows");
								addEventListener("pointermove", move);
								addEventListener("pointerup", up);
							}}
							onDoubleClick={() => (setSplit(0.5), localStorage.setItem("pios.project.split", "0.5"))}
						>
							<span />
						</div>
						{viewer}
					</>
				)}
			</div>

			{open && state.agents[open] && <AgentDrawer ws={ws} projectId={projectId} agent={state.agents[open]!} summary={summaries[open]} questions={openQuestions.filter((q) => q.agent === open)} canEdit={canEdit} models={models} picker={picker} onClose={() => setOpen(undefined)} />}
		</div>
	);
}

// ------------------------------------------------------------------ tiles

// ------------------------------------------------------------------ tile grid

const TILE_MIN_W = 180;
const TILE_MIN_H = 150;
const TILE_GAP = 10;
/** Preferred tile shape (width / height); text reads best in slightly wide tiles. */
const TILE_ASPECT = 1.2;

/**
 * The grid of `n` tiles that fills a W×H area best: every column count is tried (tiles at least
 * TILE_MIN_W wide, TILE_MIN_H tall); the one whose tiles are largest at roughly TILE_ASPECT wins.
 * When nothing fits the height, rows get TILE_MIN_H and the area scrolls, with as few rows as fit.
 */
export function bestGrid(n: number, W: number, H: number): { cols: number; rows: number; fill: boolean } {
	if (n <= 0 || W <= 0 || H <= 0) return { cols: 1, rows: 1, fill: true };
	const maxCols = Math.max(1, Math.min(n, Math.floor((W + TILE_GAP) / (TILE_MIN_W + TILE_GAP))));
	let best: { cols: number; rows: number; fill: boolean; score: number } | undefined;
	for (let cols = 1; cols <= maxCols; cols++) {
		const rows = Math.ceil(n / cols);
		const w = (W - (cols - 1) * TILE_GAP) / cols;
		const h = (H - (rows - 1) * TILE_GAP) / rows;
		if (h < TILE_MIN_H) continue;
		// Usable area of a tile at the preferred shape, minus a little per empty cell.
		const score = Math.min(w, h * TILE_ASPECT) * Math.min(h, w / TILE_ASPECT) * (1 - (rows * cols - n) * 0.04);
		if (!best || score > best.score) best = { cols, rows, fill: true, score };
	}
	return best ?? { cols: maxCols, rows: Math.ceil(n / maxCols), fill: false };
}

/** A section of agent tiles that sizes its grid to fill the space it's given. */
function TileGrid({ label, count, mini, children }: { label: string; count: number; mini?: boolean; children: React.ReactNode }) {
	const ref = useRef<HTMLElement>(null);
	const [grid, setGrid] = useState<React.CSSProperties>();
	useLayoutEffect(() => {
		const el = ref.current;
		if (!el || mini) return setGrid(undefined);
		const fit = () => {
			// Only fill when the area has a fixed height; stacked narrow layouts just flow.
			if (getComputedStyle(el).overflowY === "visible") return setGrid(undefined);
			const pad = 4;
			const g = bestGrid(count, el.clientWidth - pad, el.clientHeight - pad);
			setGrid({ gridTemplateColumns: `repeat(${g.cols}, minmax(0, 1fr))`, gridTemplateRows: g.fill ? `repeat(${g.rows}, minmax(0, 1fr))` : `repeat(${g.rows}, ${TILE_MIN_H}px)` });
		};
		fit();
		const ro = new ResizeObserver(fit);
		ro.observe(el);
		return () => ro.disconnect();
	}, [count, mini]);
	return (
		<section ref={ref} className={`tiles ${mini ? "mini" : ""}`} aria-label={label} style={grid}>
			{children}
		</section>
	);
}

/** An agent as an avatar with a live status dot (wide viewer). */
function AgentMini({ agent, summary, asking, onOpen }: { agent: AgentRecord; summary?: AgentSummary; asking: boolean; onOpen: () => void }) {
	const s = summary ?? { busy: false, status: "idle", tail: "", tokens: 0, cost: 0, queued: 0, updatedAt: 0 };
	const state = asking && !s.busy ? "asking" : s.status === "error" ? "error" : s.busy ? "busy" : "idle";
	return (
			<button className={`agent-mini ${state}`} style={{ ["--role" as any]: roleColor(agent) }} onClick={onOpen} title={`${agent.name} (${roleTitle(agent.role)}) — ${asking && !s.busy ? "needs you" : s.busy ? (s.activity ?? s.status) : "idle"}`}>
				<span className="at-glyph">{initials(agent.name)}</span>
				<i />
			</button>
	);
}

function AgentTile({ agent, summary, asking, index, onOpen }: { agent: AgentRecord; summary?: AgentSummary; asking: boolean; index: number; onOpen: () => void }) {
	const s = summary ?? { busy: false, status: "idle", tail: "", tokens: 0, cost: 0, queued: 0, updatedAt: 0 };
	const state = asking && !s.busy ? "asking" : s.status === "error" ? "error" : s.busy ? "busy" : "idle";
	const label = asking && !s.busy ? "needs you" : s.status === "tool" ? "working" : s.status === "error" ? "error" : s.busy ? s.status : "idle";
	const tailRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (tailRef.current) tailRef.current.scrollTop = tailRef.current.scrollHeight;
	}, [s.tail]);
	return (
		<button className={`agent-tile ${state}`} style={{ ["--role" as any]: roleColor(agent), animationDelay: `${index * 50}ms` }} onClick={onOpen} title={`Open ${agent.name}'s transcript`}>
			<div className="at-head">
				<span className="at-glyph">{initials(agent.name)}</span>
				<span className="at-names">
					<span className="at-name">{agent.name}</span>
					<span className="at-role">{roleTitle(agent.role)}</span>
				</span>
			</div>
			<div className="at-status">
				<span className={`at-state ${state}`}>
					<i />
					{label}
				</span>
				<span className="at-activity mono">{s.error && state === "error" ? s.error : (s.activity ?? "")}</span>
			</div>
			<div className="at-tail" ref={tailRef}>
				{s.tail || <span className="at-muted">{s.busy ? "…" : "Waiting for work"}</span>}
			</div>
			<div className="at-foot mono">
				<span>{fmtTokens(s.tokens)} tok</span>
				{s.queued > 0 && <span>{s.queued} queued</span>}
				<span className="at-key">@{agent.key}</span>
			</div>
		</button>
	);
}

// ------------------------------------------------------------------ agent drawer

function AgentDrawer({ ws, projectId, agent, summary, questions, canEdit, models, picker, onClose }: { ws: Workspace; projectId: string; agent: AgentRecord; summary?: AgentSummary; questions: Question[]; canEdit: boolean; models: ModelInfo[]; picker: ModelPicker; onClose: () => void }) {
	const chat = useChat(ws.id, agent.conversationId);
	const att = useAttachments(ws.id);
	const [text, setText] = useState("");
	const [err, setErr] = useState("");
	const scroller = useRef<HTMLDivElement>(null);
	const pinned = useRef(true);
	useEffect(() => {
		const el = scroller.current;
		if (el && pinned.current) el.scrollTop = el.scrollHeight;
	}, [chat.entries.length, chat.live]);
	useEffect(() => {
		const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
		addEventListener("keydown", key);
		return () => removeEventListener("keydown", key);
	}, []);
	const send = async () => {
		const t = text.trim();
		if ((!t && !att.ids().length) || att.uploading) return;
		setErr("");
		try {
			await api.post(`/api/w/${ws.id}/projects/${projectId}/agents/${agent.key}/messages`, { text: t, files: att.ids() });
			setText("");
			att.clear();
		} catch (e: any) {
			setErr(e.message);
		}
	};
	return (
		<>
			<div className="scrim" onClick={onClose} />
			<aside className="agent-drawer" style={{ ["--role" as any]: roleColor(agent) }} role="dialog" aria-label={`${agent.name} transcript`}>
				<header className="ad-head">
					<span className="at-glyph">{initials(agent.name)}</span>
					<div className="grow">
						<div className="ad-name">{agent.name}</div>
						<div className="mono muted ad-sub">
							{roleTitle(agent.role)} · @{agent.key} · {fmtTokens(summary?.tokens ?? 0)} tok ·
							<ModelSelect
								className="ad-model"
								models={models}
								picker={picker}
								value={agent.model}
								disabled={!canEdit}
								onChange={(model) => api.patch(`/api/w/${ws.id}/projects/${projectId}/agents/${agent.key}`, { model }).catch((e) => alert(e.message))}
							/>
						</div>
					</div>
					{summary?.busy && canEdit && (
						<button className="btn small" onClick={() => api.post(`/api/w/${ws.id}/projects/${projectId}/stop`, {})} title="Stops every agent's current work">
							■ Stop
						</button>
					)}
					<button className="btn ghost small" onClick={onClose} aria-label="Close">
						✕
					</button>
				</header>
				<details className="ad-brief">
					<summary>Brief</summary>
					<Markdown text={agent.brief} />
				</details>
				<div
					className="ad-transcript"
					ref={scroller}
					onScroll={(e) => {
						const el = e.currentTarget;
						pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
					}}
				>
					{!chat.ready ? <div className="muted" style={{ padding: 20 }}>Loading transcript…</div> : <Transcript state={chat} wsId={ws.id} chatId={agent.conversationId} />}
				</div>
				{questions.length > 0 && (
					<div className="ad-question">
						<b>{agent.name} asks:</b> {questions.at(-1)!.text}
					</div>
				)}
				{canEdit && (
					<form
						className="ad-compose"
						{...dropFiles(att)}
						onSubmit={(e) => {
							e.preventDefault();
							send();
						}}
					>
						<div className="ad-tray">
							<AttachmentTray att={att} />
						</div>
						<textarea
							onPaste={(e) => pasteInto(e, att)}
							rows={2}
							value={text}
							placeholder={questions.length ? "Answer…" : summary?.busy ? `Steer ${agent.name}…` : `Message ${agent.name}…`}
							onChange={(e) => setText(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter" && !e.shiftKey) {
									e.preventDefault();
									send();
								}
							}}
							autoFocus
						/>
						<div className="ad-actions">
							<AttachButton att={att} />
							<button className="btn primary small" disabled={(!text.trim() && !att.ids().length) || att.uploading}>
								Send
							</button>
						</div>
						{err && <div className="err">{err}</div>}
					</form>
				)}
			</aside>
		</>
	);
}

// ------------------------------------------------------------------ project model

function ProjectModelMenu({ ws, project, agents, models, picker, onClose }: { ws: Workspace; project: ProjectMeta; agents: AgentRecord[]; models: ModelInfo[]; picker: ModelPicker; onClose: () => void }) {
	const [model, setModel] = useState<ModelRef>(project.model);
	const [all, setAll] = useState(false);
	const [busy, setBusy] = useState(false);
	const mixed = agents.filter((a) => a.model && (a.model.provider !== project.model.provider || a.model.modelId !== project.model.modelId));
	useEffect(() => {
		const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
		addEventListener("keydown", key);
		return () => removeEventListener("keydown", key);
	}, []);
	const save = async () => {
		setBusy(true);
		try {
			await api.patch(`/api/w/${ws.id}/projects/${project.id}`, { model, applyToAgents: all });
			onClose();
		} catch (e: any) {
			alert(e.message);
			setBusy(false);
		}
	};
	return (
		<div className="pm-menu" role="dialog" aria-label="Project model">
			<div className="label">Default model for this project</div>
			<ModelSelect models={models} picker={picker} value={model} onChange={setModel} />
			<label className="pm-all">
				<input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} />
				<span>
					Also switch all {agents.length} current agent{agents.length === 1 ? "" : "s"}
					<span className="muted"> — otherwise only agents added from now on{mixed.length ? `; ${mixed.length} already use${mixed.length === 1 ? "s" : ""} a different model` : ""}</span>
				</span>
			</label>
			<div className="row" style={{ justifyContent: "flex-end" }}>
				<button className="btn ghost small" onClick={onClose}>
					Cancel
				</button>
				<button className="btn primary small" disabled={busy || (!all && model.provider === project.model.provider && model.modelId === project.model.modelId)} onClick={save}>
					Save
				</button>
			</div>
			<div className="pm-hint muted">Set one agent's model in its drawer (click its tile). The lead can also pick a model per agent when it adds one.</div>
		</div>
	);
}

// ------------------------------------------------------------------ viewer tabs

function Overview({ ws, project, live, questions, canEdit, onOpenAgent }: { ws: Workspace; project: ProjectMeta; live: ReturnType<typeof useProject>; questions: Question[]; canEdit: boolean; onOpenAgent: (k: string) => void }) {
	const { state } = live;
	const activity = [...state.activity].reverse();
	const attachments = Object.values(state.attachments ?? {}).sort((a, b) => a.at - b.at);
	return (
		<div className="ov">
			<blockquote className="ov-goal">
				<div className="label">Goal</div>
				{project.goal}
			</blockquote>
			{attachments.length > 0 && (
				<div className="ov-attachments">
					<div className="label">Attachments · outside the repo, read by the team</div>
					<FileChips wsId={ws.id} files={attachments.map((a) => ({ id: a.fileId, name: a.name, kind: a.kind, mime: a.mime, size: a.size }))} />
				</div>
			)}
			{questions.length > 0 && (
				<div className="ov-questions">
					{questions.map((q) => (
						<QuestionCard key={q.id} ws={ws} projectId={project.id} q={q} agent={state.agents[q.agent]} canEdit={canEdit} onOpen={() => onOpenAgent(q.agent)} />
					))}
				</div>
			)}
			<div className="ov-activity">
				<div className="label">Activity</div>
				<ol>
					{activity.map((a, i) => {
						const ag = a.agent ? state.agents[a.agent] : undefined;
						return (
							<li key={`${a.at}-${i}`} className={`act-${a.kind}`}>
								<span className="act-dot" style={{ background: ag ? roleColor(ag) : "var(--line-2)" }} />
								<span className="act-text">{a.text}</span>
								<span className="act-at mono">{timeAgo(a.at)}</span>
							</li>
						);
					})}
				</ol>
			</div>
		</div>
	);
}

function QuestionCard({ ws, projectId, q, agent, canEdit, onOpen }: { ws: Workspace; projectId: string; q: Question; agent?: AgentRecord; canEdit: boolean; onOpen: () => void }) {
	const [answer, setAnswer] = useState("");
	const [busy, setBusy] = useState(false);
	const [err, setErr] = useState("");
	const att = useAttachments(ws.id);
	const send = async (text: string) => {
		setBusy(true);
		setErr("");
		try {
			await api.post(`/api/w/${ws.id}/projects/${projectId}/agents/${q.agent}/messages`, { text, files: att.ids() });
			setAnswer("");
			att.clear();
		} catch (e: any) {
			setErr(e.message);
		} finally {
			setBusy(false);
		}
	};
	const hasFiles = att.ids().length > 0;
	return (
		<div className="q-card" style={{ ["--role" as any]: agent ? roleColor(agent) : "var(--signal)" }}>
			<div className="q-who">
				<span className="at-glyph">{initials(agent?.name ?? "?")}</span>
				<b>{agent?.name ?? q.agent}</b> needs your answer
				<span className="mono muted">· {timeAgo(q.at)}</span>
				<button className="btn ghost small" onClick={onOpen} style={{ marginLeft: "auto" }}>
					Open transcript
				</button>
			</div>
			<Markdown text={q.text} />
			{canEdit && (
				<form
					className="q-answer"
					{...dropFiles(att)}
					onSubmit={(e) => {
						e.preventDefault();
						if (answer.trim() || hasFiles) send(answer.trim());
					}}
				>
					<textarea rows={2} className="input" placeholder="Your answer… (paste or drop files to attach)" value={answer} onChange={(e) => setAnswer(e.target.value)} onPaste={(e) => pasteInto(e, att)} />
					<AttachmentTray att={att} />
					<div className="row">
						<button type="button" className="btn small" disabled={busy || att.uploading} onClick={() => send(answer.trim() ? `Approved. ${answer.trim()}` : "Approved. Go ahead.")} title={answer.trim() ? "Approve, with your note and any attached files" : "Approve"}>
							Approve
						</button>
						<AttachButton att={att} label="📎 Attach" />
						<span className="grow" />
						{err && <span className="err">{err}</span>}
						<button className="btn primary small" disabled={busy || att.uploading || (!answer.trim() && !hasFiles)}>
							Send answer
						</button>
					</div>
				</form>
			)}
		</div>
	);
}

function useRepoFile(ws: string, projectId: string, path: string | undefined, tick: number) {
	const [file, setFile] = useState<{ text?: string; binary?: boolean; size: number } | null | undefined>(undefined);
	useEffect(() => {
		if (!path) return setFile(undefined);
		let live = true;
		api.get(`/api/w/${ws}/projects/${projectId}/file?path=${encodeURIComponent(path)}`).then(
			(f) => live && setFile(f),
			() => live && setFile(null),
		);
		return () => {
			live = false;
		};
	}, [ws, projectId, path, tick]);
	return file;
}

function useRepoFiles(ws: string, projectId: string, tick: number) {
	const [files, setFiles] = useState<string[]>();
	useEffect(() => {
		let live = true;
		api.get(`/api/w/${ws}/projects/${projectId}/files`).then((r) => live && setFiles(r.files), () => live && setFiles([]));
		return () => {
			live = false;
		};
	}, [ws, projectId, tick]);
	return files;
}

function DocTab({ ws, projectId, path, tick, empty }: { ws: string; projectId: string; path: string; tick: number; empty: string }) {
	const file = useRepoFile(ws, projectId, path, tick);
	if (file === undefined) return <div className="muted pad">Loading…</div>;
	if (file === null || !file.text) return <Placeholder icon="✎" title={path} text={empty} />;
	return (
		<article className="doc">
			<div className="doc-path mono">{path} · on main</div>
			<Markdown text={file.text} />
		</article>
	);
}

function DecisionsTab({ ws, projectId, tick }: { ws: string; projectId: string; tick: number }) {
	const files = useRepoFiles(ws, projectId, tick);
	const records = useMemo(() => (files ?? []).filter((f) => /^docs\/decisions\/.+\.md$/i.test(f)).sort(), [files]);
	const [sel, setSel] = useState<string>();
	const path = sel && records.includes(sel) ? sel : records.at(-1);
	const file = useRepoFile(ws, projectId, path, tick);
	if (!files) return <div className="muted pad">Loading…</div>;
	if (!records.length) return <Placeholder icon="⚖" title="Decision records" text="Every significant choice (stack, architecture, trade-offs) is recorded in docs/decisions/ and shows up here." />;
	return (
		<div className="dr">
			<div className="dr-list">
				{records.map((f) => {
					const base = f.replace(/^docs\/decisions\//, "").replace(/\.md$/i, "");
					const [, num, slug] = /^(\d+)-?(.*)$/.exec(base) ?? [, "", base];
					return (
						<button key={f} className={f === path ? "on" : ""} onClick={() => setSel(f)} title={f}>
							<span className="mono">{num}</span> {(slug ?? base).replace(/-/g, " ")}
						</button>
					);
				})}
			</div>
			{file?.text ? (
				<article className="doc">
					<div className="doc-path mono">{path} · on main</div>
					<Markdown text={file.text} />
				</article>
			) : (
				<div className="muted pad">Loading…</div>
			)}
		</div>
	);
}

function WireframesTab({ ws, projectId, tick }: { ws: string; projectId: string; tick: number }) {
	const files = useRepoFiles(ws, projectId, tick);
	const frames = useMemo(() => (files ?? []).filter((f) => /^docs\/wireframes\/.+\.html?$/i.test(f)), [files]);
	const [sel, setSel] = useState<string>();
	const path = sel && frames.includes(sel) ? sel : frames[0];
	const file = useRepoFile(ws, projectId, path, tick);
	if (!files) return <div className="muted pad">Loading…</div>;
	if (!frames.length) return <Placeholder icon="▭" title="Wireframes" text="Screens drawn as HTML in docs/wireframes/ show up here." />;
	return (
		<div className="wf">
			<div className="wf-list">
				{frames.map((f) => (
					<button key={f} className={f === path ? "on" : ""} onClick={() => setSel(f)}>
						{f.replace(/^docs\/wireframes\//, "").replace(/\.html?$/i, "")}
					</button>
				))}
			</div>
			{/* Agent-written HTML: sandboxed, no same-origin, so it can't reach pi-os. */}
			{file?.text ? <iframe className="wf-frame" sandbox="allow-scripts" srcDoc={file.text} title={path} /> : <div className="muted pad">Loading…</div>}
		</div>
	);
}

function RepoTab({ ws, projectId, tick }: { ws: string; projectId: string; tick: number }) {
	const files = useRepoFiles(ws, projectId, tick);
	const [sel, setSel] = useState<string>();
	const file = useRepoFile(ws, projectId, sel, tick);
	const [log, setLog] = useState<{ hash: string; subject: string; at: number; files: number }[]>([]);
	useEffect(() => {
		api.get(`/api/w/${ws}/projects/${projectId}/log`).then((r) => setLog(r.log), () => {});
	}, [ws, projectId, tick]);
	return (
		<div className="repo">
			<div className="repo-files">
				<div className="label">Files on main</div>
				{(files ?? []).filter((f) => !f.endsWith(".gitkeep")).map((f) => (
					<button key={f} className={f === sel ? "on" : ""} onClick={() => setSel(f)} title={f}>
						<span className="muted">{f.includes("/") ? f.slice(0, f.lastIndexOf("/") + 1) : ""}</span>
						{f.slice(f.lastIndexOf("/") + 1)}
					</button>
				))}
			</div>
			<div className="repo-view">
				{sel ? (
					file === undefined ? (
						<div className="muted pad">Loading…</div>
					) : file?.text !== undefined ? (
						/\.md$/i.test(sel) ? (
							<article className="doc">
								<Markdown text={file.text} />
							</article>
						) : (
							<pre className="repo-code">{file.text}</pre>
						)
					) : (
						<div className="muted pad">{file ? `Binary file, ${file.size} bytes` : "Not found"}</div>
					)
				) : (
					<div className="repo-log">
						<div className="label">History of main</div>
						{log.map((c) => (
							<div key={c.hash} className="commit">
								<span className="mono">{c.hash}</span>
								<span className="grow">{c.subject}</span>
								<span className="mono muted">
									{c.files ? `${c.files} file${c.files === 1 ? "" : "s"} · ` : ""}
									{timeAgo(c.at)}
								</span>
							</div>
						))}
					</div>
				)}
			</div>
		</div>
	);
}

function Placeholder({ icon, title, text }: { icon: string; title: string; text: string }) {
	return (
		<div className="ph-empty">
			<div className="ph-icon">{icon}</div>
			<div className="ph-etitle">{title}</div>
			<p>{text}</p>
		</div>
	);
}

// ------------------------------------------------------------------ new project

export function NewProjectDialog({ ws, models, picker, defaultModel, onClose }: { ws: Workspace; models: ModelInfo[]; picker: ModelPicker; defaultModel?: ModelRef; onClose: () => void }) {
	// Real models only; the offline demo model just in case nothing else is configured.
	const real = models.filter((m) => pickerShows(picker, m) && m.provider !== "pi-os-demo");
	const shown = real.length ? real : models.filter((m) => m.provider === "pi-os-demo");
	const initial = defaultModel && shown.some((m) => m.provider === defaultModel.provider && m.id === defaultModel.modelId) ? `${defaultModel.provider}/${defaultModel.modelId}` : shown[0] ? `${shown[0].provider}/${shown[0].id}` : "";
	const [goal, setGoal] = useState("");
	const att = useAttachments(ws.id);
	const [name, setName] = useState("");
	const [model, setModel] = useState(initial);
	const [busy, setBusy] = useState(false);
	const [err, setErr] = useState("");
	const create = async () => {
		setBusy(true);
		setErr("");
		try {
			const [provider, ...rest] = model.split("/");
			const r = await api.post(`/api/w/${ws.id}/projects`, { goal, name: name || undefined, model: model ? { provider, modelId: rest.join("/") } : undefined, files: att.ids() });
			onClose();
			navigate(projectHref(ws.id, r.project.id));
		} catch (e: any) {
			setErr(e.message);
			setBusy(false);
		}
	};
	return (
		<Dialog onClose={onClose} className="np-dialog">
			<h2>New project</h2>
			<p className="muted" style={{ margin: "0 0 14px", fontSize: 13.5 }}>
				Describe what you want built. A lead agent forms a team; you approve the requirements and the backlog, then the team builds it in a new git repo while you watch.
			</p>
			<label className="label">Goal</label>
			<div {...dropFiles(att)}>
			<textarea
				className="input"
				rows={5}
				autoFocus
				value={goal}
				onChange={(e) => setGoal(e.target.value)}
				onPaste={(e) => pasteInto(e, att)}
				placeholder={"e.g. A web app for booking our 6 meeting rooms: see free slots for today and the week, book with one click, cancel your own bookings. Sign-in with a simple name is fine."}
			/>
			<AttachmentTray att={att} />
			<div className="np-attach">
				<AttachButton att={att} className="btn small" label="📎 Attach files" />
				<span className="muted">Specs, mockups, screenshots, data — any format. Kept with the project (outside the git repo) for the whole team to read.</span>
			</div>
			</div>
			<div className="row" style={{ gap: 10, marginTop: 10 }}>
				<div className="grow">
					<label className="label">Name (optional)</label>
					<input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="from the goal" maxLength={80} />
				</div>
				<div className="grow">
					<label className="label">Model for the team</label>
					<select className="input" value={model} onChange={(e) => setModel(e.target.value)}>
						{shown.map((m) => (
							<option key={`${m.provider}/${m.id}`} value={`${m.provider}/${m.id}`}>
								{m.provider} · {m.name}
							</option>
						))}
					</select>
				</div>
			</div>
			{!real.length && <div className="np-warn">No model provider is configured, so the team can only use the offline demo model, which can't do real work. Add a key under Settings → Model providers.</div>}
			<div className="np-warn">Agents run shell commands on this machine, inside the project's folder in the pi-os data directory.</div>
			{err && <div className="err">{err}</div>}
			<div className="row" style={{ justifyContent: "flex-end", marginTop: 14 }}>
				<button className="btn ghost" onClick={onClose}>
					Cancel
				</button>
				<button className="btn primary" disabled={busy || att.uploading || goal.trim().length < 8 || !model} onClick={create}>
					{busy ? "Starting…" : "Start project"}
				</button>
			</div>
		</Dialog>
	);
}
