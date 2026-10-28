/**
 * The blueprint inspector: what a blueprint contains, what it can do, who is using it, and how it got
 * here — without creating a module to find out.
 *
 * This replaces the old loop (clone the blueprint into a permanent module, read 22 KB of HTML, delete
 * nothing because there was no delete), so the sheet is read-first: every action that writes says so.
 */

import { useEffect, useMemo, useState } from "react";
import { api, formatBytes, type Blueprint, type BlueprintInfo, type FileChange } from "../api";
import { navigate, chatHref } from "../store";
import { askConfirm, reportError } from "../dialogs";
import { toast } from "../toasts";

type Tab = "overview" | "code" | "api" | "used" | "history";

const STATUS: Record<FileChange["status"], string> = { added: "+", removed: "−", changed: "~", same: "=" };

export function BlueprintSheet({
	blueprint,
	ws,
	canEdit,
	onClose,
	onChanged,
}: {
	blueprint: Blueprint;
	ws: string;
	canEdit: boolean;
	onClose: () => void;
	onChanged: () => void;
}) {
	const [info, setInfo] = useState<BlueprintInfo>();
	const [tab, setTab] = useState<Tab>("overview");
	const [file, setFile] = useState<string>();
	const [busy, setBusy] = useState("");
	const [compare, setCompare] = useState<string>();

	useEffect(() => {
		let live = true;
		setInfo(undefined);
		api
			.get(`/api/blueprints/${blueprint.id}`)
			.then((r) => live && setInfo(r as BlueprintInfo))
			.catch((e) => reportError(e.message));
		return () => {
			live = false;
		};
	}, [blueprint.id]);

	useEffect(() => {
		const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
		addEventListener("keydown", key);
		return () => removeEventListener("keydown", key);
	}, [onClose]);

	useEffect(() => {
		if (info && !file) setFile(Object.keys(info.source)[0]);
	}, [info]);

	const bp = info?.blueprint ?? blueprint;
	const paths = useMemo(() => Object.keys(info?.source ?? {}).sort(), [info]);
	const versionOf = (id: string) => info?.versions.find((v) => v.id === id);
	const previous = info ? info.versions.find((v) => v.version === bp.version - 1) : undefined;

	const run = async (what: string, fn: () => Promise<unknown>) => {
		setBusy(what);
		try {
			return await fn();
		} catch (e) {
			reportError(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy("");
		}
	};

	const use = () =>
		run("use", async () => {
			const r = await api.post(`/api/w/${ws}/modules`, { name: bp.name, blueprintId: bp.id });
			onClose();
			navigate(chatHref(ws, undefined, r.module.id, true));
		});

	const draft = () =>
		run("draft", async () => {
			const r = await api.post(`/api/w/${ws}/blueprints/${bp.id}/draft`, {});
			onClose();
			navigate(chatHref(ws, undefined, r.module.id, true));
			toast({ kind: "info", text: "Draft open — it stays out of your module list until you publish it." });
		});

	const updateModules = () =>
		run("rollout", async () => {
			const behind = info!.modulesUsing.filter((m) => !m.hidden);
			if (!behind.length) return;
			const ok = await askConfirm({
				title: `Move ${behind.length} module${behind.length === 1 ? "" : "s"} to v${bp.version}?`,
				body: `They take this blueprint's files. Local edits in those modules are replaced.\n\n${behind.map((m) => m.name).join(", ")}`,
				confirmLabel: "Update them",
			});
			if (!ok) return;
			const r = await api.post(`/api/w/${ws}/blueprints/${bp.id}/update-modules`, { modules: behind.map((m) => m.id) });
			onChanged();
			toast({ kind: "info", text: `Updated ${r.updated.length} module${r.updated.length === 1 ? "" : "s"} to v${r.version}.` });
		});

	const remove = async () => {
		const ok = await askConfirm({
			title: `Delete “${bp.name}”?`,
			body: `All ${info?.versions.length ?? 1} version${(info?.versions.length ?? 1) === 1 ? "" : "s"} go, for everyone it was published to. Modules already built from it keep their code.`,
			danger: true,
			confirmLabel: "Delete blueprint",
		});
		if (!ok) return;
		await run("delete", async () => {
			await api.del(`/api/blueprints/${bp.id}`);
			onChanged();
			onClose();
		});
	};

	// What changed: against the chosen version, or against the one before this one.
	const against = compare ?? previous?.id;
	const [diff, setDiff] = useState<{ changed: FileChange[]; apiAdded: string[]; apiRemoved: string[] }>();
	useEffect(() => {
		setDiff(undefined);
		if (!against || !info) return;
		let live = true;
		api
			.get(`/api/blueprints/${against}/diff?with=${bp.id}`)
			.then((r) => live && setDiff(r))
			.catch(() => {});
		return () => {
			live = false;
		};
	}, [against, bp.id, info]);

	return (
		<>
			<div className="scrim" onClick={onClose} />
			<div className="dialog sheet bp-sheet" role="dialog" aria-label={`${bp.name} blueprint`}>
				<div className="bp-sheet-head">
					<span className="bp-sheet-icon">{bp.icon}</span>
					<div className="grow" style={{ minWidth: 0 }}>
						<div className="bp-sheet-title">{bp.name}</div>
						<div className="mono muted bp-sheet-sub">
							v{bp.version}
							{bp.versionCount > 1 ? ` of ${bp.versionCount}` : ""} · {info?.files ? Object.keys(info.files).length : bp.fileCount} files · {bp.visibility === "private" ? "only me" : "everyone"} · {bp.author}
						</div>
					</div>
					<button className="btn ghost small" onClick={onClose} title="Close (Esc)">
						✕
					</button>
				</div>

				<div className="bp-sheet-tabs">
					{(
						[
							["overview", "Overview"],
							["code", "Code"],
							["api", `API${info ? ` ${info.api.methods.length}` : ""}`],
							["used", `Used by ${info?.modulesUsing.filter((m) => !m.hidden).length ?? 0}`],
							["history", `History ${info?.versions.length ?? 1}`],
						] as [Tab, string][]
					).map(([id, label]) => (
						<button key={id} className={`bp-tab${tab === id ? " on" : ""}`} onClick={() => setTab(id)}>
							{label}
						</button>
					))}
					<span className="grow" />
					{canEdit && (
						<button className="btn small" onClick={draft} disabled={busy === "draft"} title="Open a working copy that is not one of your modules">
							{busy === "draft" ? "Opening…" : "Edit a draft"}
						</button>
					)}
					{canEdit && (
						<button className="btn primary small" onClick={use} disabled={busy === "use"}>
							{busy === "use" ? "Creating…" : "Use"}
						</button>
					)}
				</div>

				<div className="bp-sheet-body">
					{!info && <div className="bp-empty">Loading the blueprint…</div>}

					{info && tab === "overview" && (
						<>
							{bp.changelog && <p className="bp-changelog">v{bp.version} — {bp.changelog}</p>}
							{bp.description && <p className="bp-description">{bp.description}</p>}
							<div className={`bp-compat ${info.compat.status}`}>
								<b>{info.compat.status === "ok" ? "Runs here" : info.compat.status === "warn" ? "Runs here, with notes" : "Not runnable here"}</b>
								{[...info.compat.issues, ...info.compat.notes].map((line, i) => (
									<div key={i}>· {line}</div>
								))}
							</div>
							<div className="label">Files</div>
							<div className="bp-files">
								{paths.map((path) => (
									<button key={path} className="bp-file" onClick={() => (setFile(path), setTab("code"))}>
										<span className="mono grow">{path}</span>
										<span className="muted">{info.files[path]?.lines} lines</span>
										<span className="muted">{formatBytes(info.files[path]?.size ?? 0)}</span>
									</button>
								))}
							</div>
							{info.modulesUsing.filter((m) => !m.hidden).length > 0 && (
								<>
									<div className="label">On this blueprint</div>
									<div className="bp-used">
										{info.modulesUsing
											.filter((m) => !m.hidden)
											.map((m) => (
												<div key={m.id} className="bp-used-row">
													<span className="grow">{m.name}</span>
													<span className={`pill ${m.current ? "ok" : ""}`}>{m.current ? `v${bp.version}` : "older version"}</span>
												</div>
											))}
									</div>
									{canEdit && (
										<button className="btn small" onClick={updateModules} disabled={busy === "rollout"}>
											{busy === "rollout" ? "Updating…" : `Move them to v${bp.version}`}
										</button>
									)}
								</>
							)}
						</>
					)}

					{info && tab === "code" && (
						<div className="bp-code">
							<div className="bp-code-list">
								{paths.map((path) => (
									<button key={path} className={`bp-code-file${path === file ? " on" : ""}`} onClick={() => setFile(path)}>
										{path}
									</button>
								))}
							</div>
							<div className="bp-code-body">
								<div className="bp-code-bar">
									<span className="mono">{file}</span>
									<span className="grow" />
									<button className="btn ghost small" onClick={() => navigator.clipboard.writeText(info.source[file!] ?? "").then(() => toast({ kind: "info", text: "Copied." }))}>
										Copy
									</button>
								</div>
								<pre className="bp-source">{file ? info.source[file] : "Pick a file"}</pre>
							</div>
						</div>
					)}

					{info && tab === "api" && (
						<div className="bp-api">
							{info.api.methods.length === 0 && <div className="bp-empty">No server methods declared in this blueprint.</div>}
							{info.api.methods.map((method) => (
								<div key={method} className="bp-api-row">
									<span className="mono">{method}()</span>
									{info.api.readonly.includes(method) ? <span className="pill ok">read-only</span> : <span className="pill">writes</span>}
								</div>
							))}
						</div>
					)}

					{info && tab === "used" && (
						<div className="bp-used">
							{info.modulesUsing.length === 0 && <div className="bp-empty">Nothing is built from this blueprint yet.</div>}
							{info.modulesUsing.map((m) => (
								<div key={m.id} className="bp-used-row">
									<span className="grow">
										{m.name}
										{m.hidden ? <span className="pill">draft</span> : null}
									</span>
									<span className={`pill ${m.current ? "ok" : ""}`}>{m.current ? `v${bp.version}` : "older"}</span>
								</div>
							))}
						</div>
					)}

					{info && tab === "history" && (
						<div className="bp-history">
							{info.versions.length === 1 && <div className="bp-empty">Only one version so far.</div>}
							{[...info.versions].reverse().map((v) => (
								<div key={v.id} className="bp-version">
									<span className={`pill ${v.version === bp.version ? "ok" : ""}`}>v{v.version}</span>
									<div className="grow">
										<div>{v.changelog || <span className="muted">no changelog</span>}</div>
										<div className="mono muted" style={{ fontSize: 11 }}>
											{new Date(v.updatedAt || v.createdAt || Date.now()).toLocaleString()} · {v.author ?? "outpost"}
										</div>
									</div>
									{v.version !== bp.version && (
										<button className="btn ghost small" onClick={() => setCompare(v.id)}>
											Compare
										</button>
									)}
								</div>
							))}
							{against && versionOf(against) && (
								<>
									<div className="label">
										v{versionOf(against)!.version} → v{bp.version}
										{compare && (
											<button className="btn ghost small" onClick={() => setCompare(undefined)}>
												back to previous
											</button>
										)}
									</div>
									{!diff && <div className="bp-empty">Comparing…</div>}
									{diff && diff.changed.length === 0 && <div className="bp-empty">No file changed.</div>}
									{diff && (
										<div className="bp-diff">
											{diff.changed.map((change) => (
												<div key={change.path} className="bp-diff-row">
													<span className={`bp-diff-status ${change.status}`}>{STATUS[change.status]}</span>
													<span className="mono grow">{change.path}</span>
													<span className="muted mono">
														{change.before !== undefined ? formatBytes(change.before) : "—"} → {change.after !== undefined ? formatBytes(change.after) : "—"}
													</span>
												</div>
											))}
											{diff.apiAdded.length > 0 && <div className="bp-diff-api">API added: {diff.apiAdded.join(", ")}</div>}
											{diff.apiRemoved.length > 0 && <div className="bp-diff-api removed">API removed: {diff.apiRemoved.join(", ")}</div>}
										</div>
									)}
								</>
							)}
						</div>
					)}
				</div>

				<div className="bp-sheet-foot">
					{bp.authorId && canEdit && (
						<button className="btn ghost small danger" onClick={remove} disabled={busy === "delete"}>
							Delete
						</button>
					)}
					<span className="grow" />
					<span className="muted mono" style={{ fontSize: 11 }}>
						nothing here runs unless you use it
					</span>
				</div>
			</div>
		</>
	);
}
