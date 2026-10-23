import { useState } from "react";
import { api, type Workspace } from "../api";
import { chatHref, navigate } from "../store";
import { Dialog } from "./bits";

/** Moving blueprints and gadgets between pi-os instances: `*.pios.json` files (see server gadgets/bundle.ts). */

type Exported = { fileName: string; bundle: unknown };

function download({ fileName, bundle }: Exported) {
	const url = URL.createObjectURL(new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" }));
	const a = Object.assign(document.createElement("a"), { href: url, download: fileName });
	document.body.append(a);
	a.click();
	a.remove();
	setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export const exportBlueprint = (id: string) => api.get<Exported>(`/api/blueprints/${id}/export`).then(download);
export const exportGadget = (id: string, withData: boolean) => api.get<Exported>(`/api/gadgets/${id}/export${withData ? "?data=1" : ""}`).then(download);

export function ExportDialog({ ws, mine, gadgets, onClose }: { ws: Workspace; mine: number; gadgets: number; onClose: () => void }) {
	const [bps, setBps] = useState(mine > 0);
	const [gs, setGs] = useState(gadgets > 0);
	const [data, setData] = useState(true);
	const [busy, setBusy] = useState(false);
	const [err, setErr] = useState("");
	const go = async () => {
		setBusy(true);
		setErr("");
		try {
			const q = new URLSearchParams({ ...(bps ? { blueprints: "mine" } : {}), ...(gs ? { gadgets: "all" } : {}), ...(gs && data ? { data: "1" } : {}) });
			download(await api.get<Exported>(`/api/w/${ws.id}/export?${q}`));
			onClose();
		} catch (e: any) {
			setErr(e.message);
		} finally {
			setBusy(false);
		}
	};
	return (
		<Dialog onClose={onClose} className="tx-dialog">
			<h2>Export</h2>
			<p className="muted tx-lede">One <code>.pios.json</code> file you can import on another pi-os.</p>
			<label className="tx-opt">
				<input type="checkbox" checked={bps} disabled={!mine} onChange={(e) => setBps(e.target.checked)} />
				<span>
					My blueprints <span className="muted">({mine})</span>
				</span>
			</label>
			<label className="tx-opt">
				<input type="checkbox" checked={gs} disabled={!gadgets} onChange={(e) => setGs(e.target.checked)} />
				<span>
					Gadgets in “{ws.name}” <span className="muted">({gadgets})</span>
				</span>
			</label>
			<label className={`tx-opt sub ${gs ? "" : "off"}`}>
				<input type="checkbox" checked={data} disabled={!gs} onChange={(e) => setData(e.target.checked)} />
				<span>
					Include their data <span className="muted">(what they store; may contain personal information)</span>
				</span>
			</label>
			<p className="muted tx-note">Shares, links and Gatekeeper access stay here; grant them again after importing.</p>
			<div className="row" style={{ marginTop: 14 }}>
				<span className="grow">{err && <span className="err">{err}</span>}</span>
				<button className="btn ghost" onClick={onClose}>
					Cancel
				</button>
				<button className="btn primary" disabled={busy || (!bps && !gs)} onClick={go}>
					{busy ? "Exporting…" : "Download"}
				</button>
			</div>
		</Dialog>
	);
}

type Producer = { app: string; version: string; runtime: number };
type ItemCheck = { kind: "blueprint" | "gadget"; index: number; name: string; status: "ok" | "warn" | "blocked"; issues: string[]; notes: string[] };
type Check = { producer?: Producer; local: Producer; items: ItemCheck[] };
type Preview = { blueprints: { name: string; icon?: string }[]; gadgets: { name: string; icon?: string; data: boolean }[]; exportedAt?: string };
type Result = { blueprints: { id: string; name: string }[]; gadgets: { id: string; name: string; data: boolean }[]; skipped: { kind: string; name: string; issues: string[] }[]; warnings: { kind: string; name: string; issues: string[] }[]; notes: string[] };

const STATUS_ICON = { ok: "✓", warn: "⚠", blocked: "⛔" } as const;

export function ImportDialog({ ws, onClose, onImported }: { ws: Workspace; onClose: () => void; onImported?: () => void }) {
	const [text, setText] = useState<string>();
	const [file, setFile] = useState("");
	const [preview, setPreview] = useState<Preview>();
	const [check, setCheck] = useState<Check>();
	const [share, setShare] = useState(false);
	const [busy, setBusy] = useState(false);
	const [err, setErr] = useState("");
	const [result, setResult] = useState<Result>();
	const read = async (f: File) => {
		setErr("");
		setPreview(undefined);
		setCheck(undefined);
		setFile(f.name);
		const t = await f.text();
		try {
			const b = JSON.parse(t);
			if (b?.format !== "pi-os/bundle") throw new Error("This isn't a pi-os export file.");
			setText(t);
			setPreview({
				blueprints: (b.blueprints ?? []).map((x: any) => ({ name: String(x?.name ?? "?"), icon: x?.icon })),
				gadgets: (b.gadgets ?? []).map((x: any) => ({ name: String(x?.name ?? "?"), icon: x?.icon, data: !!x?.data })),
				exportedAt: b.exportedAt,
			});
			// Can this instance run what's in it? (version, gadget runtime, features, Gatekeepers)
			const r = await fetch(`/api/w/${ws.id}/import/check`, { method: "POST", headers: { "content-type": "application/json" }, body: t });
			const j = await r.json().catch(() => ({}));
			if (!r.ok) throw new Error(j.error ?? `Check failed (${r.status})`);
			setCheck(j);
		} catch (e: any) {
			setText(undefined);
			setPreview(undefined);
			setErr(e instanceof SyntaxError ? "This file isn't valid JSON." : e.message);
		}
	};
	const go = async () => {
		if (!text) return;
		setBusy(true);
		setErr("");
		try {
			const r = await fetch(`/api/w/${ws.id}/import${share ? "?visibility=public" : ""}`, { method: "POST", headers: { "content-type": "application/json" }, body: text });
			const j = await r.json().catch(() => ({}));
			if (!r.ok) throw new Error(j.error ?? `Import failed (${r.status})`);
			setResult(j);
			onImported?.();
		} catch (e: any) {
			setErr(e.message);
		} finally {
			setBusy(false);
		}
	};
	if (result)
		return (
			<Dialog onClose={onClose} className="tx-dialog">
				<h2>Imported</h2>
				{result.blueprints.length > 0 && (
					<>
						<div className="label">Blueprints · in your library</div>
						<ul className="tx-list">
							{result.blueprints.map((b) => (
								<li key={b.id}>{b.name}</li>
							))}
						</ul>
					</>
				)}
				{result.gadgets.length > 0 && (
					<>
						<div className="label">Gadgets · in “{ws.name}”</div>
						<ul className="tx-list">
							{result.gadgets.map((g) => (
								<li key={g.id}>
									<a href={chatHref(ws.id, undefined, g.id, true)} onClick={onClose}>
										{g.name}
									</a>
									{g.data && <span className="muted"> · with its data</span>}
								</li>
							))}
						</ul>
					</>
				)}
				{result.skipped.length > 0 && (
					<>
						<div className="label tx-bad">Not imported · can't run on this pi-os</div>
						<ul className="tx-list">
							{result.skipped.map((x, i) => (
								<li key={i}>
									<b>{x.name}</b> <span className="muted">({x.kind})</span>: {x.issues.join("; ")}
								</li>
							))}
						</ul>
					</>
				)}
				{result.warnings.length > 0 && (
					<>
						<div className="label tx-warn">Imported with warnings</div>
						<ul className="tx-list">
							{result.warnings.map((x, i) => (
								<li key={i}>
									<b>{x.name}</b>: {x.issues.join("; ")}
								</li>
							))}
						</ul>
					</>
				)}
				{result.notes.map((n) => (
					<p key={n} className="muted tx-note">
						{n}
					</p>
				))}
				<div className="row" style={{ marginTop: 14, justifyContent: "flex-end" }}>
					<button className="btn primary" onClick={onClose}>
						Done
					</button>
				</div>
			</Dialog>
		);
	return (
		<Dialog onClose={onClose} className="tx-dialog">
			<h2>Import</h2>
			<p className="muted tx-lede">
				A <code>.pios.json</code> file exported from pi-os. Blueprints go to your library; gadgets into “{ws.name}”, owned by you.
			</p>
			<label
				className={`tx-drop ${file ? "has" : ""}`}
				onDragOver={(e) => e.preventDefault()}
				onDrop={(e) => {
					e.preventDefault();
					const f = e.dataTransfer.files[0];
					if (f) read(f);
				}}
			>
				<input type="file" accept=".json,application/json" hidden onChange={(e) => e.target.files?.[0] && read(e.target.files[0])} />
				{file ? <span className="mono">{file}</span> : <span>Choose a file, or drop it here</span>}
			</label>
			{preview && check && (
				<div className="tx-preview">
					<div className="tx-producer mono">
						{check.producer ? `from ${check.producer.app} ${check.producer.version} (gadget runtime v${check.producer.runtime})` : "from an older pi-os (no version recorded)"}
						{preview.exportedAt ? ` · ${preview.exportedAt.slice(0, 10)}` : ""} · this is pi-os {check.local.version} (runtime v{check.local.runtime})
					</div>
					{(["blueprint", "gadget"] as const).map((kind) => {
						const items = check.items.filter((x) => x.kind === kind);
						if (!items.length) return null;
						return (
							<div key={kind}>
								<div className="label">
									{items.length} {kind}
									{items.length === 1 ? "" : "s"}
								</div>
								<ul className="tx-check">
									{items.map((x) => {
										const g = kind === "gadget" ? preview.gadgets[x.index] : undefined;
										return (
											<li key={x.index} className={x.status}>
												<span className="tx-icon" title={x.status === "ok" ? "Runs here" : x.status === "warn" ? "Imports, but some parts won't work here" : "Can't run on this pi-os: won't be imported"}>
													{STATUS_ICON[x.status]}
												</span>
												<span>
													<span className="tx-name">
														{(kind === "gadget" ? g?.icon : preview.blueprints[x.index]?.icon) ?? ""} {x.name}
													</span>
													{g?.data && <span className="muted"> · with data</span>}
													{x.issues.map((m) => (
														<span key={m} className="tx-issue">
															{m}
														</span>
													))}
													{x.notes.map((m) => (
														<span key={m} className="tx-issue note">
															{m}
														</span>
													))}
												</span>
											</li>
										);
									})}
								</ul>
							</div>
						);
					})}
					{check.items.some((x) => x.status === "blocked") && <div className="tx-bad">⛔ items can't run on this pi-os (newer gadget runtime or features it doesn't have) and won't be imported.</div>}
					{preview.blueprints.length > 0 && (
						<label className="tx-opt">
							<input type="checkbox" checked={share} onChange={(e) => setShare(e.target.checked)} />
							<span>Share the blueprints with everyone on this pi-os (otherwise only you see them)</span>
						</label>
					)}
				</div>
			)}
			<div className="row" style={{ marginTop: 14 }}>
				<span className="grow">{err && <span className="err">{err}</span>}</span>
				<button className="btn ghost" onClick={onClose}>
					Cancel
				</button>
				<button className="btn primary" disabled={busy || !preview || !check || !check.items.some((x) => x.status !== "blocked")} onClick={go}>
					{busy ? "Importing…" : check && check.items.some((x) => x.status === "blocked") ? `Import ${check.items.filter((x) => x.status !== "blocked").length} of ${check.items.length}` : "Import"}
				</button>
			</div>
		</Dialog>
	);
}

export const openImported = (wsId: string, gadgetId: string) => navigate(chatHref(wsId, undefined, gadgetId, true));
