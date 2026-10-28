import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { reportError } from "../dialogs";

export type MenuItem = { label: string; icon?: string; onSelect: () => void; danger?: boolean; hidden?: boolean };

/**
 * The "⋯" button on a sidebar row and its menu. The menu is position:fixed so the
 * scrolling sidebar can't clip it; it closes on outside click, Escape, scroll and resize.
 */
export function RowMenu({ label, items, onOpenChange }: { label: string; items: MenuItem[]; onOpenChange?: (open: boolean) => void }) {
	const [open, setOpen] = useState(false);
	const [pos, setPos] = useState<{ top: number; left: number }>();
	const button = useRef<HTMLButtonElement>(null);
	const menu = useRef<HTMLDivElement>(null);
	const visible = items.filter((i) => !i.hidden);

	const set = (v: boolean) => {
		setOpen(v);
		onOpenChange?.(v);
	};

	useLayoutEffect(() => {
		if (!open || !button.current) return;
		const r = button.current.getBoundingClientRect();
		const h = menu.current?.offsetHeight ?? 0;
		// Open below the button, or above it when there's no room.
		const top = r.bottom + 4 + h > innerHeight - 8 ? Math.max(8, r.top - 4 - h) : r.bottom + 4;
		setPos({ top, left: Math.min(r.left, innerWidth - 200) });
		menu.current?.querySelector<HTMLButtonElement>("button")?.focus();
	}, [open]);

	useEffect(() => {
		if (!open) return;
		const close = (e: Event) => {
			if (e.type === "pointerdown" && (menu.current?.contains(e.target as Node) || button.current?.contains(e.target as Node))) return;
			set(false);
		};
		const key = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				set(false);
				button.current?.focus();
			}
		};
		addEventListener("pointerdown", close, true);
		addEventListener("resize", close);
		addEventListener("scroll", close, true);
		addEventListener("keydown", key);
		return () => {
			removeEventListener("pointerdown", close, true);
			removeEventListener("resize", close);
			removeEventListener("scroll", close, true);
			removeEventListener("keydown", key);
		};
	}, [open]);

	if (!visible.length) return null;
	return (
		<>
			<button
				ref={button}
				type="button"
				className={`row-menu-btn ${open ? "open" : ""}`}
				aria-label={`${label} options`}
				aria-haspopup="menu"
				aria-expanded={open}
				title="More"
				onClick={(e) => {
					// The row is a link; the button must not navigate.
					e.preventDefault();
					e.stopPropagation();
					set(!open);
				}}
			>
				⋯
			</button>
			{open && (
				<div
					ref={menu}
					className="row-menu"
					role="menu"
					aria-label={label}
					style={pos ? { top: pos.top, left: pos.left } : { visibility: "hidden" }}
					onKeyDown={(e) => {
						if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
						e.preventDefault();
						const all = [...(menu.current?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
						const i = all.indexOf(document.activeElement as HTMLButtonElement);
						all[(i + (e.key === "ArrowDown" ? 1 : -1) + all.length) % all.length]?.focus();
					}}
				>
					{visible.map((item) => (
						<button
							key={item.label}
							type="button"
							role="menuitem"
							className={item.danger ? "danger" : ""}
							onClick={(e) => {
								e.preventDefault();
								e.stopPropagation();
								set(false);
								item.onSelect();
							}}
						>
							<span className="mi-ico" aria-hidden>
								{item.icon}
							</span>
							{item.label}
						</button>
					))}
				</div>
			)}
		</>
	);
}

/** In-place rename for a sidebar row: Enter or blur saves, Escape cancels. */
export function InlineRename({ value, onSave, onDone, className = "side-rename", maxLength = 120 }: { value: string; onSave: (v: string) => Promise<unknown>; onDone: () => void; className?: string; maxLength?: number }) {
	const [text, setText] = useState(value);
	const done = useRef(false);
	const finish = async (save: boolean) => {
		if (done.current) return;
		done.current = true;
		const v = text.trim();
		if (save && v && v !== value) await onSave(v).catch((e) => reportError(e.message));
		onDone();
	};
	return (
		<input
			className={className}
			value={text}
			autoFocus
			onFocus={(e) => e.currentTarget.select()}
			onChange={(e) => setText(e.target.value)}
			onClick={(e) => e.preventDefault()}
			onBlur={() => finish(true)}
			onKeyDown={(e) => {
				if (e.key === "Enter") finish(true);
				if (e.key === "Escape") finish(false);
			}}
			maxLength={maxLength}
		/>
	);
}

/**
 * A name shown as text that turns into a text box on double-click (Enter/blur saves,
 * Escape cancels). Read-only when `onSave` is absent.
 */
export function EditableLabel({ value, onSave, className, maxLength }: { value: string; onSave?: (v: string) => Promise<unknown>; className?: string; maxLength?: number }) {
	const [editing, setEditing] = useState(false);
	if (editing && onSave) return <InlineRename value={value} onSave={onSave} onDone={() => setEditing(false)} className={`label-rename ${className ?? ""}`} maxLength={maxLength} />;
	return (
		<span
			className={`${className ?? ""} ${onSave ? "renamable" : ""}`}
			title={onSave ? `${value} — double-click to rename` : value}
			onDoubleClick={
				onSave &&
				((e) => {
					e.preventDefault();
					e.stopPropagation();
					getSelection()?.removeAllRanges();
					setEditing(true);
				})
			}
		>
			{value}
		</span>
	);
}
