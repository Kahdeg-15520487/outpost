/**
 * The navigation panel's open state, kept outside React so any screen can open it without threading a
 * prop through every page: below the shell breakpoint the sidebar is off-canvas, and the button that
 * fetches it lives in each screen's own header row.
 */
let open = false;
const listeners = new Set<() => void>();

const emit = () => {
	for (const listener of listeners) listener();
};

export const nav = {
	isOpen: () => open,
	set(next: boolean) {
		if (next === open) return;
		open = next;
		emit();
	},
	toggle() {
		nav.set(!open);
	},
	subscribe(listener: () => void) {
		listeners.add(listener);
		return () => {
			listeners.delete(listener);
		};
	},
};

// Navigating away closes the panel: the link you tapped is the thing you wanted to see, not the menu.
addEventListener("hashchange", () => nav.set(false));
// ...and so does Escape, like any other overlay.
addEventListener("keydown", (e) => {
	if (e.key === "Escape") nav.set(false);
});
