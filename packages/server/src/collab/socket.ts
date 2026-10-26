import type { IncomingMessage } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import type { AgentEventStream } from "@earendil-works/pi-durable";
import { hub, type HubClient } from "./hub.ts";
import { sessions, workspaces, type User } from "../kernel/system-db.ts";
import { Workspace } from "../kernel/workspace.ts";
import { parseCookies } from "../http/util.ts";
import { config } from "../config.ts";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * One WebSocket per browser tab. Subscriptions:
 *   { t: "sub", kind: "ws", ws }                 workspace docs + gadget list changes
 *   { t: "sub", kind: "chat", ws, chat }         agent events (snapshot, then batches)
 *   { t: "sub", kind: "gadget", gadgetId }       gadget broadcasts, reloads, logs, presence
 *   { t: "sub", kind: "project", ws, project }   project team, agent summaries, repo changes
 *   { t: "call", id, gadgetId, method, args }    gadget RPC as the signed-in user
 */
export function attachSockets(server: import("node:http").Server) {
	const wss = new WebSocketServer({ noServer: true });
	server.on("upgrade", (req, socket, head) => {
		if (!req.url?.startsWith("/ws")) return socket.destroy();
		const user = sessions.user(parseCookies(req.headers.cookie).pios_session);
		if (!user) {
			socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
			return socket.destroy();
		}
		wss.handleUpgrade(req, socket, head, (ws) => connection(ws, user, req));
	});
}

let nextClient = 0;
const sockets = new Set<WebSocket>();

/**
 * Which web app this server serves: a hash of the built index.html (asset names change with every
 * build). Sent on connect, so a tab left open across an update sees it reconnected to a newer app.
 */
let built: { mtime: number; id?: string } | undefined;
export function webBuild(): string | undefined {
	if (process.env.PI_OS_BUILD_ID) return process.env.PI_OS_BUILD_ID;
	const file = join(config.webDist, "index.html");
	try {
		const mtime = statSync(file).mtimeMs;
		if (built?.mtime !== mtime) built = { mtime, id: createHash("sha1").update(readFileSync(file)).digest("hex").slice(0, 12) };
		return built.id;
	} catch {
		return undefined; // dev server (vite) or not built
	}
}

/** Close every socket (clients reconnect). */
export function dropSockets() {
	for (const s of sockets) s.terminate();
}
const presenceWatchers = new Map<string, () => void>();

function connection(socket: WebSocket, user: User, _req: IncomingMessage) {
	const client: HubClient = {
		id: `c${++nextClient}`,
		user,
		send: (m) => socket.readyState === socket.OPEN && socket.send(JSON.stringify(m)),
	};
	const streams = new Map<string, AgentEventStream>();
	sockets.add(socket);
	socket.on("close", () => sockets.delete(socket));
	client.send({ t: "hello", build: webBuild() });
	hub.join(`user:${user.id}`, client);
	hub.join("blueprints", client);
	const fail = (m: any, error: unknown) => client.send({ t: "error", ref: m, error: error instanceof Error ? error.message : String(error) });

	socket.on("message", async (raw) => {
		let m: any;
		try {
			m = JSON.parse(String(raw));
		} catch {
			return;
		}
		try {
			if (m.t === "sub" && m.kind === "ws") {
				if (!workspaces.role(m.ws, user.id)) throw new Error("not a member");
				const ws = await Workspace.get(m.ws);
				hub.join(ws.channel, client);
				client.send({ t: "ws.snapshot", ws: m.ws, ...(await ws.snapshot()) });
			} else if (m.t === "unsub" && m.kind === "ws") {
				hub.leave(`ws:${m.ws}`, client);
			} else if (m.t === "sub" && m.kind === "chat") {
				if (!workspaces.role(m.ws, user.id)) throw new Error("not a member");
				const key = `${m.ws}:${m.chat}`;
				await streams.get(key)?.stop();
				const ws = await Workspace.get(m.ws);
				const stream = await ws.watchEvents(m.chat);
				streams.set(key, stream);
				client.send({ t: "chat.events", ws: m.ws, chat: m.chat, events: [stream.snapshot] });
				stream.start(async (events) => client.send({ t: "chat.events", ws: m.ws, chat: m.chat, events }));
			} else if (m.t === "unsub" && m.kind === "chat") {
				const key = `${m.ws}:${m.chat}`;
				await streams.get(key)?.stop();
				streams.delete(key);
			} else if (m.t === "sub" && m.kind === "project") {
				if (!workspaces.role(m.ws, user.id)) throw new Error("not a member");
				const ws = await Workspace.get(m.ws);
				await ws.projects.watch(m.project);
				hub.join(ws.projects.channel(m.project), client);
				client.send({ t: "project.snapshot", ws: m.ws, projectId: m.project, ...(await ws.projects.snapshot(m.project)) });
			} else if (m.t === "unsub" && m.kind === "project") {
				hub.leave(`project:${m.ws}:${m.project}`, client);
			} else if (m.t === "sub" && m.kind === "gadget") {
				const { gadget, role } = await Workspace.gadgetFor(m.gadgetId, user);
				const channel = `gadget:${gadget.id}`;
				if (!presenceWatchers.has(channel)) {
					presenceWatchers.set(
						channel,
						hub.onMembership(channel, () => hub.publish(channel, { t: "gadget.presence", gadgetId: gadget.id, users: hub.presence(channel) })),
					);
				}
				hub.join(channel, client);
				client.send({ t: "gadget.subscribed", gadgetId: gadget.id, role, users: hub.presence(channel) });
			} else if (m.t === "unsub" && m.kind === "gadget") {
				hub.leave(`gadget:${m.gadgetId}`, client);
			} else if (m.t === "call") {
				try {
					const { ws, caller } = await Workspace.gadgetFor(m.gadgetId, user);
					const value = await ws.host(m.gadgetId).call(String(m.method), Array.isArray(m.args) ? m.args : [], caller);
					client.send({ t: "call.result", id: m.id, ok: true, value: value ?? null });
				} catch (error) {
					client.send({ t: "call.result", id: m.id, ok: false, error: error instanceof Error ? error.message : String(error) });
				}
			} else if (m.t === "ping") {
				client.send({ t: "pong" });
			}
		} catch (error) {
			fail(m, error);
		}
	});

	socket.on("close", () => {
		hub.leaveAll(client);
		for (const s of streams.values()) void s.stop();
		streams.clear();
	});
}
