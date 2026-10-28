/**
 * Markdown to sanitized HTML, with none of the artifact logic. Kept apart from bits.tsx so an
 * artifact can render its own Markdown without importing the component that renders artifacts.
 *
 * ```mermaid fences are drawn: the code block stays where it is in the document (a fence inside a
 * list still sits in its list item) but is hidden, and a diagram card takes its place. A fence
 * that is still being written keeps showing its source until the message settles.
 */

import { useEffect, useMemo, useRef } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { diagramCard, isDiagramLang, type DiagramCard } from "./mermaid";

marked.setOptions({ gfm: true, breaks: false });
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
	if (node.tagName === "A") {
		node.setAttribute("target", "_blank");
		node.setAttribute("rel", "noopener noreferrer");
	}
});

export function markdownHtml(text: string): string {
	return DOMPurify.sanitize(marked.parse(text, { async: false }) as string);
}

/** `language-mermaid` on the inner `<code>` is how marked marks a fenced block's language. */
function fenceLanguage(code: HTMLElement): string {
	for (const cls of code.classList) if (cls.startsWith("language-")) return cls.slice("language-".length);
	return "";
}

export function RawMarkdown({ text, className, streaming }: { text: string; className?: string; streaming?: boolean }) {
	const body = useRef<HTMLDivElement>(null);
	const html = useMemo(() => markdownHtml(text), [text]);

	useEffect(() => {
		const root = body.current;
		if (!root) return;
		const cards: DiagramCard[] = [];
		const fences = [...root.querySelectorAll<HTMLElement>("pre > code")].filter((code) => isDiagramLang(fenceLanguage(code)));
		fences.forEach((code, i) => {
			// The last fence of a message that is still arriving is usually half-written: wait.
			if (streaming && i === fences.length - 1) return;
			const pre = code.parentElement;
			if (!pre) return;
			const source = code.textContent ?? "";
			const card = diagramCard(source);
			pre.hidden = true;
			pre.after(card);
			cards.push(card);
		});
		return () => cards.forEach((card) => card.destroy());
	}, [html, streaming]);

	return <div ref={body} className={`prose ${className ?? ""}`} dangerouslySetInnerHTML={{ __html: html }} />;
}
