/**
 * An artifact card: a workspace file rendered inside the conversation, interactive.
 * The agent embeds one with a marker line (`![[f_…]]`); the same card backs anything the
 * renderer knows how to show — tables, JSON, Markdown, HTML, documents, archives, images.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { fileUrl } from "../api";
import { cachedJson, forgetParsed } from "../parsedCache";
import { navigate, useRoute } from "../store";
import { toast } from "../toasts";
import { DataTable } from "../artifacts/DataTable";
import { DocView } from "../artifacts/DocView";
import { HtmlView } from "../artifacts/HtmlView";
import { JsonView } from "../artifacts/JsonView";
import { gridFromSheet, type Grid } from "../artifacts/table";

/** The parsed file model, as the parsers build it (see server/src/files/parse/model.ts). */
type Model = {
	text?: string;
	value?: unknown;
	sheets?: { name: string; rows: number; cols: number; cells: any[] }[];
	entries?: { path: string; size: number; packed?: number; method?: string }[];
	reason?: string;
	stats?: Record<string, number>;
};

/** The envelope `GET /files/:id/parsed?view=json` returns: metadata on top, the model under `parsed`. */
type Parsed = {
	id: string;
	kind: string;
	format: string;
	engine?: string;
	name: string;
	size: number;
	summary?: string;
	notes?: string[];
	parsed?: Model;
};

const BADGE: Record<string, string> = {
	sheets: "table",
	json: "json",
	document: "doc",
	slides: "slides",
	pages: "pages",
	archive: "archive",
	text: "text",
	opaque: "file",
};

const ICON: Record<string, string> = { table: "▦", json: "{}", doc: "📄", slides: "🖼", pages: "📕", archive: "🗜", text: "📃", html: "◇", md: "📝", file: "📎" };

const bytes = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

