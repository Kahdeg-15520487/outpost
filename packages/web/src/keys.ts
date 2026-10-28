/**
 * Keyboard navigation across the shell, with the same keys the Slides module uses for moving
 * through slides: ↓/→/PageDown/Space/j advance, ↑/←/PageUp/k go back, Home/End jump to the ends,
 * Enter opens the highlighted item and Escape drops the cursor. It never runs while typing.
 */

const ITEM = "a.side-item, button.side-item, [data-nav]";

const isTyping = (el: EventTarget | null): boolean => {
	if (!(el instanceof HTMLElement)) return false;
	const tag = el.tagName;
	return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable || Boolean(el.closest("[contenteditable='true']"));
};

const visibleItems = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>(ITEM)].filter((el) => el.offsetParent !== null && !el.hasAttribute("disabled") && el.getAttribute("aria-disabled") !== "true");

let cursor: HTMLElement | undefined;

function highlight(el: HTMLElement | undefined) {
	cursor?.classList.remove("nav-on");
	cursor = el;
	if (!el) return;
	el.classList.add("nav-on");
	el.scrollIntoView({ block: "nearest", inline: "nearest" });
}

/** Move the cursor; `wrap` lets the ends meet instead of stopping. */
export function moveCursor(direction: 1 | -1 | "first" | "last"): HTMLElement | undefined {
	const items = visibleItems();
	if (!items.length) return undefined;
	if (direction === "first") {
		highlight(items[0]);
		return cursor;
	}
	if (direction === "last") {
		highlight(items[items.length - 1]);
		return cursor;
	}
	const current = cursor && items.includes(cursor) ? items.indexOf(cursor) : direction === 1 ? -1 : items.length;
	const next = Math.min(items.length - 1, Math.max(0, current + direction));
	highlight(items[next]);
	return cursor;
}

/** Click the highlighted item (or its first link), the way Enter opens a slide's next view. */
export function activateCursor(): boolean {
	const el = cursor ?? undefined;
	if (!el || !document.contains(el)) return false;
	if (el instanceof HTMLAnchorElement || el instanceof HTMLButtonElement) {
		el.click();
		return true;
	}
	const link = el.querySelector<HTMLElement>("a, button");
	if (link) {
		link.click();
		return true;
	}
	el.click();
	return true;
}

export function startKeyboardNav(): () => void {
	const onKey = (event: KeyboardEvent) => {
		if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
		if (isTyping(event.target)) return;
		// a dialog or menu owns Escape and its own arrows
		const inOverlay = event.target instanceof HTMLElement && event.target.closest(".dialog, [role='dialog'], .row-menu, .modal");
		const editor = document.activeElement instanceof HTMLElement && document.activeElement.closest("iframe, .chat-input, .composer");
		if (editor) return;

		const key = event.key;
		switch (key) {
			case "ArrowDown":
			case "ArrowRight":
			case "PageDown":
			case "j":
			case "J":
				event.preventDefault();
				moveCursor(1);
				break;
			case " ":
				// space advances, like in the slides module (never while a control has focus)
				if (document.activeElement === document.body || document.activeElement === cursor || cursor) {
					event.preventDefault();
					moveCursor(1);
				}
				break;
			case "ArrowUp":
			case "ArrowLeft":
			case "PageUp":
			case "k":
			case "K":
				event.preventDefault();
				moveCursor(-1);
				break;
			case "Home":
				if (cursor) {
					event.preventDefault();
					moveCursor("first");
				}
				break;
			case "End":
				if (cursor) {
					event.preventDefault();
					moveCursor("last");
				}
				break;
			case "Enter":
				if (cursor && activateCursor()) event.preventDefault();
				break;
			case "Escape":
				if (inOverlay) return;
				if (cursor) {
					event.preventDefault();
					highlight(undefined);
				}
				break;
		}
	};
	document.addEventListener("keydown", onKey);
	return () => {
		document.removeEventListener("keydown", onKey);
		highlight(undefined);
	};
}

/** Test helper: which element is currently highlighted. */
export const currentCursor = () => cursor;
