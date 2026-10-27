import { toast } from "./toasts";

/**
 * Whether the web app can reach its backend. Two things mark it down: the live socket closing (the
 * strongest signal while signed in) and any request failing without an HTTP answer. While it's down
 * we probe /api/me every few seconds and say so once, rather than on every failed action; the banner
 * and the toast are the only UI. Nothing is disabled: actions still try, and fail with a clear message.
 */
export type Net = { online: boolean; since: number; lastSeen: number; reason?: "server" | "network"; /** Bumped each time the backend comes back: fetches made while it was down should run again. */ reconnects: number };
const PROBE_MS = 3000;
const TIMEOUT_MS = 4000;

let net: Net = { online: true, since: Date.now(), lastSeen: Date.now(), reconnects: 0 };
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | undefined;
let probing = false;
const emit = () => listeners.forEach((l) => l());

export function markOffline(reason: Net["reason"] = "server") {
	if (!net.online) return void (net = { ...net, reason });
	net = { online: false, since: Date.now(), lastSeen: net.lastSeen, reason, reconnects: net.reconnects };
	emit();
	toast({ key: "net", text: reason === "network" ? "You're offline" : "Can't reach Outpost", detail: reason === "network" ? "Check your network. Outpost reconnects on its own." : "The server isn't responding. Retrying…" });
	startProbing();
}

export function markOnline() {
	if (net.online) return;
	const down = Date.now() - net.since;
	net = { online: true, since: Date.now(), lastSeen: Date.now(), reconnects: net.reconnects + 1 };
	emit();
	stopProbing();
	toast({ key: "net", kind: "info", text: "Back online", detail: down > 60_000 ? `Outpost is reachable again after ${Math.round(down / 60_000)}m.` : "Outpost is reachable again." });
}

/** One reachability check. Any HTTP answer below 500 means the backend is there (even if it's an error for this user). */
export async function probeNow(): Promise<boolean> {
	if (probing) return !net.online;
	probing = true;
	try {
		const res = await fetch("/api/me", { cache: "no-store", credentials: "same-origin", signal: AbortSignal.timeout(TIMEOUT_MS) });
		if (res.status < 500) {
			markOnline();
			return true;
		}
		markOffline("server");
		return false;
	} catch {
		markOffline(navigator.onLine === false ? "network" : "server");
		return false;
	} finally {
		probing = false;
	}
}

function startProbing() {
	timer ??= setInterval(() => void probeNow(), PROBE_MS);
}
function stopProbing() {
	clearInterval(timer);
	timer = undefined;
}

/** The network dropped (or came back): the browser knows before the socket notices. */
addEventListener("offline", () => markOffline("network"));
addEventListener("online", () => void probeNow());

export const connectivity = {
	subscribe(l: () => void) {
		listeners.add(l);
		return () => void listeners.delete(l);
	},
	get: () => net,
};
