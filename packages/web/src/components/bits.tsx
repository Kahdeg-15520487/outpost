import { useEffect, useMemo, useSyncExternalStore } from "react";
import { nav } from "../nav";
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
					<RawMarkdown
						key={i}
						text={segment.text}
						streaming={streaming && i === segments.length - 1}
						className={streaming && i === segments.length - 1 ? "cursor-blink" : ""}
					/>
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

/**
 * Opens the navigation panel. Hidden above the shell breakpoint, where the sidebar is always on
 * screen; each screen puts one in its header row so the menu is reachable from anywhere.
 */
export function NavToggle() {
	const open = useSyncExternalStore(nav.subscribe, nav.isOpen, () => false);
	return (
		<button
			type="button"
			className="nav-toggle"
			aria-label={open ? "Close navigation" : "Open navigation"}
			aria-expanded={open}
			title={open ? "Close navigation" : "Menu"}
			onClick={() => nav.toggle()}
		>
			<svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true" focusable="false">
				<path d="M3 5.5h14M3 10h14M3 14.5h14" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" />
			</svg>
		</button>
	);
}
