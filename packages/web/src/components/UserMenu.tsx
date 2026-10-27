import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { User } from "../api";
import { Avatar } from "./bits";

/**
 * The signed-in user's avatar and name at the bottom of the sidebar. Clicking opens a menu
 * (upwards, position:fixed so the scrolling sidebar can't clip it) holding Sign out.
 * Closes on outside click, Escape, scroll and resize, like the row menus.
 */
export function UserMenu({ user, onSignOut }: { user: User; onSignOut: () => void }) {
	const [open, setOpen] = useState(false);
	const [pos, setPos] = useState<{ bottom: number; left: number; width: number }>();
	const button = useRef<HTMLButtonElement>(null);
	const menu = useRef<HTMLDivElement>(null);

	useLayoutEffect(() => {
		if (!open || !button.current) return;
		const r = button.current.getBoundingClientRect();
		setPos({ bottom: innerHeight - r.top + 6, left: r.left, width: r.width });
		menu.current?.querySelector<HTMLButtonElement>("button")?.focus();
	}, [open]);

	useEffect(() => {
		if (!open) return;
		const close = (e: Event) => {
			if (e.type === "pointerdown" && (menu.current?.contains(e.target as Node) || button.current?.contains(e.target as Node))) return;
			setOpen(false);
		};
		const key = (e: KeyboardEvent) => {
			if (e.key !== "Escape") return;
			setOpen(false);
			button.current?.focus();
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

	return (
		<>
			<button ref={button} type="button" className={`who-btn ${open ? "open" : ""}`} aria-haspopup="menu" aria-expanded={open} title="Account" onClick={() => setOpen(!open)}>
				<Avatar name={user.displayName} />
				<span className="who">{user.displayName}</span>
				<span className="caret" aria-hidden>
					▴
				</span>
			</button>
			{open && (
				<div ref={menu} className="row-menu user-menu" role="menu" aria-label="Account" style={pos ? { bottom: pos.bottom, left: pos.left, minWidth: pos.width } : { visibility: "hidden" }}>
					<div className="user-menu-head">
						Signed in as <b>{user.displayName}</b>
					</div>
					<button
						type="button"
						role="menuitem"
						className="danger"
						onClick={() => {
							setOpen(false);
							onSignOut();
						}}
					>
						Sign out
					</button>
				</div>
			)}
		</>
	);
}
