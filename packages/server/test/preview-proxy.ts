/**
 * Previews on `<slug>.<preview.baseDomain>`: Host-header dispatch instead of a published port range.
 *
 * The proxy is exercised against real sockets — an upstream app on loopback, a front server that calls
 * `handle` exactly as `main.ts` does — because the interesting failures (a rewritten Host, a stale port,
 * an HMR upgrade, a 502 that doesn't hang) only show up on the wire.
 *
 * Run: pnpm --filter @outpost/server test:preview-proxy
 */
import { check, freePort, finish, until } from "./lib/harness.ts";
import { createServer, request as httpRequest, type IncomingMessage, type Server } from "node:http";
import { connect as netConnect, type AddressInfo } from "node:net";
import { once } from "node:events";
import { isPreviewLabel, missionSlug } from "../src/missions/slug.ts";
import { createPreviewProxy, type PreviewResolver, type PreviewTarget } from "../src/preview-proxy.ts";

const listen = async (server: Server) => {
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	return (server.address() as AddressInfo).port;
};

// ---------------------------------------------------------------- slugs

const slug = missionSlug("ms_abc123", "Storefront redesign");
check("slug: name plus a short hash", /^storefront-redesign-[0-9a-f]{6}$/.test(slug), slug);
check("slug: deterministic for the same mission", missionSlug("ms_abc123", "Storefront redesign") === slug, slug);
check("slug: a rename cannot take another mission's name", missionSlug("ms_abc123", "Storefront redesign") !== missionSlug("ms_abc123", "Storefront rewrite"), slug);
check("slug: two missions with the same name still differ", missionSlug("ms_1", "Website") !== missionSlug("ms_2", "Website"), [missionSlug("ms_1", "Website"), missionSlug("ms_2", "Website")]);
check("slug: non-Latin names still produce a label", /^mission-[0-9a-f]{6}$/.test(missionSlug("ms_3", "日本語のサイト")), missionSlug("ms_3", "日本語のサイト"));
check("slug: diacritics are folded", /^munchen-cafe-[0-9a-f]{6}$/.test(missionSlug("ms_4", "München Café")), missionSlug("ms_4", "München Café"));
const long = missionSlug("ms_5", "w".repeat(200));
check("slug: never exceeds the 63-byte DNS label limit", long.length === 63, [long.length, long]);
check("slug: is a valid label", isPreviewLabel(long) && isPreviewLabel(slug), [long, slug]);
check("label: rejects dots, uppercase, edge hyphens and empties", ["a.b", "-lead", "trail-", "Upper", "", "a".repeat(64)].every((l) => !isPreviewLabel(l)), "accepted one");
check("label: accepts generated slugs", isPreviewLabel("x1-9f3ab2"), "x1-9f3ab2");

// ---------------------------------------------------------------- a fake preview app

/** The dev server: reports what it saw, and answers a redirect the way a framework would. */
let appPort = 0;
const upstream = createServer((req, res) => {
	if (req.url === "/old") {
		// An app that redirects to its own loopback origin, which the browser can't reach.
		res.writeHead(302, { location: `http://127.0.0.1:${appPort}/new`, "x-frame-options": "DENY" });
		return res.end();
	}
	res.writeHead(200, { "content-type": "application/json", "x-frame-options": "SAMEORIGIN" });
	res.end(JSON.stringify({ url: req.url, host: req.headers.host, proto: req.headers["x-forwarded-proto"], origin: req.headers["x-forwarded-host"], preview: req.headers["x-outpost-preview"] }));
});
upstream.on("upgrade", (req, socket) => {
	socket.write("HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\n\r\n");
	socket.on("data", (d) => socket.write(`echo:${d.toString()}`));
});
appPort = await listen(upstream);
const claimed = await freePort(); // a port nothing listens on: the "app died" case

