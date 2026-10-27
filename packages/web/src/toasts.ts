/**
 * Small toast stack. Anything in the app can raise one; they dedupe by `key` so a repeated failure
 * doesn't pile up, expire on their own, and can be dismissed.
 */
export type Toast = { id: number; kind: "error" | "info"; text: string; detail?: string };
type Raise = { kind?: Toast["kind"]; text: string; detail?: string; key?: string; timeoutMs?: number };
const KEEP: Record<Toast["kind"], number> = { error: 8000, info: 4000 };

let items: Toast[] = [];
const listeners = new Set<() => void>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const byKey = new Map<string, number>();
let seq = 0;
const emit = () => listeners.forEach((l) => l());

export function toast({ kind = "error", text, detail, key, timeoutMs }: Raise) {
	const id = ++seq;
	if (key) {
		const existing = byKey.get(key);
		if (existing !== undefined) items = items.filter((t) => t.id !== existing);
		byKey.set(key, id);
		clearTimeout(timers.get(key)!);
		timers.delete(key);
	}
	items = [...items.slice(-3), { id, kind, text, detail }];
	emit();
	const ttl = timeoutMs ?? KEEP[kind];
	const timer = setTimeout(() => dismiss(id), ttl);
	timer.unref?.();
	if (key) timers.set(key, timer);
}

export function dismiss(id: number) {
	items = items.filter((t) => t.id !== id);
	for (const [key, value] of byKey) if (value === id) byKey.delete(key);
	emit();
}

export const toasts = {
	subscribe(l: () => void) {
		listeners.add(l);
		return () => void listeners.delete(l);
	},
	get: () => items,
};
