import { request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { connect as netConnect, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import { config } from "./config.ts";
import { ROLE_RANK, sessions, workspaces } from "./kernel/system-db.ts";
import { Workspace } from "./kernel/workspace.ts";
import { parseCookies } from "./http/util.ts";
import { isPreviewLabel } from "./missions/slug.ts";

/**
 * Previews on `<slug>.<preview.baseDomain>`, dispatched by Host header.
 *
 * The port range (`preview.ports`) can't survive a reverse proxy: a router maps Host/Path to a port
 * declared ahead of time, while a preview's port is picked at runtime. So the process that owns the
 * port table does the dispatch: every preview hostname arrives on outpost's own port, is resolved to a
 * *running* preview, and is proxied to that app's loopback port.
 *
 *   browser → https://<slug>.example.net → proxy → outpost:8787 → 127.0.0.1:<appPort>
 *
 * Three rules this file does not break:
 *
 * 1. The upstream port comes from the live preview registry, never from the Host header. Anything else
 *    is an SSRF into the pod network.
 * 2. A preview is agent-written code on a public hostname, so the viewer must be signed in and be a
 *    member of the mission's workspace. No cookie, no bytes.
 * 3. `Host` is rewritten to the app's loopback address before forwarding: Vite ≥6 (and Next, CRA,
 *    Django) reject unknown hosts, which is what a forwarded public hostname looks like to them.
 */

export type PreviewTarget = {
	wsId: string;
	missionId: string;
	/** PreviewStatus from missions/preview.ts ("running", "starting", "crashed", …). */
	status: string;
	/** The dev server's own loopback port. Absent unless running. */
	appPort?: number;
	/** 127.0.0.1, or localhost when the app listens on IPv6 only. */
	host?: string;
	/** Last log lines, for the 502 page: why the preview isn't up. */
	tail?: () => string;
};

/** Which mission a hostname label belongs to. Cached: a page load is dozens of requests. */
export type PreviewRoute = { wsId: string; missionId: string };

/**
 * Two steps, deliberately: the *mapping* is cacheable, the *state and port* are not. A merge restarts a
 * preview on a new port, and a proxy that answered from a cached port would break it until the cache
 * expired — so `describe` runs on every request and only `find` is cached.
 */
export type PreviewResolver = {
	find(label: string): PreviewRoute | undefined | Promise<PreviewRoute | undefined>;
	describe(route: PreviewRoute): PreviewTarget | undefined | Promise<PreviewTarget | undefined>;
};

export type PreviewProxyOptions = {
	/** Defaults to config.preview.baseDomain; required for the proxy to claim any host. */
	baseDomain?: string;
	/** Defaults to the workspace mission index. */
	resolve?: PreviewResolver;
	/** Defaults to "signed-in member of the mission's workspace". */
	authorize?: (req: IncomingMessage, target: PreviewTarget) => boolean | Promise<boolean>;
	/** How long a hostname → mission lookup is reused. */
	mapTtlMs?: number;
};

const HOP_BY_HOP = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade"]);
const LOCAL_ORIGIN = /^https?:\/\/(?:127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\])(?::\d+)?(?=\/|$)/i;

export function createPreviewProxy(options: PreviewProxyOptions = {}) {
	const baseDomain = options.baseDomain ?? config.preview.baseDomain;
	const resolve = options.resolve ?? missionIndex();
	const authorize = options.authorize ?? memberOfWorkspace;
	const mapTtl = options.mapTtlMs ?? 15_000;
	const cache = new Map<string, { at: number; route?: PreviewRoute }>();

	/**
	 * Host header → the label, "not ours", or "ours but not a slug".
	 *
	 * `os.example.net` is ours only as a *prefix*: `<label>.os.example.net` is a preview, `os.example.net`
	 * itself is the app, and `a.b.os.example.net` is somebody else's mistake (a public CA can't certify
	 * two wildcard levels, so we never try to serve it).
	 */
	function classify(hostHeader: string | undefined): { label: string } | "invalid" | "other" {
		if (!baseDomain || !hostHeader) return "other";
		const host = hostHeader.trim().toLowerCase().replace(/:\d+$/, "").replace(/\.$/, "");
		if (host === baseDomain || !host.endsWith(`.${baseDomain}`)) return "other";
		const label = host.slice(0, -(baseDomain.length + 1));
		return isPreviewLabel(label) ? { label } : "invalid";
	}

	/** The label's mission, then its live state — an unknown label and an idle preview are different answers. */
	async function lookup(label: string): Promise<PreviewTarget | undefined> {
		const cached = cache.get(label);
		let route: PreviewRoute | undefined;
		if (cached && Date.now() - cached.at < mapTtl) route = cached.route;
		else {
			route = await resolve.find(label);
			cache.set(label, { at: Date.now(), route });
		}
		return route ? await resolve.describe(route) : undefined;
	}

	/** True when this request is for a preview hostname, so the app's own handlers stay out of it. */
	function owns(req: IncomingMessage) {
		return classify(req.headers.host) !== "other";
	}

	/** Claims the request when its Host is a preview hostname. Returns false to let outpost serve it. */
	async function handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
		const c = classify(req.headers.host);
		if (c === "other") return false;
		const deny = (status: number, title: string, detail: string) => (page(res, status, title, detail), true);
		const base = escapeHtml(baseDomain ?? "");
		if (c === "invalid") return deny(404, "No preview here", `This address isn't a preview: a preview is a single label under <code>${base}</code>.`);

		const hit = await lookup(c.label);
		if (!hit) return deny(404, "No preview at this address", `Nothing in Outpost answers to the preview name <code>${escapeHtml(c.label)}</code>. A mission's preview name is fixed when the mission is created.`);
		if (!(await authorize(req, hit))) return deny(403, "Not your preview", "Sign in to Outpost, and make sure you're a member of the workspace this app belongs to.");
		if (hit.status !== "running" || !hit.appPort) return deny(502, "This preview isn't running", `The app is <b>${escapeHtml(hit.status)}</b>. Start it from the App tab in Outpost.${logTail(hit)}`);

		forward(req, res, hit, c.label);
		return true;
	}

	/** Same resolution as `handle`, for the WebSocket/HMR half of a dev server. Never throws. */
	function upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
		const c = classify(req.headers.host);
		if (c === "other") return false;
		void (async () => {
			const refuse = (status: number, reason: string) => {
				socket.write(`HTTP/1.1 ${status} ${reason}\r\nconnection: close\r\ncontent-length: 0\r\n\r\n`);
				socket.destroy();
			};
			try {
				if (c === "invalid") return refuse(404, "Not Found");
				const hit = await lookup(c.label);
				if (!hit) return refuse(404, "Not Found");
				if (!(await authorize(req, hit))) return refuse(403, "Forbidden");
				if (hit.status !== "running" || !hit.appPort) return refuse(502, "Bad Gateway");
				pipeUpgrade(req, socket, head, hit, c.label);
			} catch (error) {
				console.error("preview upgrade:", error);
				socket.destroy();
			}
		})();
		return true;
	}

	function forward(req: IncomingMessage, res: ServerResponse, hit: PreviewTarget, slug: string) {
		const port = hit.appPort!;
		const host = hit.host ?? "127.0.0.1";
		const upstream = httpRequest({ host, port, method: req.method, path: req.url, headers: upstreamHeaders(req, host, port, slug) }, (up) => {
			const headers = { ...up.headers };
			// An app that says "don't frame me" would blank out the App tab; the tab is the intended viewer.
			delete headers["x-frame-options"];
			if (typeof headers.location === "string") headers.location = publicLocation(headers.location, req.headers.host);
			res.writeHead(up.statusCode ?? 502, up.statusMessage, headers);
			up.pipe(res);
		});
		upstream.on("error", (error) => {
			if (res.headersSent) return res.destroy();
			page(res, 502, "This preview isn't answering", `${escapeHtml(describe(error))}${logTail(hit)}`);
		});
		req.on("aborted", () => upstream.destroy());
		req.pipe(upstream);
	}

	/**
	 * Pipes an Upgrade (HMR) through: the app's socket sees the same bytes a browser would send, with the
	 * host rewritten and the forwarded headers added. `head` is the part of the request already read.
	 */
	function pipeUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, hit: PreviewTarget, slug: string) {
		const port = hit.appPort!;
		const host = hit.host ?? "127.0.0.1";
		const upstream = netConnect({ host, port }, () => {
			upstream.setNoDelay(true);
			(socket as Socket).setNoDelay(true);
			upstream.write(requestHead(req, host, port, slug));
			if (head?.length) upstream.write(head);
			socket.pipe(upstream).pipe(socket);
		});
		upstream.on("error", () => {
			if (!socket.destroyed) socket.write("HTTP/1.1 502 Bad Gateway\r\nconnection: close\r\ncontent-length: 0\r\n\r\n");
			socket.destroy();
		});
		socket.on("error", () => upstream.destroy());
		socket.on("close", () => upstream.destroy());
	}

	return { handle, upgrade, owns, classify, lookup };
}