const routes: Record<string, PreviewTarget> = {
	"live-111111": { wsId: "w1", missionId: "ms_1", status: "running", appPort, host: "127.0.0.1" },
	"idle-222222": { wsId: "w1", missionId: "ms_2", status: "installing", tail: () => "npm install\nadded 300 packages" },
	"dead-333333": { wsId: "w1", missionId: "ms_3", status: "running", appPort: claimed, host: "127.0.0.1" },
	"other-444444": { wsId: "w2", missionId: "ms_4", status: "running", appPort, host: "127.0.0.1" },
};
// The port a running preview reports can move (a merge restarts it on a new port).
let movable = appPort;
routes["moving-555555"] = { wsId: "w1", missionId: "ms_5", status: "running", appPort: movable, host: "127.0.0.1" };

let findCalls = 0;
const resolver: PreviewResolver = {
	find(label) {
		findCalls += 1;
		return routes[label] ? { wsId: routes[label]!.wsId, missionId: routes[label]!.missionId } : undefined;
	},
	describe(route) {
		const target = Object.values(routes).find((t) => t.missionId === route.missionId)!;
		return target;
	},
};

const BASE = "preview.test";
const proxy = createPreviewProxy({
	baseDomain: BASE,
	resolve: resolver,
	// "Signed in and a member": the header stands in for the session cookie the real check reads.
	authorize: (req, target) => req.headers["x-test-member"] === target.wsId,
});

const front = createServer(async (req, res) => {
	if (await proxy.handle(req, res)) return;
	res.writeHead(200, { "content-type": "text/plain" });
	res.end("outpost");
});
front.on("upgrade", (req, socket, head) => proxy.upgrade(req, socket, head));
const frontPort = await listen(front);

type Got = { status: number; headers: IncomingMessage["headers"]; body: string };
/** A request with a spoofed Host, the way a reverse proxy in front of outpost would deliver it. */
function get(host: string, path = "/", headers: Record<string, string> = {}): Promise<Got> {
	return new Promise((resolve, reject) => {
		const req = httpRequest({ host: "127.0.0.1", port: frontPort, path, method: "GET", headers: { host, ...headers }, setHost: false }, (res) => {
			let body = "";
			res.setEncoding("utf8");
			res.on("data", (c) => (body += c));
			res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
		});
		req.on("error", reject);
		req.end();
	});
}

// ---------------------------------------------------------------- dispatch

// A reverse proxy in front of outpost reports the browser's scheme, which the app must otherwise guess.
const live = await get("live-111111." + BASE, "/index.html?x=1", { "x-test-member": "w1", "x-forwarded-proto": "https" });
check("dispatch: a running preview is served on its hostname", live.status === 200 && JSON.parse(live.body).url === "/index.html?x=1", live.body);
const seen = JSON.parse(live.body || "{}");
check("dispatch: Host is rewritten to the app's loopback address, so Vite ≥6 answers", seen.host === `127.0.0.1:${appPort}`, seen.host);
check("dispatch: the public host survives in X-Forwarded-Host", seen.origin === `live-111111.${BASE}`, seen.origin);
check("dispatch: the browser's scheme is reported as https", seen.proto === "https", seen.proto);
const plain = await get(`live-111111.${BASE}`, "/", { "x-test-member": "w1" });
check("dispatch: without a proxy in front, the scheme falls back to the socket", JSON.parse(plain.body).proto === "http", plain.body);
check("dispatch: the app can tell which preview it is", seen.preview === "live-111111", seen.preview);
check("dispatch: an app's x-frame-options does not blank out the App tab", live.headers["x-frame-options"] === undefined, live.headers["x-frame-options"]);

const base = await get(BASE);
check("dispatch: the base domain itself is outpost, not a preview", base.status === 200 && base.body === "outpost", base.body);
const sibling = await get("minhnguyenle-preview.test");
check("dispatch: a look-alike host is not claimed", sibling.body === "outpost", sibling.body);
const unrelated = await get("example.com");
check("dispatch: an unrelated host is not claimed", unrelated.body === "outpost", unrelated.body);

