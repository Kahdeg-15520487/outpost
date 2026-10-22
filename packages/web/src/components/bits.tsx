import { useMemo } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";

const PALETTE = ["#d9480f", "#1971c2", "#2b8a3e", "#9c36b5", "#c2860a", "#0c8599", "#c2255c"];
export const colorFor = (s: string) => PALETTE[[...s].reduce((a, c) => a + c.charCodeAt(0), 0) % PALETTE.length]!;

export function Avatar({ name, size = 24 }: { name: string; size?: number }) {
	return (
		<span className="avatar" title={name} style={{ background: colorFor(name), width: size, height: size }}>
			{name.slice(0, 1).toUpperCase()}
		</span>
	);
}

marked.setOptions({ gfm: true, breaks: false });
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
	if (node.tagName === "A") {
		node.setAttribute("target", "_blank");
		node.setAttribute("rel", "noopener noreferrer");
	}
});

export function Markdown({ text, streaming }: { text: string; streaming?: boolean }) {
	const html = useMemo(() => DOMPurify.sanitize(marked.parse(text, { async: false }) as string), [text]);
	return <div className={`prose ${streaming ? "cursor-blink" : ""}`} dangerouslySetInnerHTML={{ __html: html }} />;
}

export function Dialog({ onClose, children }: { onClose: () => void; children: React.ReactNode }) {
	return (
		<>
			<div className="scrim" onClick={onClose} />
			<div className="dialog" role="dialog">
				{children}
			</div>
		</>
	);
}