export function Artifact({ id, title, ws }: { id: string; title?: string; ws?: string }) {
	const route = useRoute();
	const wsId = ws ?? ("ws" in route ? route.ws : undefined);
	const [data, setData] = useState<Parsed>();
	const [source, setSource] = useState<string>();
	const [markdown, setMarkdown] = useState<string>();
	const [error, setError] = useState<string>();
	const [tick, setTick] = useState(0);
	const [open, setOpen] = useState(true);
	const [sheet, setSheet] = useState(0);

	useEffect(() => {
		if (!wsId) return;
		let live = true;
		setError(undefined);
		cachedJson(`/api/w/${wsId}/files/${id}/parsed?view=json`, { refresh: tick > 0 })
			.then((r: Parsed & { error?: string }) => {
				if (!live) return;
				if (r.error) setError(r.error);
				else setData(r);
			})
			.catch((e: Error) => live && setError(e.message));
		return () => {
			live = false;
		};
	}, [wsId, id, tick]);

	const model = data?.parsed;
	const refresh = () => {
		setData(undefined);
		setMarkdown(undefined);
		setTick((n) => n + 1);
		void forgetParsed(id);
	};

	// A .html file parses into blocks, which is great for reading and useless for running it: keep the
	// original bytes as well and hand them to the sandboxed frame.
	const looksHtml = /\.html?$/i.test(data?.name ?? "");
	useEffect(() => {
		if (!wsId || !looksHtml || model?.text) return;
		let live = true;
		fetch(`/api/w/${wsId}/files/${id}`, { credentials: "same-origin" })
			.then((r) => (r.ok ? r.text() : undefined))
			.then((text) => live && text !== undefined && setSource(text))
			.catch(() => undefined);
		return () => {
			live = false;
		};
	}, [wsId, id, looksHtml, model?.text]);

	const saveText = useCallback(
		async (next: string) => {
			if (!wsId) return;
			const res = await fetch(`/api/w/${wsId}/files/${id}/content`, { method: "PUT", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: next }) });
			if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? String(res.status));
			setData((d) => (d ? { ...d, text: next } : d));
			await forgetParsed(id);
		},
		[wsId, id],
	);

	const rendered = async (view: "markdown") => {
		if (!wsId) return;
		const r = await cachedJson(`/api/w/${wsId}/files/${id}/parsed?view=${view}`);
		if (typeof r[view] === "string") setMarkdown(r[view]);
		else toast({ text: `Could not render: ${r.error ?? "empty"}` });
	};

	const archiveGrid: Grid | undefined = useMemo(() => {
		if (!model?.entries) return undefined;
		const header = ["path", "size", "packed", "method"];
		return { header, rows: model.entries.map((e) => [e.path, e.size, e.packed ?? null, e.method ?? null]), sheet: `${model.entries.length} entries` };
	}, [model]);

	if (!wsId) return null;
	// `format` is a human label ("text (.md)", "delimited"), so branch on the real extension.
	const ext = /\.([a-z0-9]+)$/i.exec(data?.name ?? "")?.[1]?.toLowerCase() ?? "";
	const isMd = ext === "md" || ext === "markdown";
	const isHtml = ext === "html" || ext === "htm";
	const badge = data ? (data.kind === "text" ? (isMd ? "md" : isHtml ? "html" : "text") : (BADGE[data.kind] ?? data.kind)) : "file";
	const label = title ?? data?.name ?? id;
	const isImage = data?.kind === "opaque" && /^(png|jpe?g|gif|webp|bmp)$/i.test(data.format);
	const body = (() => {
		if (error) return <div className="artifact-error">{error} <button className="btn ghost small" onClick={refresh}>Retry</button></div>;
		if (!data) return <div className="artifact-loading">Rendering {id}…</div>;
		// An .html artifact is a running page, whatever the parser made of its blocks.
		if (isHtml && model?.text) return <HtmlView html={model.text} title={data.name} />;
		if (isHtml) return source ? <HtmlView html={source} title={data.name} /> : <div className="artifact-loading">Loading the page…</div>;
		if (data.kind === "sheets" && model?.sheets?.length) {
			const sheetData = model.sheets[sheet] ?? model.sheets[0]!;
			return (
				<>
					{model.sheets.length > 1 && (
						<div className="artifact-tools art-sheets">
							{model.sheets.map((s, i) => (
								<button key={i} className={`btn ghost small${i === sheet ? " on" : ""}`} onClick={() => setSheet(i)}>
									{s.name}
								</button>
							))}
						</div>
					)}
					<DataTable grid={gridFromSheet(sheetData)} ws={wsId} fileId={id} />
				</>
			);
		}
		if (data.kind === "json") return <JsonView value={model?.value} ws={wsId} fileId={id} name={data.name} />;
		if (data.kind === "text") {
			if (isMd) return <DocView text={model?.text ?? ""} editable onChange={saveText} />;
			return <pre className="preview art-source">{(model?.text ?? "").slice(0, 200_000)}</pre>;
		}
		if (data.kind === "archive" && archiveGrid) return <DataTable grid={archiveGrid} ws={wsId} fileId={id} />;
		if (isImage) return <img className="art-image" src={fileUrl(wsId, id, true)} alt={label} />;
		if (markdown) return <DocView text={markdown} />;
		if (data.kind === "document" || data.kind === "slides" || data.kind === "pages") {
			return (
				<div className="artifact-empty">
					<div>{data.summary ?? "Parsed."}</div>
					<button className="btn ghost small" onClick={() => void rendered("markdown")}>
						View rendered
					</button>
				</div>
			);
		}
		return (
			<div className="artifact-empty">
				<div>{model?.reason ?? data.summary ?? "No preview for this file."}</div>
				<a className="btn ghost small" href={fileUrl(wsId, id)} download>
					Download
				</a>
			</div>
		);
	})();

	return (
		<section className={`artifact${open ? "" : " closed"}`} data-artifact={id} data-kind={data?.kind ?? "loading"} data-view={badge}>
			<header className="artifact-head">
				<button className="artifact-toggle" onClick={() => setOpen(!open)} title={open ? "Collapse" : "Expand"}>
					{open ? "▾" : "▸"}
				</button>
				<span className="artifact-icon">{ICON[badge] ?? "📎"}</span>
				<div className="artifact-title">
					<div className="artifact-name">{label}</div>
					<div className="artifact-sub mono muted">
						{badge} · {data ? bytes(data.size) : "…"}
						{data?.engine ? ` · ${data.engine}` : ""}
					</div>
				</div>
				<div className="artifact-actions">
					{wsId && (
						<button className="btn ghost small" onClick={() => navigate(`#/w/${wsId}/files`)} title="Open in Files">
							Files
						</button>
					)}
					{wsId && (
						<a className="btn ghost small" href={fileUrl(wsId, id)} download title="Download">
							↓
						</a>
					)}
					<button className="btn ghost small" onClick={refresh} title="Re-parse">
						↻
					</button>
				</div>
			</header>
			{open && <div className="artifact-body">{body}</div>}
		</section>
	);
}