/**
 * Hostname → mission, across every workspace. Only the mapping is memoized by the caller; `describe` runs
 * per request, because a merge restarts a preview on a new port and a stale port is a dead iframe.
 */
function missionIndex(): PreviewResolver {
	return {
		async find(label) {
			for (const wsId of workspaces.allIds()) {
				let ws: Workspace;
				try {
					ws = await Workspace.get(wsId);
				} catch {
					continue;
				}
				const meta = (await ws.missions.list()).find((m) => (m.slug ?? ws.missions.slugOf(m.id)) === label);
				if (meta) return { wsId, missionId: meta.id };
			}
			return undefined;
		},
		async describe(route) {
			const ws = await Workspace.get(route.wsId);
			const info = ws.missions.previews.info(route.missionId);
			const port = info.appPort ?? info.port;
			return {
				...route,
				status: info.status,
				appPort: info.status === "running" ? port : undefined,
				host: info.host,
				tail: () => ws.missions.previews.tail(route.missionId, 3),
			};
		},
	};
}

/** Signed in, and a member of the mission's workspace. A preview is code execution; membership is the ACL. */
function memberOfWorkspace(req: IncomingMessage, target: PreviewTarget): boolean {
	const user = sessions.user(parseCookies(req.headers.cookie).outpost_session);
	if (!user) return false;
	const role = workspaces.role(target.wsId, user.id);
	return !!role && ROLE_RANK[role] >= ROLE_RANK.viewer;
}

