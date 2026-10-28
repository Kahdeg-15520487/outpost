import { useEffect, useMemo } from "react";
import { hasEmbeds, splitEmbeds, type Segment } from "../artifacts/embeds";
import { RawMarkdown } from "../artifacts/RawMarkdown";
import { Artifact } from "./Artifact";

const PALETTE = ["#d9480f", "#1971c2", "#2b8a3e", "#9c36b5", "#c2860a", "#0c8599", "#c2255c"];
export const colorFor = (s: string) => PALETTE[[...s].reduce((a, c) => a + c.charCodeAt(0), 0) % PALETTE.length]!;

export function Avatar({ name, size = 24 }: { name: string; size?: number }) {
	return (
		<span className="avatar" title={name} style={{ background: colorFor(name), width: size, height: size }}>
			{name.slice(0, 1).toUpperCase()}
		</span>
	);
}

export { RawMarkdown };

/**
 * Markdown, with artifacts: a line like `![[f_…]]` becomes the file itself, rendered inline and
 * interactive, instead of a link or a wall of text. Everything else renders as prose.
 */
export function Markdown({ text, streaming }: { text: string; streaming?: boolean }) {
	const segments = useMemo<Segment[]>(() => (hasEmbeds(text) ? splitEmbeds(text) : [{ kind: "md", text }]), [text]);
	return (
		<>
			{segments.map((segment, i) =>
				segment.kind === "embed" ? (
					<Artifact key={`${segment.id}-${i}`} id={segment.id} title={segment.title} />
				) : (
					<RawMarkdown key={i} text={segment.text} className={streaming && i === segments.length - 1 ? "cursor-blink" : ""} />
				),
			)}
		</>
	);
}

export function Dialog({ onClose, children, className }: { onClose: () => void; children: React.ReactNode; className?: string }) {
	useEffect(() => {
		const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
		addEventListener("keydown", key);
		return () => removeEventListener("keydown", key);
	}, [onClose]);
	return (
		<>
			<div className="scrim" onClick={onClose} />
			<div className={`dialog ${className ?? ""}`} role="dialog">
				{children}
			</div>
		</>
	);
}
