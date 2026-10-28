/**
 * HTML in a chat: run it in a sandboxed frame — scripts allowed so it can be interactive, no
 * network at all, and no access to the app's origin (no allow-same-origin). The frame reports
 * its height back so the card fits its content.
 */

import { useEffect, useMemo, useRef, useState } from "react";

const CSP = [
	"default-src 'none'",
	"style-src 'unsafe-inline'",
	"img-src data: blob:",
	"media-src data: blob:",
	"font-src data:",
	"script-src 'unsafe-inline' 'unsafe-eval'",
	"connect-src 'none'",
	"form-action 'none'",
	"base-uri 'none'",
].join("; ");

const BOOT = `<script>
(function () {
	function post() {
		var h = Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0);
		parent.postMessage({ outpost: "height", height: h }, "*");
	}
	addEventListener("load", post);
	addEventListener("resize", post);
	if (window.ResizeObserver) new ResizeObserver(post).observe(document.documentElement);
	setInterval(post, 400);
	document.addEventListener("click", function (e) {
		var a = e.target && e.target.closest ? e.target.closest("a[href]") : null;
		if (!a) return;
		var href = a.getAttribute("href") || "";
		if (href.charAt(0) === "#") return;
		e.preventDefault();
		parent.postMessage({ outpost: "open", href: href }, "*");
	});
	window.alert = function (m) { parent.postMessage({ outpost: "alert", text: String(m) }, "*"); };
})();
</script>`;

/** Put the CSP and the height reporter at the top of the document, whatever shape it has. */
export function wrapHtml(html: string): string {
	const meta = `<meta http-equiv="Content-Security-Policy" content="${CSP}">`;
	const head = /<head[^>]*>/i.exec(html);
	if (head) {
		const at = head.index + head[0].length;
		return html.slice(0, at) + meta + BOOT + html.slice(at);
	}
	const doc = /<html[^>]*>/i.exec(html);
	if (doc) {
		const at = doc.index + doc[0].length;
		return html.slice(0, at) + `<head>${meta}${BOOT}</head>` + html.slice(at);
	}
	return `<!doctype html><html><head><meta charset="utf-8">${meta}${BOOT}</head><body>${html}</body></html>`;
}

export function HtmlView({ html, title }: { html: string; title: string }) {
	const [height, setHeight] = useState(220);
	const [run, setRun] = useState(0);
	const [source, setSource] = useState(false);
	const frame = useRef<HTMLIFrameElement>(null);
	const srcDoc = useMemo(() => wrapHtml(html), [html]);

	useEffect(() => {
		const onMessage = (e: MessageEvent) => {
			if (e.source !== frame.current?.contentWindow) return;
			const data = e.data as { outpost?: string; height?: number; href?: string; text?: string };
			if (data?.outpost === "height" && typeof data.height === "number") setHeight(Math.min(900, Math.max(80, data.height + 2)));
			else if (data?.outpost === "open" && data.href) {
				try {
					const url = new URL(data.href, location.href);
					if (url.protocol === "http:" || url.protocol === "https:") window.open(url.href, "_blank", "noopener,noreferrer");
				} catch {
					/* ignore malformed links */
				}
			}
		};
		addEventListener("message", onMessage);
		return () => removeEventListener("message", onMessage);
	}, []);

	return (
		<div className="art-html">
			<div className="artifact-tools">
				<span className="mono muted art-count">sandboxed — scripts run, network is blocked</span>
				<div className="art-spacer" />
				<button className={`btn ghost small${source ? " on" : ""}`} onClick={() => setSource(!source)}>
					{source ? "Preview" : "Source"}
				</button>
				<button className="btn ghost small" onClick={() => setRun(run + 1)} title="Reload the frame">
					↻ Run
				</button>
			</div>
			{source ? (
				<pre className="preview art-source">{html}</pre>
			) : (
				<iframe
					key={run}
					ref={frame}
					className="art-frame"
					title={title}
					sandbox="allow-scripts allow-forms allow-modals"
					srcDoc={srcDoc}
					style={{ height }}
				/>
			)}
		</div>
	);
}
