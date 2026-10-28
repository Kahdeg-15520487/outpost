/**
 * The parsed views of a file: readable content, the full structure, and the design model
 * (theme, fonts, colours, page setup, shape geometry) that later output generation will use.
 */

import { useEffect, useState } from "react";
import type { FileMeta } from "../api";
import { cachedJson, forgetParsed } from "../parsedCache";
import { toast } from "../toasts";

type ParsedResponse = {
	kind: string;
	format: string;
	engine: string;
	summary: string;
	notes?: string[];
	markdown?: string;
	html?: string;
	parsed?: any;
	design?: DesignInfo;
	images?: { ref: string; name: string }[];
};

type DesignInfo = {
	theme?: { name?: string; fonts?: { major?: string; minor?: string }; colors?: Record<string, string> };
	page?: { width?: number; height?: number; orient?: string; margins?: Record<string, number> };
	styles?: { id: string; name?: string; font?: string; size?: number; color?: string; bold?: boolean; italic?: boolean }[];
	fonts?: { name: string; count: number; sizes?: number[] }[];
	colors?: { value: string; count: number }[];
	shapes?: { kind: string; name?: string; x?: number; y?: number; w?: number; h?: number; fill?: string; font?: { name?: string; size?: number; color?: string }; text?: string; slide?: number }[];
	slides?: { index: number; layout?: string; background?: string; shapes: number[] }[];
	sheets?: { name: string; headerFill?: string; headerFont?: string; freeze?: string }[];
};

const CONVERTS: { to: string; label: string; kinds: RegExp }[] = [
	{ to: "markdown", label: "Markdown", kinds: /^(document|sheets|slides|pages)$/ },
	{ to: "html", label: "HTML", kinds: /^(document|sheets|slides|pages)$/ },
	{ to: "text", label: "Text", kinds: /^(document|sheets|slides|pages)$/ },
	{ to: "csv", label: "CSV", kinds: /^sheets$/ },
	{ to: "json", label: "JSON", kinds: /^(document|sheets|slides|pages|archive|json)$/ },
];

export const PARSABLE = /^(docx|xlsx|pptx|pdf|zip|tar|gzip|gz|rar|7z|csv|tsv|json|xml|html|markdown)$/;

