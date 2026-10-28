/**
 * Markdown to sanitized HTML, with none of the artifact logic. Kept apart from bits.tsx so an
 * artifact can render its own Markdown without importing the component that renders artifacts.
 */

import { useMemo } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";

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

export function RawMarkdown({ text, className }: { text: string; className?: string }) {
	const html = useMemo(() => markdownHtml(text), [text]);
	return <div className={`prose ${className ?? ""}`} dangerouslySetInnerHTML={{ __html: html }} />;
}