/**
 * The headers the dev server sees. `upgrade` keeps the handshake headers (`connection`, `upgrade`,
 * `sec-websocket-*`): dropping them turns an HMR socket into a plain GET, which frameworks answer with
 * their index page — a silently broken dev server with no error anywhere.
 */
function upstreamHeaders(req: IncomingMessage, host: string, port: number, slug: string, upgrade = false): Record<string, string | string[]> {
	const headers: Record<string, string | string[]> = {};
	for (const [name, value] of Object.entries(req.headers)) {
		if (value === undefined || name === "host") continue;
		if (upgrade ? name.startsWith("proxy-") || name === "transfer-encoding" : HOP_BY_HOP.has(name)) continue;
		headers[name] = value;
	}
	// What the dev server must see: its own address (host checks), and the public origin behind it.
	headers.host = host.includes(":") ? `[${host}]:${port}` : `${host}:${port}`;
	headers["x-forwarded-proto"] = first(req.headers["x-forwarded-proto"]) ?? ((req.socket as { encrypted?: boolean }).encrypted ? "https" : "http");
	headers["x-forwarded-host"] = req.headers.host ?? "";
	headers["x-forwarded-for"] = [first(req.headers["x-forwarded-for"]), req.socket.remoteAddress].filter(Boolean).join(", ");
	headers["x-outpost-preview"] = slug;
	return headers;
}

function requestHead(req: IncomingMessage, host: string, port: number, slug: string): string {
	const headers = upstreamHeaders(req, host, port, slug, true);
	const lines = [`${req.method} ${req.url} HTTP/1.1`];
	for (const [name, value] of Object.entries(headers)) {
		for (const one of Array.isArray(value) ? value : [value]) lines.push(`${name}: ${one}`);
	}
	return `${lines.join("\r\n")}\r\n\r\n`;
}

/** An app that redirects to `http://localhost:3000/login` must send the browser back to the public host. */
function publicLocation(location: string, host: string | undefined): string {
	if (!host || !LOCAL_ORIGIN.test(location)) return location;
	return location.replace(LOCAL_ORIGIN, `https://${host}`);
}

function first(value: string | string[] | undefined): string | undefined {
	return Array.isArray(value) ? value[0] : value;
}

function describe(error: Error): string {
	const code = (error as NodeJS.ErrnoException).code;
	if (code === "ECONNREFUSED") return "The dev server isn't accepting connections.";
	if (code === "ECONNRESET") return "The dev server closed the connection.";
	return error.message;
}

function logTail(target: PreviewTarget): string {
	const tail = target.tail?.().trim();
	return tail ? `<pre>${escapeHtml(tail.split("\n").slice(-3).join("\n"))}</pre>` : "";
}

function escapeHtml(text: string): string {
	return text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

function page(res: ServerResponse, status: number, title: string, detail: string) {
	const body = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title>
<style>:root{color-scheme:light dark}body{margin:0;min-height:100vh;display:grid;place-items:center;font:15px/1.5 system-ui,sans-serif;padding:2rem;text-align:center}
h1{font-size:1.1rem;margin:0 0 .5rem}p{margin:0;max-width:46ch;opacity:.75}pre{margin:1rem 0 0;padding:.75rem 1rem;text-align:left;overflow:auto;max-width:80vw;opacity:.6;font-size:12px;border-radius:8px;background:color-mix(in oklab,currentColor 8%,transparent)}code{font-size:.95em}</style>
<h1>${escapeHtml(title)}</h1><p>${detail}</p>`;
	res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
	res.end(body);
}
