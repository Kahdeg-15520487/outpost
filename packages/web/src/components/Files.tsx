import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, fileUrl, formatBytes, uploadFile, type FileMeta, type Gadget, type Workspace } from "../api";
import { chatHref, navigate, timeAgo } from "../store";
import { Dialog } from "./bits";

const extOf = (name: string) => (/\.([a-z0-9]{1,5})$/i.exec(name)?.[1] ?? "file").toUpperCase();
const isImage = (f: FileMeta) => /^image\/(png|jpeg|gif|webp)$/.test(f.mime);
const isTextual = (f: FileMeta) => /^text|json|xml|csv|tsv|html|svg|markdown|yaml/.test(f.kind) || /^text\//.test(f.mime);
const SOURCE: Record<FileMeta["source"], string> = { upload: "uploaded", agent: "agent", gadget: "gadget", extract: "extracted" };

export function FilesPage({ ws, files, gadgets }: { ws: Workspace; files: Record<string, FileMeta>; gadgets: Gadget[] }) {
	const [filter, setFilter] = useState("");
	const [open, setOpen] = useState<Record<string, boolean>>({});
	const [preview, setPreview] = useState<FileMeta>();
	const [uploads, setUploads] = useState<{ key: string; name: string; progress: number; error?: string }[]>([]);
	const [over, setOver] = useState(false);
	const picker = useRef<HTMLInputElement>(null);
	const canEdit = ws.role !== "viewer";

	const { roots, children } = useMemo(() => {
		const all = Object.values(files).filter((f) => !filter || `${f.name} ${f.kind}`.toLowerCase().includes(filter.toLowerCase()));
		const ids = new Set(all.map((f) => f.id));
		const children = new Map<string, FileMeta[]>();
		const roots: FileMeta[] = [];
		for (const f of all) {
			if (f.parent && ids.has(f.parent)) children.set(f.parent, [...(children.get(f.parent) ?? []), f]);
			else roots.push(f);
		}
		roots.sort((a, b) => b.createdAt - a.createdAt);
		for (const list of children.values()) list.sort((a, b) => a.name.localeCompare(b.name));
		return { roots, children };
	}, [files, filter]);
	const total = Object.values(files).reduce((a, f) => a + f.size, 0);

	const upload = (list: File[]) => {
		for (const file of list) {
			const key = `${Date.now()}-${Math.random()}`;
			setUploads((u) => [...u, { key, name: file.name, progress: 0 }]);
			const set = (p: object) => setUploads((u) => u.map((x) => (x.key === key ? { ...x, ...p } : x)));
			uploadFile(ws.id, file, (progress) => set({ progress }))
				.then(() => setUploads((u) => u.filter((x) => x.key !== key)))
				.catch((e) => set({ error: e.message }));
		}
	};
	const ask = (f: FileMeta) => {
		sessionStorage.setItem("pios.attach", JSON.stringify([f]));
		navigate(chatHref(ws.id));
	};

	const row = (f: FileMeta, child = false): ReactNode[] => {
		const kids = children.get(f.id) ?? [];
		return [
			<tr key={f.id} className={child ? "child" : ""}>
				<td style={{ maxWidth: 380 }}>
					<div className="fname">
						{isImage(f) ? <img className="attachment" style={{ padding: 0, objectFit: "cover", borderRadius: 6 }} src={fileUrl(ws.id, f.id, true)} /> : <span className="attachment ext" style={{ padding: 0, border: 0 }}>{extOf(f.name)}</span>}
						<div style={{ minWidth: 0 }}>
							<a href="#" onClick={(e) => (e.preventDefault(), setPreview(f))} style={{ fontWeight: 600, textDecoration: "none", display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
								{child && f.name.includes("/") ? f.name.slice(f.name.indexOf("/") + 1) : f.name}
							</a>
							{kids.length > 0 && (
								<button className="btn ghost small" style={{ padding: "0 4px" }} onClick={() => setOpen({ ...open, [f.id]: !open[f.id] })}>
									{open[f.id] ? "▾" : "▸"} {kids.length} derived file{kids.length > 1 ? "s" : ""}
								</button>
							)}
						</div>
					</div>
				</td>
				<td>
					<span className="pill">{f.kind}</span>
				</td>
				<td className="mono" style={{ fontSize: 12 }}>
					{formatBytes(f.size)}
				</td>
				<td className="muted" style={{ fontSize: 12.5 }}>
					{SOURCE[f.source]} · {f.createdBy}
				</td>
				<td className="muted mono" style={{ fontSize: 11.5 }}>
					{timeAgo(f.createdAt)}
				</td>
				<td className="muted" style={{ fontSize: 12 }} title={f.gadgets.map((g) => gadgets.find((x) => x.id === g)?.name ?? g).join(", ")}>
					{f.gadgets.length ? `${f.gadgets.length} gadget${f.gadgets.length > 1 ? "s" : ""}` : "—"}
				</td>
				<td style={{ whiteSpace: "nowrap", textAlign: "right" }}>
					{canEdit && (
						<button className="btn small" onClick={() => ask(f)} title="Start a chat with this file attached">
							Ask agent
						</button>
					)}{" "}
					<a className="btn ghost small" href={fileUrl(ws.id, f.id)} title="Download">
						⇩
					</a>
					{canEdit && (
						<button className="btn ghost small" title="Delete" onClick={() => confirm(`Delete ${f.name}${kids.length ? ` (its ${kids.length} derived files stay)` : ""}?`) && api.del(`/api/w/${ws.id}/files/${f.id}`)}>
							✕
						</button>
					)}
				</td>
			</tr>,
			...(open[f.id] ? kids.flatMap((k) => row(k, true)) : []),
		];
	};

	return (
		<div
			className="main"
			onDragOver={(e) => canEdit && e.dataTransfer.types.includes("Files") && (e.preventDefault(), setOver(true))}
			onDragLeave={(e) => e.currentTarget === e.target && setOver(false)}
			onDrop={(e) => {
				if (!canEdit) return;
				e.preventDefault();
				setOver(false);
				upload([...e.dataTransfer.files]);
			}}
		>
			<div className="page">
				<div className="page-inner">
					<div className="row" style={{ alignItems: "end" }}>
						<div className="grow">
							<h1>Files</h1>
							<p className="lede" style={{ marginBottom: 18 }}>
								Uploads, things the agent and gadgets produce, and parts extracted from archives. Any format: the agent takes apart what it doesn't know, and builds gadgets to work with it.
							</p>
						</div>
						<span className="mono muted" style={{ fontSize: 12, marginBottom: 22 }}>
							{Object.keys(files).length} files · {formatBytes(total)}
						</span>
					</div>
					{canEdit && (
						<div className={`files-drop ${over ? "on" : ""}`} onClick={() => picker.current?.click()}>
							<input
								ref={picker}
								type="file"
								multiple
								hidden
								onChange={(e) => {
									upload([...(e.target.files ?? [])]);
									e.target.value = "";
								}}
							/>
							Drop files here or <b>browse</b> — any format
							{uploads.map((u) => (
								<div key={u.key} className="mono" style={{ fontSize: 12, marginTop: 6, color: u.error ? "var(--bad)" : undefined }}>
									{u.name} — {u.error ?? `${Math.round(u.progress * 100)}%`}
								</div>
							))}
						</div>
					)}
					<input className="input" placeholder="Filter by name or kind…" value={filter} onChange={(e) => setFilter(e.target.value)} style={{ maxWidth: 320, marginBottom: 10 }} />
					{roots.length === 0 ? (
						<div className="empty-state">{filter ? "No matches." : "No files yet. Attach some in a chat, or drop them here."}</div>
					) : (
						<div className="card" style={{ padding: 0, overflowX: "auto" }}>
							<table className="files-table">
								<thead>
									<tr>
										<th>Name</th>
										<th>Kind</th>
										<th>Size</th>
										<th>From</th>
										<th>Added</th>
										<th>Access</th>
										<th />
									</tr>
								</thead>
								<tbody>{roots.flatMap((f) => row(f))}</tbody>
							</table>
						</div>
					)}
				</div>
			</div>
			{preview && <PreviewDialog ws={ws} file={files[preview.id] ?? preview} gadgets={gadgets} canEdit={canEdit} onAsk={() => ask(preview)} onClose={() => setPreview(undefined)} />}
		</div>
	);
}

function PreviewDialog({ ws, file, gadgets, canEdit, onAsk, onClose }: { ws: Workspace; file: FileMeta; gadgets: Gadget[]; canEdit: boolean; onAsk: () => void; onClose: () => void }) {
	const [textBody, setTextBody] = useState<string>();
	const [name, setName] = useState(file.name);
	useEffect(() => {
		if (!isTextual(file)) return;
		let live = true;
		fetch(fileUrl(ws.id, file.id))
			.then((r) => r.text())
			.then((t) => live && setTextBody(t.length > 200_000 ? `${t.slice(0, 200_000)}\n…[truncated]` : t));
		return () => {
			live = false;
		};
	}, [file.id]);
	const toggleGadget = (id: string) => api.patch(`/api/w/${ws.id}/files/${file.id}`, { gadgets: file.gadgets.includes(id) ? file.gadgets.filter((g) => g !== id) : [...file.gadgets, id] });

	return (
		<Dialog onClose={onClose}>
			<div className="row" style={{ marginBottom: 6 }}>
				{canEdit ? (
					<input className="input grow" style={{ font: "600 18px var(--display)" }} value={name} onChange={(e) => setName(e.target.value)} onBlur={() => name !== file.name && api.patch(`/api/w/${ws.id}/files/${file.id}`, { name })} />
				) : (
					<h2 className="grow">{file.name}</h2>
				)}
				<button className="btn ghost small" onClick={onClose}>
					✕
				</button>
			</div>
			<div className="mono muted" style={{ fontSize: 11.5, marginBottom: 12 }}>
				{file.kind} · {file.mime} · {formatBytes(file.size)} · {SOURCE[file.source]} by {file.createdBy} · {new Date(file.createdAt).toLocaleString()}
			</div>
			{isImage(file) ? (
				<img src={fileUrl(ws.id, file.id, true)} style={{ maxWidth: "100%", maxHeight: "55vh", borderRadius: 10, display: "block", margin: "0 auto" }} />
			) : isTextual(file) ? (
				<div className="preview">{textBody ?? "Loading…"}</div>
			) : (
				<div className="card muted" style={{ textAlign: "center", padding: 26 }}>
					No built-in preview for <b>{file.kind}</b>. The agent can take it apart — and build a gadget to view it.
				</div>
			)}
			<div style={{ marginTop: 14 }}>
				<div className="label" style={{ marginBottom: 6 }}>
					Gadgets that can read this file
				</div>
				{gadgets.length === 0 && <div className="muted" style={{ fontSize: 13 }}>No gadgets in this workspace.</div>}
				<div className="row" style={{ flexWrap: "wrap" }}>
					{gadgets.map((g) => (
						<label key={g.id} className="pill" style={{ cursor: canEdit ? "pointer" : "default", padding: "3px 10px" }}>
							<input type="checkbox" disabled={!canEdit} checked={file.gadgets.includes(g.id)} onChange={() => toggleGadget(g.id)} style={{ margin: 0 }} /> {g.icon} {g.name}
						</label>
					))}
				</div>
			</div>
			<div className="row" style={{ marginTop: 16 }}>
				<span className="grow" />
				<a className="btn" href={fileUrl(ws.id, file.id)}>
					Download
				</a>
				{canEdit && (
					<button className="btn primary" onClick={onAsk}>
						Ask the agent about it
					</button>
				)}
			</div>
		</Dialog>
	);
}
