import { useEffect, useState } from "react";
import { api, type Blueprint, type Workspace } from "../api";
import { chatHref, navigate } from "../store";
import { socket } from "../socket";
import { EditableLabel } from "./RowMenu";

export function BlueprintsPage({ ws }: { ws: Workspace }) {
	const [list, setList] = useState<Blueprint[]>([]);
	const [busy, setBusy] = useState<string>();
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
					<h1>Blueprints</h1>
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
		</div>
	);
}

function Grid({ list, busy, onUse, canUse, onDelete }: { list: Blueprint[]; busy?: string; onUse: (b: Blueprint) => void; canUse: boolean; onDelete?: (b: Blueprint) => void }) {
	return (
		<div className="bp-grid">
			{list.map((b, i) => (
				<div key={b.id} className="bp" style={{ animationDelay: `${i * 40}ms` }}>
					<div className="i">{b.icon}</div>
					<div className="n">
						<EditableLabel value={b.name} maxLength={80} onSave={b.mine ? (name) => api.patch(`/api/blueprints/${b.id}`, { name }) : undefined} />
					</div>
					<div className="d">{b.description}</div>
					<div className="row" style={{ marginTop: 8 }}>
						<span className="mono muted grow" style={{ fontSize: 11 }}>
							{b.author} · {b.fileCount} files{b.visibility === "private" ? " · private" : ""}
						</span>
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
