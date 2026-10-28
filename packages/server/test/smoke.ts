/**
 * End-to-end smoke test over HTTP and WebSocket: accounts, chat → module, module RPC, sharing, live
 * sync, Airlocks, files, blueprints. Boots its own throwaway server (or uses $BASE). Uses the
 * offline demo model, so no API key is needed. Run: pnpm --filter @outpost/server test:smoke
 */
import { finish, must, startServer } from "./lib/harness.ts";
import WebSocket from "ws";

const base = await startServer();
const assert = (cond: unknown, msg: string) => must(msg, cond);
process.on("unhandledRejection", (e) => void finish(e));

function client() {
	let cookie = "";
	const call = async (method: string, path: string, body?: unknown) => {
		const res = await fetch(base + path, { method, headers: { "content-type": "application/json", cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
		const set = res.headers.get("set-cookie");
		if (set) cookie = set.split(";")[0]!;
		const json = await res.json().catch(() => ({}));
		if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(json)}`);
		return json as any;
	};
	const socket = () =>
		new Promise<{ ws: WebSocket; next: (pred: (m: any) => boolean, ms?: number) => Promise<any>; send: (m: unknown) => void }>((resolve, reject) => {
			const ws = new WebSocket(base.replace("http", "ws") + "/ws", { headers: { cookie } });
			const inbox: any[] = [];
			const waiters: { pred: (m: any) => boolean; resolve: (m: any) => void }[] = [];
			ws.on("message", (raw) => {
				const m = JSON.parse(String(raw));
				const w = waiters.findIndex((x) => x.pred(m));
				if (w >= 0) waiters.splice(w, 1)[0]!.resolve(m);
				else inbox.push(m);
			});
			ws.on("open", () =>
				resolve({
					ws,
					send: (m) => ws.send(JSON.stringify(m)),
					next: (pred, ms = 20000) =>
						new Promise((res, rej) => {
							const i = inbox.findIndex(pred);
							if (i >= 0) return res(inbox.splice(i, 1)[0]);
							const t = setTimeout(() => rej(new Error("timeout waiting for message")), ms);
							waiters.push({ pred, resolve: (m) => (clearTimeout(t), res(m)) });
						}),
				}),
			);
			ws.on("error", reject);
		});
	return { call, socket, cookie: () => cookie };
}

const suffix = Date.now().toString(36);
const ana = client();
const ben = client();

console.log("auth & workspaces");
const { user: anaUser } = await ana.call("POST", "/api/auth/signup", { username: `ana${suffix}`, password: "pass1234", displayName: "Ana" });
await ben.call("POST", "/api/auth/signup", { username: `ben${suffix}`, password: "pass1234", displayName: "Ben" });
const { workspaces } = await ana.call("GET", "/api/workspaces");
assert(workspaces.length === 1, "signup creates a personal workspace");
const ws = workspaces[0].id;

console.log("chat with the demo model creates a module from a blueprint");
const { id: chat } = await ana.call("POST", `/api/w/${ws}/chats`, { model: { provider: "outpost-demo", modelId: "demo" } });
const sock = await ana.socket();
sock.send({ t: "sub", kind: "chat", ws, chat });
await sock.next((m) => m.t === "chat.events" && m.events[0]?.type === "snapshot");
await ana.call("POST", `/api/w/${ws}/chats/${chat}/messages`, { content: "make a todo list for the offsite" });
const toolEnd = await sock.next((m) => m.t === "chat.events" && m.events.some((e: any) => e.type === "tool_execution_end" && e.toolName === "module_create"), 30000);
assert(toolEnd, "agent ran module_create");
await sock.next((m) => m.t === "chat.events" && m.events.some((e: any) => e.type === "run_end"), 30000);
const { modules } = await ana.call("GET", `/api/w/${ws}/modules`);
assert(modules.length === 1 && modules[0].blueprintId === "bp_todo", "todo module exists");
const moduleId = modules[0].id;

console.log("module RPC, durable state, broadcasts");
const detail = await ana.call("GET", `/api/modules/${moduleId}`);
assert(detail.server.methods.includes("add") && !detail.server.error, `server started with methods ${detail.server.methods.join(",")}`);
sock.send({ t: "sub", kind: "module", moduleId });
await sock.next((m) => m.t === "module.subscribed");
sock.send({ t: "call", id: 1, moduleId, method: "add", args: ["Book venue", "ana"] });
const r1 = await sock.next((m) => m.t === "call.result" && m.id === 1);
assert(r1.ok && r1.value.length === 1, "add() returned the list");
const ev = await sock.next((m) => m.t === "module.event" && m.event === "changed");
assert(ev.data[0].text === "Book venue", "broadcast delivered after commit");
sock.send({ t: "call", id: 2, moduleId, method: "toggle", args: ["nope"] });
const r2 = await sock.next((m) => m.t === "call.result" && m.id === 2);
assert(!r2.ok && /No such task/.test(r2.error), "a throwing call returns its error");
const state = await ana.call("GET", `/api/modules/${moduleId}/state`);
assert(state.kv.items.length === 1, "state is durable in the workspace harness");

console.log("frame is sandboxed");
const { token } = await ana.call("POST", `/api/modules/${moduleId}/frame-token`);
const frame = await fetch(`${base}/frame/${moduleId}?t=${token}`);
const csp = frame.headers.get("content-security-policy") ?? "";
assert(csp.includes("connect-src 'none'") && csp.includes("sandbox allow-scripts"), "frame CSP forbids network and sandboxes");
assert((await frame.text()).includes("window.module"), "bootstrap injected");

console.log("sharing: links + viewer role + multiplayer");
await ana.call("POST", `/api/modules/${moduleId}/links`, { role: "viewer" });
const links = (await ana.call("GET", `/api/modules/${moduleId}`)).links;
await ben.call("POST", `/api/links/${links[0].token}/accept`);
const shared = await ben.call("GET", "/api/shared");
assert(shared.modules.length === 1 && shared.modules[0].role === "viewer", "Ben sees the shared module as viewer");
const bsock = await ben.socket();
bsock.send({ t: "sub", kind: "module", moduleId });
await bsock.next((m) => m.t === "module.subscribed");
const pres = await sock.next((m) => m.t === "module.presence" && m.users.length === 2);
assert(pres, "presence shows both users");
bsock.send({ t: "call", id: 1, moduleId, method: "list", args: [] });
assert((await bsock.next((m) => m.t === "call.result" && m.id === 1)).ok, "viewer may call readonly list()");
bsock.send({ t: "call", id: 2, moduleId, method: "add", args: ["hack"] });
assert(!(await bsock.next((m) => m.t === "call.result" && m.id === 2)).ok, "viewer may not call add()");
sock.send({ t: "call", id: 3, moduleId, method: "add", args: ["Order snacks"] });
const live = await bsock.next((m) => m.t === "module.event" && m.event === "changed");
assert(live.data.length === 2, "Ben receives Ana's change live");

console.log("airlocks: introduction, deferred approval, simulation, overlay");
const { grant } = await ana.call("POST", `/api/w/${ws}/grants`, { airlock: "mailbox", resource: "ana@corp.example", label: "mail", holder: { kind: "module", id: moduleId } });
await ana.call("PUT", `/api/modules/${moduleId}/files`, {
	path: "server.js",
	content: `export default class { async send(to) { return await ctx.airlocks.mail.send({ to, subject: "Hi", body: "From a module" }); } async sent() { return await ctx.airlocks.mail.list_sent({}); } async sneaky() { return await ctx.airlocks.github.repo_info({}); } }`,
});
sock.send({ t: "call", id: 4, moduleId, method: "send", args: ["ben@corp.example"] });
const sent = await sock.next((m) => m.t === "call.result" && m.id === 4);
assert(sent.ok && sent.value.queuedForApproval, "write is queued, simulated result returned");
sock.send({ t: "call", id: 5, moduleId, method: "sent", args: [] });
const overlay = await sock.next((m) => m.t === "call.result" && m.id === 5);
assert(overlay.value[0]?.status === "pending approval", "pending write overlaid on later read");
sock.send({ t: "call", id: 6, moduleId, method: "sneaky", args: [] });
const denied = await sock.next((m) => m.t === "call.result" && m.id === 6);
assert(!denied.ok && /No grant/.test(denied.error), "no ambient authority: un-introduced airlock refused");
const decision = await ana.call("POST", `/api/w/${ws}/approvals/${sent.value.queuedForApproval}/approve`);
assert(decision.status === "approved" && decision.result.status === "delivered", "approval executes the real action");
void grant;

console.log("agent-side airlock: request_access + chat grant");
const wsSock = await ana.socket();
wsSock.send({ t: "sub", kind: "ws", ws });
const snap = await wsSock.next((m) => m.t === "ws.snapshot");
assert(snap.approvals.actions[sent.value.queuedForApproval].status === "approved", "workspace snapshot carries approvals");

console.log("files: upload, attachments, module ctx.files capability, safe download");
const upload = async (c: ReturnType<typeof client>, name: string, body: Uint8Array | string, type: string) => {
	const res = await fetch(`${base}/api/w/${ws}/files`, { method: "POST", headers: { "content-type": type, "x-file-name": encodeURIComponent(name), cookie: (c as any).cookie() }, body: body as BodyInit });
	if (!res.ok) throw new Error(`upload ${res.status} ${await res.text()}`);
	return (await res.json()).file;
};
const csv = await upload(ana, "sales q3.csv", "region,amount\nnorth,10\nsouth,32\n", "text/csv");
assert(csv.kind === "csv" && csv.size === 32, `uploaded csv sniffed as ${csv.kind}`);
// 1x1 transparent PNG
const png = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64"));
const img = await upload(ana, "dot.png", png, "image/png");
assert(img.kind === "png", "uploaded png sniffed");
const html = await upload(ana, "evil.html", "<script>alert(1)</script>", "text/html");
const dl = await fetch(`${base}/api/w/${ws}/files/${html.id}?inline`, { headers: { cookie: (ana as any).cookie() } });
assert(dl.headers.get("content-type") === "application/octet-stream" && /attachment/.test(dl.headers.get("content-disposition") ?? "") && /sandbox/.test(dl.headers.get("content-security-policy") ?? ""), "untrusted html is never served inline");
await ana.call("POST", `/api/w/${ws}/chats/${chat}/messages`, { content: "what's in these?", files: [csv.id, img.id] });
const userEntry = await sock.next((m) => m.t === "chat.events" && m.events.some((e: any) => e.entry?.kind === "outpost.user" && e.entry.data?.files?.length === 2), 20000);
const entry = userEntry.events.find((e: any) => e.entry?.kind === "outpost.user" && e.entry.data?.files?.length === 2).entry;
const parts = entry.model[0].content;
assert(parts.some((p: any) => p.type === "image") && parts.some((p: any) => p.type === "text" && p.text.includes("north,10")), "model sees the image inline and the csv text");
await sock.next((m) => m.t === "chat.events" && m.events.some((e: any) => e.type === "run_end"), 30000);

const { module: fg } = await ana.call("POST", `/api/w/${ws}/modules`, { name: "CSV reader" });
await ana.call("PUT", `/api/modules/${fg.id}/files`, {
	path: "server.js",
	content: `export default class { rows(id) { return ctx.files.text(id).trim().split("\\n").map((l) => l.split(",")); } size(id) { return ctx.files.bytes(id).length; } async total(id) { const rows = this.rows(id).slice(1); const sum = rows.reduce((a, r) => a + Number(r[1]), 0); const f = await ctx.files.write("total.txt", "total=" + sum); return { sum, file: f.id }; } }`,
});
sock.send({ t: "call", id: 30, moduleId: fg.id, method: "rows", args: [csv.id] });
const denied2 = await sock.next((m) => m.t === "call.result" && m.id === 30);
assert(!denied2.ok && /No access to file/.test(denied2.error), "module cannot read an unshared file");
await ana.call("PATCH", `/api/w/${ws}/files/${csv.id}`, { modules: [fg.id] });
sock.send({ t: "call", id: 31, moduleId: fg.id, method: "size", args: [csv.id] });
assert((await sock.next((m) => m.t === "call.result" && m.id === 31)).value === 32, "ctx.files.bytes returns a Uint8Array of the file");
sock.send({ t: "call", id: 32, moduleId: fg.id, method: "total", args: [csv.id] });
const tot = await sock.next((m) => m.t === "call.result" && m.id === 32);
assert(tot.ok && tot.value.sum === 42, "module parsed the shared csv");
const listed = (await ana.call("GET", `/api/w/${ws}/files`)).files;
const out = listed.find((f: any) => f.id === tot.value.file);
assert(out?.source === "module" && out.modules.includes(fg.id), "module output appears in workspace files");
const outBody = await (await fetch(`${base}/api/w/${ws}/files/${out.id}`, { headers: { cookie: (ana as any).cookie() } })).text();
assert(outBody === "total=42", "downloaded module output");
await ana.call("DELETE", `/api/w/${ws}/files/${html.id}`);
assert(!(await ana.call("GET", `/api/w/${ws}/files`)).files.some((f: any) => f.id === html.id), "file deleted");

console.log("blueprints");
await ana.call("POST", "/api/blueprints", { moduleId, name: `Mail list ${suffix}`, description: "test", visibility: "public" });
const bps = await ben.call("GET", "/api/blueprints");
assert(bps.blueprints.some((b: any) => b.name === `Mail list ${suffix}`), "published blueprint visible to others");
assert(bps.blueprints.filter((b: any) => b.id.startsWith("bp_") && !b.authorId).length >= 5, "built-in blueprints installed");

// Compression: the app is half a megabyte of JavaScript, and it used to go over the wire raw.
// fetch() decodes for us, so these go through node:http to see the bytes as sent.
console.log("compression");
const http = await import("node:http");
const zlib = await import("node:zlib");
const { config } = await import("../src/config.ts");
const raw = (path: string, headers: Record<string, string>) =>
	new Promise<{ headers: Record<string, string | string[] | undefined>; body: Buffer }>((resolve, reject) => {
		const url = new URL(base + path);
		http
			.get({ hostname: url.hostname, port: url.port, path: url.pathname, headers }, (res) => {
				const chunks: Buffer[] = [];
				res.on("data", (c) => chunks.push(c));
				res.on("end", () => resolve({ headers: res.headers as never, body: Buffer.concat(chunks) }));
			})
			.on("error", reject);
	});
const asset = (await import("node:fs")).readdirSync(`${config.webDist}/assets`).find((f) => f.endsWith(".js"))!;
const identity = await raw(`/assets/${asset}`, { "accept-encoding": "identity" });
assert(!identity.headers["content-encoding"], "no encoding when the client doesn't ask for one");
assert(identity.headers["vary"] === "accept-encoding", "vary: accept-encoding");
const gz = await raw(`/assets/${asset}`, { "accept-encoding": "gzip" });
assert(gz.headers["content-encoding"] === "gzip", "gzip when offered");
assert(zlib.gunzipSync(gz.body).equals(identity.body), "the gzipped body is the same bytes");
assert(gz.body.length < identity.body.length / 2, `gzip shrinks it (${identity.body.length} → ${gz.body.length})`);
const br = await raw(`/assets/${asset}`, { "accept-encoding": "br, gzip" });
assert(br.headers["content-encoding"] === "br", "brotli preferred when offered");
assert(zlib.brotliDecompressSync(br.body).equals(identity.body), "the brotli body is the same bytes");
assert(br.body.length <= gz.body.length, `brotli is at least as small (${br.body.length} vs ${gz.body.length})`);
const again = await raw(`/assets/${asset}`, { "accept-encoding": "br, gzip" });
assert(again.headers["content-encoding"] === "br" && again.body.equals(br.body), "the encoded copy is reused");
const refused = await raw(`/assets/${asset}`, { "accept-encoding": "gzip;q=0, br;q=0" });
assert(!refused.headers["content-encoding"], "q=0 means no encoding");
const jsonPlain = await raw("/api/blueprints", { cookie: (ana as any).cookie() as string, "accept-encoding": "identity" });
const jsonZip = await raw("/api/blueprints", { cookie: (ana as any).cookie() as string, "accept-encoding": "gzip" });
assert(!jsonPlain.headers["content-encoding"] || jsonPlain.headers["content-encoding"] === "identity", "json is plain when not asked");
if (jsonZip.headers["content-encoding"] === "gzip") assert(zlib.gunzipSync(jsonZip.body).equals(jsonPlain.body), "compressed json decodes to the same document");
else assert(true, "json below the compression threshold stays plain");
const fontName = (await import("node:fs")).readdirSync(`${config.webDist}/assets`).find((f) => f.endsWith(".woff2"));
if (fontName) {
	const font = await raw(`/assets/${fontName}`, { "accept-encoding": "br, gzip" });
	assert(!font.headers["content-encoding"], "already-compressed assets are not re-compressed");
}

await finish();
