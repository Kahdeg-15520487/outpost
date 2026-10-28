/**
 * The blueprint card inside a module: where this module came from, whether the blueprint has moved
 * on, and the two directions of the loop — take the new version, or publish these changes as the next
 * one. The changelog is a field here, because it used to be hand-written prose stuffed into the
 * blueprint's description.
 */

import { useEffect, useState } from "react";
import { api, formatBytes, type Blueprint, type FileChange, type ModuleBlueprint } from "../api";
import { askConfirm, reportError } from "../dialogs";
import { toast } from "../toasts";
import { BlueprintSheet } from "./BlueprintSheet";
import { timeAgo } from "../store";

const STATUS: Record<FileChange["status"], string> = { added: "+", removed: "−", changed: "~", same: "=" };

export function BlueprintCard({ moduleId, workspaceId, name, canEdit }: { moduleId: string; workspaceId: string; name: string; canEdit: boolean }) {
	const [info, setInfo] = useState<ModuleBlueprint>();
	const [open, setOpen] = useState<Blueprint>();
	const [busy, setBusy] = useState("");
	const [published, setPublished] = useState<{ version: number; name: string; compat: { status: string; issues: string[]; notes: string[] }; modules: number }>();
	const [form, setForm] = useState({ changelog: "", description: "", visibility: "public" });
	const [offered, setOffered] = useState<Blueprint[]>([]);
	const [adoptId, setAdoptId] = useState("");

	const load = () =>
		api
			.get(`/api/w/${workspaceId}/modules/${moduleId}/blueprint`)
			.then((r) => setInfo(r as ModuleBlueprint))
			.catch(() => {});

	useEffect(() => {
		void load();
		// Only needed for the orphan case, but the list is small and this keeps the card self-contained.
		api.get("/api/blueprints").then((r) => setOffered(r.blueprints)).catch(() => {});
	}, [moduleId]);

	const adopt = async () => {
		if (!adoptId) return;
		setBusy("adopt");
		try {
			const r = await api.post(`/api/w/${workspaceId}/modules/${moduleId}/blueprint`, { blueprintId: adoptId });
			await load();
			toast({ kind: "info", text: `Adopted ${r.version === undefined ? "the blueprint" : `v${r.version}`} — ${r.changed?.length ?? 0} file(s) replaced.` });
		} catch (e) {
			reportError(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy("");
		}
	};

	const publish = async () => {
		if (!form.changelog.trim()) return reportError("Say what changed in this version — one line is enough.");
		setBusy("publish");
		try {
			const r = await api.post("/api/blueprints", { moduleId, name: info?.builtFrom?.name ?? name, ...form });
			await load();
			// How many modules this version can be rolled out to: the sheet knows, so count from the blueprint.
			const detail = await api.get(`/api/blueprints/${r.blueprint.id}`).catch(() => undefined);
			setPublished({ version: r.blueprint.version, name: r.blueprint.name, compat: r.compat, modules: detail?.modulesUsing?.filter((m: { hidden: boolean }) => !m.hidden).length ?? 0 });
			setForm({ ...form, changelog: "" });
		} catch (e) {
			reportError(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy("");
		}
	};

	const takeUpdate = async () => {
		const changed = info?.changed ?? [];
		const ok = await askConfirm({
			title: `Update to v${info?.current?.version}?`,
			body: changed.length
				? `${changed.length} file${changed.length === 1 ? "" : "s"} here differ from the blueprint and will be replaced:\n\n${changed.map((c) => `${c.path}`).join("\n")}`
				: "This module takes the blueprint's current files.",
			confirmLabel: "Update",
		});
		if (!ok) return;
		setBusy("update");
		try {
			const r = await api.post(`/api/w/${workspaceId}/modules/${moduleId}/blueprint`, {});
			await load();
			toast({ kind: "info", text: `Moved to v${r.version}${r.changed.length ? ` — ${r.changed.length} file${r.changed.length === 1 ? "" : "s"} replaced` : ""}.` });
		} catch (e) {
			reportError(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy("");
		}
	};

	const builtFrom = info?.builtFrom;
	const current = info?.current;
	const behind = info?.behind ?? 0;
	/** Its blueprint was deleted: the module runs, but nothing can ever update it again. */
	const orphan = info && !builtFrom && info.missing === true;

	return (
		<div className="card">
			<h3>Blueprint</h3>
			{!info && <div className="muted" style={{ fontSize: 13 }}>Loading…</div>}
			{info && !builtFrom && !orphan && <div className="muted" style={{ fontSize: 13 }}>This module was written from scratch. Publishing it creates a blueprint other people can build on.</div>}
			{orphan && (
				<div className="bp-note">
					<div>
						<b>Its blueprint no longer exists.</b> The module keeps running, but no version can reach it. Adopt a blueprint to take its code — the module keeps its data, files and shares.
					</div>
					{canEdit && (
						<div className="row">
							<select className="input" style={{ maxWidth: 260 }} value={adoptId} onChange={(e) => setAdoptId(e.target.value)}>
								<option value="">Choose a blueprint…</option>
								{offered.map((b) => (
									<option key={b.id} value={b.id}>
										{b.name} v{b.version}
									</option>
								))}
							</select>
							<button className="btn small" disabled={!adoptId || busy === "adopt"} onClick={adopt}>
								{busy === "adopt" ? "Adopting…" : "Adopt"}
							</button>
						</div>
					)}
				</div>
			)}
			{builtFrom && (
				<>
					<div className="row bp-from">
						<button className="btn ghost small" onClick={() => setOpen({ id: builtFrom.id, name: builtFrom.name, version: builtFrom.version } as Blueprint)} title="Open the blueprint, read-only">
							{builtFrom.name} v{builtFrom.version} ↗
						</button>
						<span className="grow" />
						{behind > 0 ? <span className="pill signal">v{current?.version} available</span> : <span className="pill ok">up to date</span>}
					</div>
					{behind > 0 && current && (
						<div className="bp-note">
							<div>
								<b>v{current.version} — {current.changelog || "no changelog"}</b>
								<div className="mono muted" style={{ fontSize: 11 }}>
									{current.updatedAt ? timeAgo(current.updatedAt) : ""}
								</div>
							</div>
							{info.changed.length > 0 && (
								<div className="bp-diff">
									{info.changed.map((change) => (
										<div key={change.path} className="bp-diff-row">
											<span className={`bp-diff-status ${change.status}`}>{STATUS[change.status]}</span>
											<span className="mono grow">{change.path}</span>
											<span className="muted mono">{change.after !== undefined ? formatBytes(change.after) : "gone"}</span>
										</div>
									))}
								</div>
							)}
							{canEdit && (
								<button className="btn small" onClick={takeUpdate} disabled={busy === "update"}>
									{busy === "update" ? "Updating…" : `Update to v${current.version}`}
								</button>
							)}
						</div>
					)}
				</>
			)}

			{canEdit && (
				<div className="bp-publish">
					<div className="label">{builtFrom ? `Publish these changes as v${(current?.version ?? builtFrom.version) + 1}` : "Publish as a new blueprint"}</div>
					<input className="input" value={form.changelog} onChange={(e) => setForm({ ...form, changelog: e.target.value })} placeholder="What changed? one line, e.g. “cover image field + keyboard nav”" maxLength={400} />
					<input className="input" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="Catalogue blurb: what the app is for (not a changelog)" />
					<div className="row">
						<select className="input" style={{ width: 140 }} value={form.visibility} onChange={(e) => setForm({ ...form, visibility: e.target.value })}>
							<option value="public">Everyone</option>
							<option value="private">Only me</option>
						</select>
						<span className="grow" />
						<button className="btn primary small" onClick={publish} disabled={busy === "publish" || !form.changelog.trim()}>
							{busy === "publish" ? "Publishing…" : "Publish"}
						</button>
					</div>
					{published && (
						<div className={`bp-compat ${published.compat.status}`}>
							<b>
								Published {published.name} v{published.version} ✓
							</b>
							{[...published.compat.issues, ...published.compat.notes].map((line, i) => (
								<div key={i}>· {line}</div>
							))}
							{published.modules > 1 && <div>· {published.modules} modules are on this blueprint — open it to move them all to v{published.version}.</div>}
						</div>
					)}
				</div>
			)}

			{open && <BlueprintSheet blueprint={open} ws={workspaceId} canEdit={canEdit} onClose={() => setOpen(undefined)} onChanged={load} />}
		</div>
	);
}
