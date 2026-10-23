import { useEffect, useState } from "react";
import { api, type Blueprint, type Workspace } from "../api";
import { chatHref, navigate } from "../store";
import { socket } from "../socket";
import { useWorkspace } from "../store";
import { ExportDialog, ImportDialog, exportBlueprint } from "./Transfer";

export function BlueprintsPage({ ws }: { ws: Workspace }) {
	const [list, setList] = useState<Blueprint[]>([]);
	const [busy, setBusy] = useState<string>();
	const [dialog, setDialog] = useState<"import" | "export">();
	const { gadgets } = useWorkspace(ws.id);
	const canEdit = ws.role !== "viewer";
	const load = () => api.get("/api/blueprints").then((r) => setList(r.blueprints));
	useEffect(() => {
		load();
		return socket.on((m) => m.t === "blueprints.changed" && load());
	}, []);

	const use = async (bp: Blueprint) => {
		setBusy(bp.id);
		try {
			const r = await api.post(`/api/w/${ws.id}/gadgets`, { name: bp.name, blueprintId: bp.id });
			navigate(chatHref(ws.id, undefined, r.gadget.id, true));
		} finally {
			setBusy(undefined);
		}
	};
	const builtin = list.filter((b) => !b.authorId);
	const community = list.filter((b) => b.authorId);

	return (
		<div className="main">
			<div className="page">
				<div className="page-inner">
					<div className="row bp-head">
						<h1 className="grow">Blueprints</h1>
						{canEdit && (
							<>
								<button className="btn small" onClick={() => setDialog("import")} title="Import blueprints and gadgets from a .pios.json file">
									Import…
								</button>
								<button className="btn small" onClick={() => setDialog("export")} title="Export your blueprints and this workspace's gadgets to move them to another pi-os">
									Export…
								</button>
							</>
						)}
					</div>
					<p className="lede">A blueprint is a whole app, not a template of content. Using one gives you a private instance — your own server, your own data — that you or your agent can change freely.</p>
					<Grid list={builtin} busy={busy} onUse={use} canUse={ws.role !== "viewer"} />
					{community.length > 0 && (
						<>
							<div className="label" style={{ margin: "34px 0 12px" }}>
								Published by people
							</div>
							<Grid list={community} busy={busy} onUse={use} canUse={ws.role !== "viewer"} onDelete={(b) => api.del(`/api/blueprints/${b.id}`).then(load)} />
						</>
					)}
				</div>
			</div>
			{dialog === "import" && <ImportDialog ws={ws} onClose={() => setDialog(undefined)} onImported={load} />}
			{dialog === "export" && <ExportDialog ws={ws} mine={community.filter((b) => b.mine).length} gadgets={gadgets.length} onClose={() => setDialog(undefined)} />}
		</div>
	);
}

function Grid({ list, busy, onUse, canUse, onDelete }: { list: Blueprint[]; busy?: string; onUse: (b: Blueprint) => void; canUse: boolean; onDelete?: (b: Blueprint) => void }) {
	return (
		<div className="bp-grid">
			{list.map((b, i) => (
				<div key={b.id} className="bp" style={{ animationDelay: `${i * 40}ms` }}>
					<div className="i">{b.icon}</div>
					<div className="n">{b.name}</div>
					<div className="d">{b.description}</div>
					<div className="mono muted bp-meta">
						{b.author} · {b.fileCount} files{b.visibility === "private" ? " · private" : ""}
					</div>
					<div className="row bp-actions">
						<span className="grow" />
						<button className="btn ghost small" onClick={() => exportBlueprint(b.id).catch((e) => alert(e.message))} title="Download as a .pios.json file to import on another pi-os">
							Export
						</button>
						{onDelete && b.mine && (
							<button className="btn ghost small" onClick={() => confirm(`Delete blueprint “${b.name}”?`) && onDelete(b)}>
								Delete
							</button>
						)}
						{canUse && (
							<button className="btn primary small" disabled={busy === b.id} onClick={() => onUse(b)}>
								{busy === b.id ? "Creating…" : "Use"}
							</button>
						)}
					</div>
				</div>
			))}
		</div>
	);
}
