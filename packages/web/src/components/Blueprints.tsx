import { useEffect, useState } from "react";
import { api, type Blueprint, type Workspace } from "../api";
import { chatHref, navigate } from "../store";
import { socket } from "../socket";
import { useWorkspace } from "../store";
import { ExportDialog, ImportDialog, exportBlueprint } from "./Transfer";
import { NavToggle } from "./bits";
import { askConfirm, reportError } from "../dialogs";
import { BlueprintSheet } from "./BlueprintSheet";
import { timeAgo } from "../store";

export function BlueprintsPage({ ws }: { ws: Workspace }) {
	const [list, setList] = useState<Blueprint[]>([]);
	const [busy, setBusy] = useState<string>();
	const [dialog, setDialog] = useState<"import" | "export">();
	/** The blueprint being inspected: read-only, nothing is created until you ask for it. */
	const [open, setOpen] = useState<Blueprint>();
	const { modules } = useWorkspace(ws.id);
	const canEdit = ws.role !== "viewer";
	const load = () => api.get("/api/blueprints").then((r) => setList(r.blueprints));
	useEffect(() => {
		load();
		return socket.on((m) => m.t === "blueprints.changed" && load());
	}, []);

	const use = async (bp: Blueprint) => {
		setBusy(bp.id);
		try {
			const r = await api.post(`/api/w/${ws.id}/modules`, { name: bp.name, blueprintId: bp.id });
			navigate(chatHref(ws.id, undefined, r.module.id, true));
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
						<NavToggle />
						<h1 className="grow">Blueprints</h1>
						{canEdit && (
							<>
								<button className="btn small" onClick={() => setDialog("import")} title="Import blueprints and modules from a .outpost.json file">
									Import…
								</button>
								<button className="btn small" onClick={() => setDialog("export")} title="Export your blueprints and this workspace's modules to move them to another Outpost instance">
									Export…
								</button>
							</>
						)}
					</div>
					<p className="lede">A blueprint is a whole app, not a template of content. Using one gives you a private instance — your own server, your own data — that you or your agent can change freely.</p>
					<Grid list={builtin} busy={busy} onUse={use} onOpen={setOpen} canUse={ws.role !== "viewer"} />
					{community.length > 0 && (
						<>
							<div className="label" style={{ margin: "34px 0 12px" }}>
								Published by people
							</div>
							<Grid list={community} busy={busy} onUse={use} onOpen={setOpen} canUse={ws.role !== "viewer"} onDelete={(b) => api.del(`/api/blueprints/${b.id}`).then(load)} />
						</>
					)}
				</div>
			</div>
			{open && <BlueprintSheet blueprint={open} ws={ws.id} canEdit={ws.role !== "viewer"} onClose={() => setOpen(undefined)} onChanged={load} />}
			{dialog === "import" && <ImportDialog ws={ws} onClose={() => setDialog(undefined)} onImported={load} />}
			{dialog === "export" && <ExportDialog ws={ws} mine={community.filter((b) => b.mine).length} modules={modules.length} onClose={() => setDialog(undefined)} />}
		</div>
	);
}

function Grid({ list, busy, onUse, onOpen, canUse, onDelete }: { list: Blueprint[]; busy?: string; onUse: (b: Blueprint) => void; onOpen: (b: Blueprint) => void; canUse: boolean; onDelete?: (b: Blueprint) => void }) {
	return (
		<div className="bp-grid">
			{list.map((b, i) => (
				<div
					key={b.id}
					className="bp"
					style={{ animationDelay: `${i * 40}ms` }}
					role="button"
					tabIndex={0}
					onClick={() => onOpen(b)}
					onKeyDown={(e) => e.key === "Enter" && onOpen(b)}
					title="Open: files, API, versions, who uses it — without creating anything"
				>
					<div className="i">{b.icon}</div>
					<div className="n">
						{b.name}
						<span className="pill bp-version">v{b.version}</span>
					</div>
					<div className="d">{b.changelog || b.description}</div>
					<div className="mono muted bp-meta">
						{b.author} · {b.fileCount} files{b.modulesUsing ? ` · used by ${b.modulesUsing}` : ""}
						{b.visibility === "private" ? " · private" : ""}
						{b.updatedAt ? ` · ${timeAgo(b.updatedAt)}` : ""}
					</div>
					<div className="row bp-actions">
						<span className="grow" />
						<button className="btn ghost small" onClick={(e) => (e.stopPropagation(), exportBlueprint(b.id).catch((err) => reportError(err.message)))} title="Download as a .outpost.json file to import on another Outpost instance">
							Export
						</button>
						{onDelete && b.mine && (
							<button className="btn ghost small" onClick={(e) => (e.stopPropagation(), void askConfirm({ title: `Delete blueprint “${b.name}”?`, body: "Its files are removed for everyone it was published to.", danger: true, confirmLabel: "Delete" }).then((ok) => {
								if (ok) void onDelete(b);
							}))}>
								Delete
							</button>
						)}
						{canUse && (
							<button className="btn primary small" disabled={busy === b.id} onClick={(e) => (e.stopPropagation(), onUse(b))}>
								{busy === b.id ? "Creating…" : "Use"}
							</button>
						)}
					</div>
				</div>
			))}
		</div>
	);
}
