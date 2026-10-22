import { useEffect, useState } from "react";
import { api, type GatekeeperInfo, type Holder, type Workspace, type WorkspaceDocs } from "../api";
import { Dialog } from "./bits";

let catalog: Promise<{ gatekeepers: GatekeeperInfo[]; githubToken: boolean }> | undefined;
export const useGatekeepers = () => {
	const [list, setList] = useState<GatekeeperInfo[]>([]);
	useEffect(() => {
		(catalog ??= api.get("/api/gatekeepers")).then((r) => setList(r.gatekeepers));
	}, []);
	return list;
};

/** Grants held by one chat or gadget, and the form to introduce a new resource. */
export function ResourcesPanel({ wsId, holder, grants }: { wsId: string; holder: Holder; grants: WorkspaceDocs["grants"] }) {
	const gks = useGatekeepers();
	const [gk, setGk] = useState("github");
	const [resource, setResource] = useState("");
	const [label, setLabel] = useState("");
	const [autoApprove, setAuto] = useState(false);
	const [err, setErr] = useState("");
	const mine = Object.values(grants.grants).filter((g) => g.holder.kind === holder.kind && g.holder.id === holder.id);
	const selected = gks.find((g) => g.id === gk);

	const introduce = async (e: React.FormEvent) => {
		e.preventDefault();
		setErr("");
		try {
			await api.post(`/api/w/${wsId}/grants`, { gatekeeper: gk, resource, label: label || undefined, holder, autoApprove });
			setResource("");
			setLabel("");
		} catch (error: any) {
			setErr(error.message);
		}
	};

	return (
		<div className="panel">
			<div>
				<h3>Introduced resources</h3>
				<div className="muted" style={{ fontSize: 13 }}>
					This {holder.kind === "conversation" ? "chat's agent" : "gadget"} can reach exactly these — nothing else. {holder.kind === "gadget" && <>Server code uses <code className="mono">ctx.gatekeepers["label"].method(args)</code>.</>}
				</div>
			</div>
			{mine.length === 0 && <div className="muted" style={{ fontSize: 13.5 }}>None yet.</div>}
			{mine.map((g) => {
				const info = gks.find((x) => x.id === g.gatekeeper);
				return (
					<div key={g.id} className="card row" style={{ padding: 10 }}>
						<span style={{ fontSize: 20 }}>{info?.icon}</span>
						<div className="grow">
							<div style={{ fontWeight: 650 }}>{g.resource}</div>
							<div className="mono muted" style={{ fontSize: 11 }}>
								{info?.title} · label “{g.label}” · by {g.createdBy}
							</div>
						</div>
						<label className="row mono" style={{ fontSize: 11.5, gap: 4 }} title="Run side effects without asking">
							<input type="checkbox" checked={g.autoApprove} onChange={(e) => api.patch(`/api/w/${wsId}/grants/${g.id}`, { autoApprove: e.target.checked })} />
							auto-approve
						</label>
						<button className="btn ghost small" onClick={() => api.del(`/api/w/${wsId}/grants/${g.id}`)}>
							Revoke
						</button>
					</div>
				);
			})}
			<form onSubmit={introduce} style={{ display: "grid", gap: 10 }}>
				<div className="label">Introduce a resource</div>
				<div className="gk-grid">
					{gks.map((g) => (
						<button type="button" key={g.id} className={`gk ${g.id === gk ? "on" : ""}`} onClick={() => setGk(g.id)}>
							<div className="i">{g.icon}</div>
							<div className="n">{g.title}</div>
							<div className="d">{g.description}</div>
						</button>
					))}
				</div>
				{selected?.setup && <div className="muted" style={{ fontSize: 12.5 }}>ⓘ {selected.setup}</div>}
				<input className="input" placeholder={selected?.resourceHint ?? "resource"} value={resource} onChange={(e) => setResource(e.target.value)} required={gk !== "mailbox"} />
				<div className="row">
					<input className="input grow" placeholder="label (optional, e.g. repo)" value={label} onChange={(e) => setLabel(e.target.value)} />
					<label className="row" style={{ fontSize: 13, whiteSpace: "nowrap" }}>
						<input type="checkbox" checked={autoApprove} onChange={(e) => setAuto(e.target.checked)} /> auto-approve writes
					</label>
				</div>
				{selected && (
					<div className="mono muted" style={{ fontSize: 11.5 }}>
						{selected.methods.map((m) => `${m.name}${m.effect === "write" ? "✎" : ""}`).join(" · ")}
					</div>
				)}
				{err && <div className="err">{err}</div>}
				<div>
					<button className="btn primary">Introduce</button>
				</div>
			</form>
		</div>
	);
}

export function ResourcesDialog({ ws, holder, grants, onClose }: { ws: Workspace; holder: Holder; grants: WorkspaceDocs["grants"]; onClose: () => void }) {
	return (
		<Dialog onClose={onClose}>
			<div className="row">
				<h2 className="grow">Resources</h2>
				<button className="btn ghost small" onClick={onClose}>
					✕
				</button>
			</div>
			<div style={{ margin: "0 -18px" }}>
				<ResourcesPanel wsId={ws.id} holder={holder} grants={grants} />
			</div>
		</Dialog>
	);
}