export function ParsedViews({ ws, file, onConverted }: { ws: string; file: FileMeta; onConverted?: () => void }) {
	const [tab, setTab] = useState<"content" | "structure" | "design">("content");
	const [data, setData] = useState<ParsedResponse>();
	const [error, setError] = useState<string>();
	const [busy, setBusy] = useState<string>();

	useEffect(() => {
		setData(undefined);
		setError(undefined);
		const view = tab === "content" ? "html" : "json";
		let live = true;
		cachedJson(`/api/w/${ws}/files/${file.id}/parsed?view=${view}`)
			.then((r: ParsedResponse) => live && setData(r))
			.catch((e: Error) => live && setError(e.message));
		return () => {
			live = false;
		};
	}, [ws, file.id, tab]);

	const run = async (label: string, url: string, body: unknown) => {
		setBusy(label);
		try {
			const res = await fetch(url, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
			const json = await res.json().catch(() => ({}));
			if (!res.ok) throw new Error(json.error ?? `${res.status}`);
			await forgetParsed(file.id);
			toast({ kind: "info", text: `${label}: ${json.files?.length ?? json.count ?? 0} file(s) created` });
			onConverted?.();
		} catch (e) {
			toast({ text: `${label} failed — ${(e as Error).message}` });
		} finally {
			setBusy(undefined);
		}
	};

	const design = data?.design;
	const canConvert = CONVERTS.filter((c) => data && c.kinds.test(data.kind));

	return (
		<div className="parsed">
			<div className="parsed-head">
				<div className="tabs">
					{(["content", "structure", "design"] as const).map((t) => (
						<button key={t} className={`tab${tab === t ? " on" : ""}`} onClick={() => setTab(t)} disabled={t === "design" && data && !data.design}>
							{t === "content" ? "Content" : t === "structure" ? "Structure" : "Design"}
						</button>
					))}
				</div>
				<div className="mono muted" style={{ fontSize: 11.5 }}>
					{data ? `${data.kind} · ${data.engine}` : error ? "failed" : "parsing…"}
				</div>
			</div>
			{data && <div className="parsed-summary mono muted">{data.summary}</div>}
			{data?.notes?.length ? <div className="parsed-note">{data.notes.join(" · ")}</div> : null}
			{error && <div className="parsed-error">{error}</div>}

			<div className="parsed-body">
				{tab === "content" &&
					(data?.html !== undefined ? (
						// our own renderer escaped the text; images are data URIs from the parse
						<div className="parsed-html" dangerouslySetInnerHTML={{ __html: data.html }} />
					) : (
						<pre className="preview">{data?.markdown ?? (error ? "" : "Parsing…")}</pre>
					))}
				{tab === "structure" && <pre className="preview">{data?.parsed ? JSON.stringify(data.parsed, null, 2) : error ? "" : "Parsing…"}</pre>}
				{tab === "design" && design && <DesignView design={design} />}
			</div>

			<div className="parsed-actions">
				{canConvert.map((c) => (
					<button key={c.to} className="btn ghost small" disabled={Boolean(busy)} onClick={() => run(`Convert to ${c.label}`, `/api/w/${ws}/files/${file.id}/convert`, { to: c.to })}>
						{busy === `Convert to ${c.label}` ? "…" : `→ ${c.label}`}
					</button>
				))}
				{data?.kind === "archive" && (
					<button className="btn ghost small" disabled={Boolean(busy)} onClick={() => run("Extract", `/api/w/${ws}/files/${file.id}/extract`, {})}>
						{busy === "Extract" ? "…" : "Extract entries"}
					</button>
				)}
				<button className="btn ghost small" onClick={() => void forgetParsed(file.id).then(() => setTab(tab === "content" ? "structure" : "content"))} title="Re-parse with the current version">
					↻
				</button>
			</div>
		</div>
	);
}

function DesignView({ design }: { design: DesignInfo }) {
	const swatches = design.colors?.length ? design.colors : Object.entries(design.theme?.colors ?? {}).map(([name, value]) => ({ value, count: 0, name }));
	return (
		<div className="design">
			{design.theme && (
				<section>
					<div className="label">Theme</div>
					<div className="design-row">
						{design.theme.name && <span className="pill">{design.theme.name}</span>}
						{design.theme.fonts?.major && <span className="pill">headings {design.theme.fonts.major}</span>}
						{design.theme.fonts?.minor && design.theme.fonts.minor !== design.theme.fonts.major && <span className="pill">body {design.theme.fonts.minor}</span>}
					</div>
				</section>
			)}
			{design.page && (
				<section>
					<div className="label">Page</div>
					<div className="mono muted" style={{ fontSize: 12 }}>
						{design.page.width}×{design.page.height}px {design.page.orient}
						{design.page.margins ? ` · margins ${Object.entries(design.page.margins).map(([k, v]) => `${k} ${v}`).join(" ")}` : ""}
					</div>
				</section>
			)}
			{swatches.length > 0 && (
				<section>
					<div className="label">Colours</div>
					<div className="design-row">
						{swatches.slice(0, 14).map((c) => (
							<span key={c.value} className="swatch" title={`${c.value}${c.count ? ` · ${c.count}×` : ""}`}>
								<i style={{ background: c.value }} />
								<span className="mono">{c.value}</span>
							</span>
						))}
					</div>
				</section>
			)}
			{design.fonts?.length ? (
				<section>
					<div className="label">Fonts</div>
					<div className="design-row">
						{design.fonts.map((f) => (
							<span key={f.name} className="pill" title={`${f.count} uses`}>
								{f.name}
								{f.sizes?.length ? ` · ${f.sizes.join("/")}pt` : ""}
							</span>
						))}
					</div>
				</section>
			) : null}
			{design.styles?.length ? (
				<section>
					<div className="label">Styles ({design.styles.length})</div>
					<div className="design-styles">
						{design.styles.slice(0, 24).map((s) => (
							<div key={s.id} className="design-style mono">
								<b>{s.name ?? s.id}</b>
								<span className="muted">
									{[s.font, s.size ? `${s.size}pt` : "", s.bold ? "bold" : "", s.italic ? "italic" : "", s.color].filter(Boolean).join(" · ")}
								</span>
							</div>
						))}
					</div>
				</section>
			) : null}
			{design.sheets?.length ? (
				<section>
					<div className="label">Sheets</div>
					<div className="design-styles">
						{design.sheets.map((s) => (
							<div key={s.name} className="design-style mono">
								<b>{s.name}</b>
								<span className="muted">{[s.headerFill, s.headerFont, s.freeze ? `freeze ${s.freeze}` : ""].filter(Boolean).join(" · ")}</span>
							</div>
						))}
					</div>
				</section>
			) : null}
			{design.shapes?.length ? (
				<section>
					<div className="label">Shapes ({design.shapes.length})</div>
					<div className="design-styles">
						{design.shapes.slice(0, 30).map((s, i) => (
							<div key={i} className="design-style mono">
								<b>{s.kind}</b>
								<span className="muted">
									{[s.text?.slice(0, 40), s.w ? `${Math.round(s.w)}×${Math.round(s.h ?? 0)}` : "", s.fill, s.font?.name, s.font?.size ? `${s.font.size}pt` : ""].filter(Boolean).join(" · ")}
								</span>
							</div>
						))}
					</div>
				</section>
			) : null}
		</div>
	);
}