const before = findCalls;
const deep = await get(`a.b.${BASE}`, "/", { "x-test-member": "w1" });
check("two labels under the base domain never reach a proxy attempt", deep.status === 404 && findCalls === before, [deep.status, findCalls - before]);

const unknown = await get(`nobody-999999.${BASE}`, "/", { "x-test-member": "w1" });
check("an unknown slug is 404, not a proxy attempt", unknown.status === 404 && /No preview at this address/.test(unknown.body), unknown.status);

const denied = await get(`live-111111.${BASE}`);
check("no session: 403, and the app never sees the request", denied.status === 403 && /Not your preview/.test(denied.body), denied.status);
const stranger = await get(`other-444444.${BASE}`, "/", { "x-test-member": "w1" });
check("someone else's workspace: 403", stranger.status === 403, stranger.status);

const idle = await get(`idle-222222.${BASE}`, "/", { "x-test-member": "w1" });
check("a preview that isn't up: 502 with its status", idle.status === 502 && /installing/.test(idle.body), idle.status);
check("…and the last log lines, so the iframe isn't a blank box", /added 300 packages/.test(idle.body), idle.body);

const dead = await get(`dead-333333.${BASE}`, "/", { "x-test-member": "w1" });
check("a dev server that died: 502, not a hang", dead.status === 502 && /isn't answering/i.test(dead.body), dead.status);

// ---------------------------------------------------------------- rewriting

const redirect = await get(`live-111111.${BASE}`, "/old", { "x-test-member": "w1" });
check("an absolute Location on the loopback origin is rewritten to the public host", redirect.headers.location === `https://live-111111.${BASE}/new`, redirect.headers.location);

// ---------------------------------------------------------------- live port

routes["moving-555555"] = { ...routes["moving-555555"]!, appPort };
const firstPort = appPort;
movable = claimed;
routes["moving-555555"] = { ...routes["moving-555555"]!, appPort: movable };
const moved = await get(`moving-555555.${BASE}`, "/", { "x-test-member": "w1" });
check("the port is read per request: a restarted preview on a new port is followed", moved.status === 502, [firstPort, moved.status]);

// ---------------------------------------------------------------- HMR socket

async function upgrade(host: string, headers: Record<string, string>): Promise<string> {
	const socket = netConnect({ host: "127.0.0.1", port: frontPort });
	await once(socket, "connect");
	let text = "";
	socket.on("data", (d) => (text += d.toString()));
	socket.setEncoding("utf8");
	socket.write(`GET /?token=hmr HTTP/1.1\r\nhost: ${host}\r\nupgrade: websocket\r\nconnection: Upgrade\r\nsec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==\r\nsec-websocket-version: 13\r\n${Object.entries(headers)
		.map(([k, v]) => `${k}: ${v}\r\n`)
		.join("")}\r\n`);
	await until("the upgrade", () => text.includes("101") || text.includes("403"), 5000);
	if (text.includes("101")) {
		socket.write("ping");
		await until("the echo", () => text.includes("echo:ping"), 5000);
	}
	socket.destroy();
	return text;
}

const ws = await upgrade(`live-111111.${BASE}`, { "x-test-member": "w1" });
check("HMR: the upgrade reaches the app through the proxy", /101 Switching Protocols/.test(ws) && ws.includes("echo:ping"), ws.slice(0, 120));
const wsDenied = await upgrade(`live-111111.${BASE}`, {});
check("HMR: an upgrade without a session is refused", /403/.test(wsDenied), wsDenied.slice(0, 80));

// ---------------------------------------------------------------- no base domain

const off = createPreviewProxy({ baseDomain: undefined, resolve: resolver, authorize: () => true });
check("no base domain configured: nothing is claimed, previews keep their port URLs", !off.owns({ headers: { host: `live-111111.${BASE}` } } as IncomingMessage), off.classify(`live-111111.${BASE}`));

front.close();
upstream.close();
await finish();
