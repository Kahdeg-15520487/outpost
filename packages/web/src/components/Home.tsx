import { useEffect, useMemo, useRef, useState } from "react";
import { api, type HomePayload, type User, type Workspace } from "../api";
import { chatHref, missionHref, timeAgo, timeTitle, useReconnects } from "../store";

/**
 * The workspace homepage: what you were doing when you left, and what the agents did while you were
 * gone. Everything here is read from `/api/w/:ws/home` — facts only, no model calls — except the
 * one-line summaries, which are asked for explicitly because they cost tokens.
 *
 * Opening the page marks the workspace seen *after* the first read, so the digest you are looking at
 * is the one measured from your previous visit.
 */
export function HomePage({ ws, user, canEdit, onNewChat, onNewMission, onApprovals }: {
	ws: Workspace;
	user: User;
	canEdit: boolean;
	onNewChat: () => void;
	onNewMission: () => void;
	onApprovals: () => void;
}) {
	const [data, setData] = useState<HomePayload>();
	const [error, setError] = useState<string>();
	const [summarising, setSummarising] = useState(false);
	const [summaryNote, setSummaryNote] = useState<string>();
	/** Marked once per visit, and only after the page has actually been looked at. */
	const marked = useRef<string | undefined>(undefined);

	const load = () => api.get(`/api/w/${ws.id}/home`).then((d) => (setData(d), setError(undefined))).catch((e) => setError(e.message));
	const reconnects = useReconnects();

	useEffect(() => {
		marked.current = undefined;
		setData(undefined);
		setSummaryNote(undefined);
		setError(undefined);
		load();
	}, [ws.id, reconnects]);

	/**
	 * "Seen" is what the next visit measures from, so it is written when you leave — not on arrival,
	 * which would swallow the digest on a refresh — and not before the page has been on screen for a
	 * moment, so a double-load or an accidental reload doesn't spend it.
	 */
	useEffect(() => {
		const opened = Date.now();
		const url = `/api/w/${ws.id}/home/seen`;
		const mark = () => {
			if (marked.current === ws.id || Date.now() - opened < 3000) return;
			marked.current = ws.id;
			// pagehide kills in-flight requests; keepalive survives it.
			void fetch(url, { method: "POST", keepalive: true }).catch(() => {});
		};
		const dwell = setTimeout(mark, 60_000);
		addEventListener("pagehide", mark);
		return () => {
			clearTimeout(dwell);
			removeEventListener("pagehide", mark);
			mark();
		};
	}, [ws.id]);

	const summarise = async () => {
		const chats = data?.away.chats.filter((c) => !c.summary).map((c) => c.chatId) ?? [];
		if (!chats.length) return;
		setSummarising(true);
		setSummaryNote(undefined);
		try {
			const r = await api.post(`/api/w/${ws.id}/home/summaries`, { chats });
			if (r.skipped) setSummaryNote(r.skipped);
			if (Object.keys(r.summaries ?? {}).length) {
				setData((d) => d && { ...d, away: { ...d.away, chats: d.away.chats.map((c) => (r.summaries[c.chatId] ? { ...c, summary: r.summaries[c.chatId] } : c)) } });
			} else if (!r.skipped) setSummaryNote("Nothing new to summarise.");
		} catch (e) {
			setSummaryNote(e instanceof Error ? e.message : String(e));
		} finally {
			setSummarising(false);
		}
	};

	const away = data?.away;
	const totals = away?.totals;
	const nothingHappened = away && !away.chats.length && !away.modules.length && !away.missions.length && !away.approvals.pending && !away.files;
	const untouched = useMemo(() => (data ? data.pickup.approvals.length === 0 && data.pickup.questions.length === 0 && !data.pickup.lastChat && canEdit : false), [data, canEdit]);

	if (error) {
		return (
			<div className="main">
				<div className="empty-state">
					<p>Couldn't load this workspace's home.</p>
					<p className="mono muted">{error}</p>
					<button className="btn" onClick={load}>Try again</button>
				</div>
			</div>
		);
	}

	return (
		<div className="main home">
			<div className="home-scroll">
				<header className="home-head">
					<p className="home-eyebrow">
						{ws.name}
						{data && <> · {data.firstVisit ? "first time here" : `you were last here ${timeAgo(data.since)}`}</>}
					</p>
					<h1>
						{data?.firstVisit ? "Welcome" : "Welcome back"}, {user.displayName.split(" ")[0]}
						<em>.</em>
					</h1>
					<div className="home-actions">
						{canEdit && <button className="btn primary" onClick={onNewChat}>Start a chat</button>}
						{canEdit && <button className="btn" onClick={onNewMission}>Give a team a goal</button>}
						<button className="btn" onClick={onApprovals}>
							Approvals{data?.pickup.approvals.length ? ` (${data.pickup.approvals.length})` : ""}
						</button>
						<a className="btn ghost" href={`#/w/${ws.id}/files`}>Files</a>
					</div>
				</header>

				{!data && <p className="muted home-loading">Reading the workspace…</p>}

				{data && (
					<>
						<section className="home-section">
							<h2>Pick up where you left off</h2>
							{untouched ? (
								<p className="muted">Nothing is waiting on you. Start a chat{canEdit ? ", or give a team of agents a goal" : ""}.</p>
							) : (
								<div className="home-grid">
									{data.pickup.lastChat && (
										<a className="home-card" href={chatHref(ws.id, data.pickup.lastChat.id)}>
											<span className="home-card-label">Last chat</span>
											<span className="home-card-title">{data.pickup.lastChat.title}</span>
											<span className="home-card-meta" title={timeTitle(data.pickup.lastChat.at)}>{timeAgo(data.pickup.lastChat.at)}</span>
										</a>
									)}
									{data.pickup.questions.map((q) => (
										<a key={`${q.missionId}-${q.at}`} className="home-card warn" href={missionHref(ws.id, q.missionId, "overview")}>
											<span className="home-card-label">Waiting on you · {q.mission}</span>
											<span className="home-card-title">{q.text}</span>
											<span className="home-card-meta">{q.agent} asked {timeAgo(q.at)}</span>
										</a>
									))}
									{data.pickup.approvals.map((a) => (
										<button key={a.id} className="home-card warn" onClick={onApprovals}>
											<span className="home-card-label">Approval · {a.airlock}</span>
											<span className="home-card-title">{a.summary}</span>
											<span className="home-card-meta">{a.requestedBy} · {timeAgo(a.at)}</span>
										</button>
									))}
								</div>
							)}
						</section>

						<section className="home-section">
							<div className="home-section-head">
								<h2>While you were away</h2>
								{!!away?.chats.length && (
									<button className="btn ghost small" onClick={summarise} disabled={summarising}>
										{summarising ? "Asking the model…" : "Summarise these chats"}
									</button>
								)}
							</div>
							{summaryNote && <p className="muted home-note">{summaryNote}</p>}

							{nothingHappened && !data.firstVisit && <p className="muted">All quiet. Nothing changed since {timeAgo(data.since)}.</p>}
							{data.firstVisit && !totals?.runs && <p className="muted">This is a fresh start — there's no history to catch up on yet.</p>}

							{!!totals?.runs && (
								<p className="home-totals mono">
									{totals.runs} run{totals.runs === 1 ? "" : "s"} · {totals.messages} message{totals.messages === 1 ? "" : "s"} · {totals.tools} tool call{totals.tools === 1 ? "" : "s"}
									{!!away?.missions.length && ` · ${away.missions.length} mission${away.missions.length === 1 ? "" : "s"}`}
									{!!away?.modules.length && ` · ${away.modules.length} module${away.modules.length === 1 ? "" : "s"}`}
									{!!away?.approvals.decided && ` · ${away.approvals.decided} approval${away.approvals.decided === 1 ? "" : "s"}`}
									{!!away?.files && ` · ${away.files} file${away.files === 1 ? "" : "s"}`}
								</p>
							)}

							<div className="home-away">
								{away?.chats.map((c) => (
									<a key={c.chatId} className="home-run" href={chatHref(ws.id, c.chatId)}>
										<div className="home-run-head">
											<span className="home-run-title">{c.title}</span>
											<span className="home-run-meta">
												{c.runs > 1 ? `${c.runs} runs · ` : ""}
												{c.messages} msg{c.messages === 1 ? "" : "s"}
												{c.tools.length ? ` · ${c.tools.slice(0, 3).map((t) => t.name).join(", ")}` : ""}
												{c.tools.length > 3 ? "…" : ""}
											</span>
											<span className="ago" title={timeTitle(c.lastAt)}>{timeAgo(c.lastAt)}</span>
										</div>
										{c.summary ? <p className="home-run-summary">{c.summary}</p> : c.snippet ? <p className="home-run-snippet">{c.snippet}</p> : null}
										{c.failed && <span className="home-run-failed">That run ended badly — open the chat to see why.</span>}
									</a>
								))}
							</div>

							{!!away?.missions.length && (
								<div className="home-side-list">
									{away.missions.map((p) => (
										<a key={p.id} className="home-side-row" href={missionHref(ws.id, p.id, "overview")}>
											<span className="ico">◈</span>
											<span className="grow">{p.name}</span>
											<span className="muted">{p.changes} update{p.changes === 1 ? "" : "s"} · {p.stage}</span>
										</a>
									))}
								</div>
							)}

							{!!away?.modules.length && (
								<div className="home-side-list">
									{away.modules.map((g) => (
										<a key={g.id} className="home-side-row" href={chatHref(ws.id, undefined, g.id)}>
											<span className="ico">{g.icon}</span>
											<span className="grow">{g.name}</span>
											<span className="muted">changed {timeAgo(g.at)}</span>
										</a>
									))}
								</div>
							)}
						</section>

						{!!data.missions.length && (
							<section className="home-section">
								<h2>Missions</h2>
								<div className="home-side-list">
									{data.missions.map((p) => (
										<a key={p.id} className="home-side-row" href={missionHref(ws.id, p.id, "overview")}>
											<span className="grow">{p.name}</span>
											{p.open > 0 && <span className="badge">{p.open}</span>}
											<span className="muted">{p.stage}{p.lastAt ? ` · ${timeAgo(p.lastAt)}` : ""}</span>
										</a>
									))}
								</div>
							</section>
						)}
					</>
				)}
			</div>
		</div>
	);
}
