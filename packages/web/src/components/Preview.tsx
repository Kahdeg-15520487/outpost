import { useEffect, useRef, useState } from "react";
import { api, type PreviewInfo, type PreviewLogLine } from "../api";

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
 * The App tab: pi-os runs the project's app from main (.pios/project.json) and shows it here, with its
 * logs. It starts when you open the tab and restarts by itself after merges that touch app/.
 */
export function PreviewTab({ wsId, projectId, preview, canEdit }: { wsId: string; projectId: string; preview: PreviewInfo; canEdit: boolean }) {
	const base = `/api/w/${wsId}/projects/${projectId}/preview`;
	const [logsOpen, setLogsOpen] = useState(() => localStorage.getItem("pios.preview.logs") === "1");
	const [lines, setLines] = useState<PreviewLogLine[]>([]);
	const [busy, setBusy] = useState(false);
	const seq = useRef(0);
	const logBox = useRef<HTMLDivElement>(null);
	const pinned = useRef(true);
	const p = preview;
	const running = p.status === "running" && p.port;
	const url = running ? `http://${p.host ?? "127.0.0.1"}:${p.port}/` : "";
	const showLogs = logsOpen || !running;

	// Open the tab → start it (unless someone stopped it on purpose).
	useEffect(() => {
		if (canEdit && p.status === "off" && !p.stoppedByUser) void api.post(`${base}/start`, {}).catch(() => {});
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [projectId]);

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
			alert(e.message);
		} finally {
			setBusy(false);
		}
	};
	const toggleLogs = () => {
		setLogsOpen(!logsOpen);
		localStorage.setItem("pios.preview.logs", logsOpen ? "0" : "1");
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
			</div>

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
								<p className="muted">The app appears here once main has <code>.pios/project.json</code> (the architect writes it with the design) and code in <code>app/</code>. It starts by itself and restarts after every merge.</p>
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
					{lines.length ? lines.map((l) => <div key={l.seq} className={`pl ${l.stream}`}>{l.text || "\u00a0"}</div>) : <div className="pl pi-os">No output yet.</div>}
				</div>
			)}
		</div>
	);
}
