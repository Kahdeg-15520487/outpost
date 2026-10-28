import { useEffect, useRef, useState } from "react";
import { api, type Backlog, type BacklogItem, type Feedback, type PreviewInfo, type PreviewLogLine } from "../api";
import { timeAgo } from "../store";
import { AttachButton, AttachmentTray, pasteInto, useAttachments } from "./Chat";
import { askText, reportError } from "../dialogs";

const STATUS_TEXT: Record<PreviewInfo["status"], string> = {
	off: "Stopped",
	"no-config": "Not set up",
	installing: "Installing",
	starting: "Starting",
	running: "Running",
	crashed: "Crashed",
	failed: "Failed",
};

/**
 * The App tab: outpost runs the mission's app from main (.outpost/mission.json) and shows it here, with its
 * logs. It starts when you open the tab and restarts by itself after merges that touch app/.
 */
export function PreviewTab({ wsId, missionId, preview, canEdit, feedback = {}, backlog }: { wsId: string; missionId: string; preview: PreviewInfo; canEdit: boolean; feedback?: Record<string, Feedback>; backlog?: Backlog }) {
	const [fbOpen, setFbOpen] = useState(() => localStorage.getItem("outpost.preview.feedback") === "1");
	const fbCount = Object.keys(feedback).length;
	const toggleFb = () => {
		setFbOpen(!fbOpen);
		localStorage.setItem("outpost.preview.feedback", fbOpen ? "0" : "1");
	};
	const base = `/api/w/${wsId}/missions/${missionId}/preview`;
	const [logsOpen, setLogsOpen] = useState(() => localStorage.getItem("outpost.preview.logs") === "1");
	const [lines, setLines] = useState<PreviewLogLine[]>([]);
	const [busy, setBusy] = useState(false);
	const seq = useRef(0);
	const logBox = useRef<HTMLDivElement>(null);
	const pinned = useRef(true);
	const p = preview;
	const running = p.status === "running" && p.port;
	// The preview is its own server on its own port, so use the host outpost was reached on (localhost, a
	// LAN address, a container's published address) rather than the address it bound to.
	const url = running ? `http://${location.hostname || "127.0.0.1"}:${p.port}/` : "";
	const showLogs = logsOpen || !running;

	// Open the tab → start it (unless someone stopped it on purpose).
	useEffect(() => {
		if (canEdit && p.status === "off" && !p.stoppedByUser) void api.post(`${base}/start`, {}).catch(() => {});
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [missionId]);

	// Pull new log lines when the server says there are some.
	useEffect(() => {
		if (!showLogs || p.logSeq <= seq.current) return;
		let live = true;
		api.get(`${base}/logs?since=${seq.current}`).then((r: { seq: number; lines: PreviewLogLine[] }) => {
			if (!live) return;
			seq.current = r.seq;
			setLines((l) => [...l, ...r.lines].slice(-1500));
		});
		return () => {
			live = false;
		};
	}, [p.logSeq, showLogs, base]);

	useEffect(() => {
		if (pinned.current && logBox.current) logBox.current.scrollTop = logBox.current.scrollHeight;
	}, [lines, showLogs]);

	const act = async (what: "start" | "stop") => {
		setBusy(true);
		try {
			await api.post(`${base}/${what}`, {});
		} catch (e: any) {
			reportError(e.message);
		} finally {
			setBusy(false);
		}
	};
	const toggleLogs = () => {
		setLogsOpen(!logsOpen);
		localStorage.setItem("outpost.preview.logs", logsOpen ? "0" : "1");
	};

	return (
		<div className={`pv ${showLogs ? "with-logs" : ""}`}>
			<div className="pv-bar">
				<span className={`pv-status ${p.status}`}>
					<i />
					{STATUS_TEXT[p.status]}
				</span>
				{p.head && <span className="pv-head mono">main @ {p.head}</span>}
				{url ? (
					<a className="pv-url mono" href={url} target="_blank" rel="noreferrer" title="Open in a new tab">
						{url.replace(/\/$/, "")} ↗
					</a>
				) : (
					p.command && <span className="pv-cmd mono">{p.command}</span>
				)}
				<span className="grow" />
				{canEdit && (
					<>
						{p.status === "off" || p.status === "failed" || p.status === "crashed" || p.status === "no-config" ? (
							<button className="btn small" disabled={busy} onClick={() => act("start")}>
								{p.status === "off" ? "Start" : "Try again"}
							</button>
						) : (
							<>
								<button className="btn small" disabled={busy} onClick={() => act("start")} title="Restart from the latest main">
									Restart
								</button>
								<button className="btn ghost small" disabled={busy} onClick={() => act("stop")}>
									Stop
								</button>
							</>
						)}
					</>
				)}
				{running && (
					<button className={`btn ghost small ${logsOpen ? "on" : ""}`} onClick={toggleLogs}>
						Logs
					</button>
				)}
				<button className={`btn ghost small pv-fb-toggle ${fbOpen ? "on" : ""}`} onClick={toggleFb} title="Tell the team what to change in the app">
					Feedback{fbCount ? ` (${fbCount})` : ""}
				</button>
			</div>

			<div className="pv-main">
			<div className="pv-stage">
				{running ? (
					<iframe key={`${p.port}-${p.readyAt}`} className="pv-frame" src={url} title="Live app" sandbox="allow-scripts allow-forms allow-same-origin allow-popups allow-modals allow-downloads" />
				) : (
					<div className="pv-empty">
						{p.status === "installing" || p.status === "starting" ? (
							<>
								<div className="pv-spin" />
								<div className="pv-etitle">{p.status === "installing" ? "Installing dependencies…" : "Starting the app…"}</div>
								<div className="muted mono">{p.command}</div>
							</>
						) : p.status === "no-config" ? (
							<>
								<div className="pv-etitle">Nothing to run yet</div>
								<p className="muted">The app appears here once main has <code>.outpost/mission.json</code> (the architect writes it with the design) and code in <code>app/</code>. It starts by itself and restarts after every merge.</p>
							</>
						) : p.status === "failed" || p.status === "crashed" ? (
							<>
								<div className="pv-etitle">{p.status === "crashed" ? "The app crashed" : "The app didn't start"}</div>
								<p className="pv-error">{p.error}</p>
								<p className="muted">The logs below show why. Developers see the same logs with their preview tool.</p>
							</>
						) : (
							<>
								<div className="pv-etitle">The app isn't running</div>
								<p className="muted">{p.stoppedByUser ? "It was stopped. It stays off until you start it again." : "Start it to see the latest main."}</p>
							</>
						)}
					</div>
				)}
			</div>
			{fbOpen && <FeedbackPanel wsId={wsId} missionId={missionId} preview={preview} canEdit={canEdit} feedback={feedback} backlog={backlog} />}
			</div>

			{showLogs && (
				<div
					className="pv-logs mono"
					ref={logBox}
					onScroll={(e) => {
						const el = e.currentTarget;
						pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
					}}
				>
					<div className="pl-head">
						<span>Logs</span>
						{p.command && <span className="muted">{p.command}</span>}
					</div>
					{lines.length ? lines.map((l) => <div key={l.seq} className={`pl ${l.stream}`}>{l.text || "\u00a0"}</div>) : <div className="pl outpost">No output yet.</div>}
				</div>
			)}
		</div>
	);
}

/** Derived from the items linked to the feedback. */
function feedbackStatus(fb: Feedback, items: BacklogItem[]): { label: string; tone: string } {
	if (fb.declined) return { label: "Declined", tone: "declined" };
	if (!items.length) return { label: "With the team", tone: "new" };
	if (items.some((i) => i.pending)) return { label: "Waiting for your approval", tone: "pending" };
	const tasks = items.filter((i) => i.type === "task");
	if ((tasks.length ? tasks : items).every((i) => i.status === "done")) return { label: "Done", tone: "done" };
	return { label: "In progress", tone: "doing" };
}

/**
 * Feedback on the running app: each entry records the version of main you were looking at. The planner
 * drafts backlog items from it (pending until you approve them on the Backlog tab); you can also make
 * a PBI yourself, or decline it.
 */
function FeedbackPanel({ wsId, missionId, preview, canEdit, feedback, backlog }: { wsId: string; missionId: string; preview: PreviewInfo; canEdit: boolean; feedback: Record<string, Feedback>; backlog?: Backlog }) {
	const base = `/api/w/${wsId}/missions/${missionId}/feedback`;
	const att = useAttachments(wsId);
	const [text, setText] = useState("");
	const [busy, setBusy] = useState(false);
	const [err, setErr] = useState("");
	const [pbiFor, setPbiFor] = useState<string>();
	const list = Object.values(feedback).sort((a, b) => b.at - a.at);
	const items = Object.values(backlog?.items ?? {});
	const run = async (work: () => Promise<unknown>) => {
		setBusy(true);
		setErr("");
		try {
			await work();
		} catch (e: any) {
			setErr(e.message);
		} finally {
			setBusy(false);
		}
	};
	const submit = () =>
		run(async () => {
			await api.post(base, { text: text.trim(), files: att.ids() });
			setText("");
			att.clear();
		});
	return (
		<aside className="fb-panel" aria-label="Feedback">
			{canEdit && (
				<form
					className="fb-form"
					onSubmit={(e) => {
						e.preventDefault();
						if (text.trim() || att.ids().length) submit();
					}}
				>
					<div className="label">Your feedback {preview.head && <span className="mono muted">on main @ {preview.head}</span>}</div>
					<textarea className="input" rows={3} placeholder="What should change? e.g. The total should round to cents" value={text} onChange={(e) => setText(e.target.value)} onPaste={(e) => pasteInto(e, att)} />
					<AttachmentTray att={att} />
					<div className="row">
						<AttachButton att={att} label="📎 Attach" />
						<span className="grow" />
						{err && <span className="err">{err}</span>}
						<button className="btn primary small" disabled={busy || att.uploading || (!text.trim() && !att.ids().length)}>
							Send to the team
						</button>
					</div>
				</form>
			)}
			<div className="fb-list">
				{!list.length && <div className="muted fb-empty">No feedback yet. What you send goes to the planner, who drafts backlog items for your approval.</div>}
				{list.map((fb) => {
					const linked = items.filter((i) => i.feedback === fb.id);
					const st = feedbackStatus(fb, linked);
					return (
						<div key={fb.id} className={`fb-item ${st.tone}`}>
							<div className="fb-top">
								<span className="kc-fb mono">{fb.id}</span>
								<span className={`fb-status ${st.tone}`}>{st.label}</span>
								<span className="grow" />
								<span className="mono muted fb-meta">
									{fb.by} · {timeAgo(fb.at)}
									{fb.head ? ` · @${fb.head}` : ""}
								</span>
							</div>
							<div className="fb-text">{fb.text}</div>
							{fb.files?.length ? <div className="fb-files mono">📎 {fb.files.join(", ")}</div> : null}
							{fb.declined && (
								<div className="fb-declined">
									{fb.declined.by}: {fb.declined.reason}
								</div>
							)}
							{linked.length > 0 && (
								<div className="fb-linked mono">
									{linked.map((i) => (
										<span key={i.id} className={`fb-chip ${i.pending ? "pending" : i.status}`} title={`${i.title} · ${i.pending ? "waiting for approval" : i.status}`}>
											{i.id}
										</span>
									))}
								</div>
							)}
							{canEdit && (
								<div className="fb-actions">
									{fb.declined ? (
										<button className="btn ghost small" disabled={busy} onClick={() => run(() => api.post(`${base}/${fb.id}/reopen`, {}))}>
											Reopen
										</button>
									) : (
										<>
											<button className="btn ghost small" disabled={busy} onClick={() => setPbiFor(pbiFor === fb.id ? undefined : fb.id)}>
												Make PBI
											</button>
											<button
												className="btn ghost small"
												disabled={busy}
												onClick={async () => {
													const reason = await askText({ title: `Decline ${fb.id}?`, label: "Why (the team sees it)", placeholder: "What is missing or wrong", required: true, confirmLabel: "Decline", multiline: true });
													if (reason?.trim()) run(() => api.post(`${base}/${fb.id}/decline`, { reason }));
												}}
											>
												Decline
											</button>
										</>
									)}
								</div>
							)}
							{pbiFor === fb.id && <MakePbi base={base} fb={fb} backlog={backlog} onDone={() => setPbiFor(undefined)} />}
						</div>
					);
				})}
			</div>
		</aside>
	);
}

function MakePbi({ base, fb, backlog, onDone }: { base: string; fb: Feedback; backlog?: Backlog; onDone: () => void }) {
	const features = Object.values(backlog?.items ?? {})
		.filter((i) => i.type === "feature")
		.sort((a, b) => a.order - b.order);
	const [title, setTitle] = useState(fb.text.split("\n")[0]!.slice(0, 80));
	const [ac, setAc] = useState("");
	const [parent, setParent] = useState(features[0]?.id ?? "");
	const [busy, setBusy] = useState(false);
	const [err, setErr] = useState("");
	return (
		<form
			className="fb-pbi"
			onSubmit={async (e) => {
				e.preventDefault();
				setBusy(true);
				setErr("");
				try {
					await api.post(`${base}/${fb.id}/pbi`, { title, acceptance: ac.split("\n").map((l) => l.trim()).filter(Boolean), parent: parent || undefined });
					onDone();
				} catch (e: any) {
					setErr(e.message);
				} finally {
					setBusy(false);
				}
			}}
		>
			<input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="PBI title" autoFocus />
			<textarea className="input" rows={2} value={ac} onChange={(e) => setAc(e.target.value)} placeholder="Acceptance criteria, one per line" />
			<div className="row">
				<select className="input" value={parent} onChange={(e) => setParent(e.target.value)}>
					<option value="">No feature</option>
					{features.map((f) => (
						<option key={f.id} value={f.id}>
							{f.id} {f.title}
						</option>
					))}
				</select>
				<span className="grow" />
				{err && <span className="err">{err}</span>}
				<button type="button" className="btn ghost small" onClick={onDone}>
					Cancel
				</button>
				<button className="btn primary small" disabled={busy || !title.trim()}>
					Create PBI
				</button>
			</div>
			<div className="muted fb-hint">The planner adds its tasks; they wait for your approval.</div>
		</form>
	);
}
