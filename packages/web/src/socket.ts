import { markOffline, markOnline } from "./net";

type Listener = (m: any) => void;

/**
 * One WebSocket per tab, auto-reconnecting. Subscriptions are remembered and replayed on
 * reconnect, so views simply re-receive a snapshot after a network blip or server restart.
 */
class Socket {
	#ws: WebSocket | undefined;
	#listeners = new Set<Listener>();
	#subs = new Map<string, any>();
	#calls = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
	#seq = 0;
	#queue: string[] = [];
	#retry = 0;
	#timer: ReturnType<typeof setTimeout> | undefined;
	/** Signing out closes the socket on purpose: that is not a lost connection. */
	#intentional = false;
	connected = false;
	/** The server now serves a newer web app than this tab runs: reload to get it. */
	updated = false;
	#build: string | null | undefined;
	#statusListeners = new Set<(c: boolean) => void>();

	connect() {
		if (this.#ws) return;
		const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;
		const ws = new WebSocket(url);
		this.#ws = ws;
		ws.onopen = () => {
			this.#retry = 0;
			this.#setConnected(true);
			markOnline();
			for (const sub of this.#subs.values()) ws.send(JSON.stringify(sub));
			for (const m of this.#queue.splice(0)) ws.send(m);
		};
		ws.onmessage = (e) => {
			const m = JSON.parse(e.data);
			if (m.t === "hello") {
				// The first server we talk to served this page; a different build later means an update.
				if (this.#build === undefined) this.#build = m.build ?? null;
				else if (m.build && this.#build && m.build !== this.#build && !this.updated) {
					this.updated = true;
					for (const l of this.#statusListeners) l(this.connected);
				}
				return;
			}
			if (m.t === "call.result") {
				const p = this.#calls.get(m.id);
				if (p) {
					this.#calls.delete(m.id);
					m.ok ? p.resolve(m.value) : p.reject(new Error(m.error));
				}
				return;
			}
			for (const l of this.#listeners) l(m);
		};
		ws.onclose = () => {
			this.#ws = undefined;
			this.#setConnected(false);
			for (const p of this.#calls.values()) p.reject(new Error("The connection to Outpost was lost. Try again in a moment."));
			this.#calls.clear();
			if (!this.#intentional) markOffline("server");
			this.#scheduleReconnect();
		};
	}

	#scheduleReconnect() {
		clearTimeout(this.#timer);
		this.#timer = setTimeout(() => this.connect(), Math.min(5000, 300 * 2 ** this.#retry++));
	}

	/** The banner's Retry: skip the backoff and try right now. */
	retryNow() {
		clearTimeout(this.#timer);
		this.#retry = 0;
		this.#intentional = false;
		if (!this.#ws) this.connect();
	}

	close() {
		this.#subs.clear();
		const ws = this.#ws;
		this.#ws = undefined;
		this.#intentional = true;
		clearTimeout(this.#timer);
		ws?.close();
	}

	#setConnected(c: boolean) {
		this.connected = c;
		for (const l of this.#statusListeners) l(c);
	}
	onStatus(l: (c: boolean) => void) {
		this.#statusListeners.add(l);
		return () => void this.#statusListeners.delete(l);
	}

	send(m: unknown) {
		const s = JSON.stringify(m);
		if (this.#ws?.readyState === WebSocket.OPEN) this.#ws.send(s);
		else this.#queue.push(s);
	}

	on(l: Listener) {
		this.#listeners.add(l);
		return () => void this.#listeners.delete(l);
	}

	subscribe(key: string, sub: object) {
		const msg = { t: "sub", ...sub };
		this.#subs.set(key, msg);
		this.send(msg);
		return () => {
			this.#subs.delete(key);
			this.send({ t: "unsub", ...sub });
		};
	}

	call(moduleId: string, method: string, args: unknown[]): Promise<any> {
		const id = ++this.#seq;
		return new Promise((resolve, reject) => {
			this.#calls.set(id, { resolve, reject });
			this.send({ t: "call", id, moduleId, method, args });
		});
	}
}

export const socket = new Socket();
