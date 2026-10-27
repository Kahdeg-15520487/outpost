import { useEffect, useState, useSyncExternalStore } from "react";
import { connectivity, probeNow } from "../net";
import { socket } from "../socket";
import { dismiss, toast, toasts } from "../toasts";

/** Rerenders every `ms` while `on` (for "down for 12s"). */
function useTicker(on: boolean, ms = 1000) {
	const [, set] = useState(0);
	useEffect(() => {
		if (!on) return;
		const t = setInterval(() => set((n) => n + 1), ms);
		return () => clearInterval(t);
	}, [on, ms]);
}

const elapsed = (since: number) => {
	const s = Math.max(0, Math.round((Date.now() - since) / 1000));
	return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
};

/**
 * A failed action that nobody caught would otherwise only reach the console: say it out loud. Deduped by
 * message, so a button pressed twice doesn't stack toasts.
 */
addEventListener("unhandledrejection", (e) => {
	const message = (e.reason as Error)?.message;
	if (typeof message !== "string" || !message) return;
	if (!connectivity.get().online) toast({ text: "That didn't work", detail: "Still offline — this action needs Outpost. It will work once the server is back.", key: "action:offline" });
	else toast({ text: "That didn't work", detail: message, key: `action:${message}` });
});

/**
 * The app's connection status: a banner while the backend can't be reached, and the toast stack.
 * Everything stays usable — actions that need the server fail with a clear message instead.
 */
export function ConnectionUI() {
	const net = useSyncExternalStore(connectivity.subscribe, connectivity.get);
	useTicker(!net.online);
	return (
		<>
			{!net.online && (
				<div className="offline-banner" role="status" aria-live="polite">
					<span className="offline-dot" aria-hidden="true" />
					<div className="offline-text">
						<b>{net.reason === "network" ? "You're offline" : "Can't reach Outpost"}</b>
						<span className="offline-detail">
							{net.reason === "network" ? "Check your network." : "The server isn't responding."} Reconnecting… down for {elapsed(net.since)}. Actions will fail until it's back.
						</span>
					</div>
					<button
						className="btn small"
						onClick={() => {
							socket.retryNow();
							void probeNow();
						}}
					>
						Retry now
					</button>
				</div>
			)}
			<Toasts />
		</>
	);
}

function Toasts() {
	const list = useSyncExternalStore(toasts.subscribe, toasts.get);
	return (
		<div className="toasts" aria-live="polite" aria-relevant="additions">
			{list.map((t) => (
				<div key={t.id} className={`toast ${t.kind}`} role={t.kind === "error" ? "alert" : "status"}>
					<div className="toast-body">
						<b>{t.text}</b>
						{t.detail && <span>{t.detail}</span>}
					</div>
					<button className="toast-x" aria-label="Dismiss" onClick={() => dismiss(t.id)}>
						✕
					</button>
				</div>
			))}
		</div>
	);
}
