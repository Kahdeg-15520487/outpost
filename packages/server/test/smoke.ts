/**
 * End-to-end smoke test against a running server (default http://127.0.0.1:8799).
 * Uses the offline demo model, so no API key is needed.
 *   PORT=8799 PI_OS_DATA=/tmp/pios npx tsx src/main.ts &   then   npx tsx test/smoke.ts
 */
import WebSocket from "ws";

const base = process.env.BASE ?? "http://127.0.0.1:8799";
const assert = (cond: unknown, msg: string) => {
	if (!cond) throw new Error(`ASSERT: ${msg}`);
	console.log(`  ✓ ${msg}`);
};

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
	return { call, socket };
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

console.log("chat with the demo model creates a gadget from a blueprint");
const { id: chat } = await ana.call("POST", `/api/w/${ws}/chats`, { model: { provider: "pi-os-demo", modelId: "demo" } });
const sock = await ana.socket();
sock.send({ t: "sub", kind: "chat", ws, chat });
await sock.next((m) => m.t === "chat.events" && m.events[0]?.type === "snapshot");
await ana.call("POST", `/api/w/${ws}/chats/${chat}/messages`, { content: "make a todo list for the offsite" });
const toolEnd = await sock.next((m) => m.t === "chat.events" && m.events.some((e: any) => e.type === "tool_execution_end" && e.toolName === "gadget_create"), 30000);
assert(toolEnd, "agent ran gadget_create");
await sock.next((m) => m.t === "chat.events" && m.events.some((e: any) => e.type === "run_end"), 30000);
const { gadgets } = await ana.call("GET", `/api/w/${ws}/gadgets`);
assert(gadgets.length === 1 && gadgets[0].blueprintId === "bp_todo", "todo gadget exists");
const gadgetId = gadgets[0].id;

console.log("gadget RPC, durable state, broadcasts");
const detail = await ana.call("GET", `/api/gadgets/${gadgetId}`);
assert(detail.server.methods.includes("add") && !detail.server.error, `server started with methods ${detail.server.methods.join(",")}`);
sock.send({ t: "sub", kind: "gadget", gadgetId });
await sock.next((m) => m.t === "gadget.subscribed");
sock.send({ t: "call", id: 1, gadgetId, method: "add", args: ["Book venue", "ana"] });
const r1 = await sock.next((m) => m.t === "call.result" && m.id === 1);
assert(r1.ok && r1.value.length === 1, "add() returned the list");
const ev = await sock.next((m) => m.t === "gadget.event" && m.event === "changed");
assert(ev.data[0].text === "Book venue", "broadcast delivered after commit");
sock.send({ t: "call", id: 2, gadgetId, method: "toggle", args: ["nope"] });
const r2 = await sock.next((m) => m.t === "call.result" && m.id === 2);
assert(!r2.ok && /No such task/.test(r2.error), "a throwing call returns its error");
const state = await ana.call("GET", `/api/gadgets/${gadgetId}/state`);
assert(state.kv.items.length === 1, "state is durable in the workspace harness");

console.log("frame is sandboxed");
const { token } = await ana.call("POST", `/api/gadgets/${gadgetId}/frame-token`);
const frame = await fetch(`${base}/frame/${gadgetId}?t=${token}`);
const csp = frame.headers.get("content-security-policy") ?? "";
assert(csp.includes("connect-src 'none'") && csp.includes("sandbox allow-scripts"), "frame CSP forbids network and sandboxes");
assert((await frame.text()).includes("window.gadget"), "bootstrap injected");

console.log("sharing: links + viewer role + multiplayer");
await ana.call("POST", `/api/gadgets/${gadgetId}/links`, { role: "viewer" });
const links = (await ana.call("GET", `/api/gadgets/${gadgetId}`)).links;
await ben.call("POST", `/api/links/${links[0].token}/accept`);
const shared = await ben.call("GET", "/api/shared");
assert(shared.gadgets.length === 1 && shared.gadgets[0].role === "viewer", "Ben sees the shared gadget as viewer");
const bsock = await ben.socket();
bsock.send({ t: "sub", kind: "gadget", gadgetId });
await bsock.next((m) => m.t === "gadget.subscribed");
const pres = await sock.next((m) => m.t === "gadget.presence" && m.users.length === 2);
assert(pres, "presence shows both users");
bsock.send({ t: "call", id: 1, gadgetId, method: "list", args: [] });
assert((await bsock.next((m) => m.t === "call.result" && m.id === 1)).ok, "viewer may call readonly list()");
bsock.send({ t: "call", id: 2, gadgetId, method: "add", args: ["hack"] });
assert(!(await bsock.next((m) => m.t === "call.result" && m.id === 2)).ok, "viewer may not call add()");
sock.send({ t: "call", id: 3, gadgetId, method: "add", args: ["Order snacks"] });
const live = await bsock.next((m) => m.t === "gadget.event" && m.event === "changed");
assert(live.data.length === 2, "Ben receives Ana's change live");

console.log("gatekeepers: introduction, deferred approval, simulation, overlay");
const { grant } = await ana.call("POST", `/api/w/${ws}/grants`, { gatekeeper: "mailbox", resource: "ana@corp.example", label: "mail", holder: { kind: "gadget", id: gadgetId } });
await ana.call("PUT", `/api/gadgets/${gadgetId}/files`, {
	path: "server.js",
	content: `export default class { async send(to) { return await ctx.gatekeepers.mail.send({ to, subject: "Hi", body: "From a gadget" }); } async sent() { return await ctx.gatekeepers.mail.list_sent({}); } async sneaky() { return await ctx.gatekeepers.github.repo_info({}); } }`,
});
sock.send({ t: "call", id: 4, gadgetId, method: "send", args: ["ben@corp.example"] });
const sent = await sock.next((m) => m.t === "call.result" && m.id === 4);
assert(sent.ok && sent.value.queuedForApproval, "write is queued, simulated result returned");
sock.send({ t: "call", id: 5, gadgetId, method: "sent", args: [] });
const overlay = await sock.next((m) => m.t === "call.result" && m.id === 5);
assert(overlay.value[0]?.status === "pending approval", "pending write overlaid on later read");
sock.send({ t: "call", id: 6, gadgetId, method: "sneaky", args: [] });
const denied = await sock.next((m) => m.t === "call.result" && m.id === 6);
assert(!denied.ok && /No grant/.test(denied.error), "no ambient authority: un-introduced gatekeeper refused");
const decision = await ana.call("POST", `/api/w/${ws}/approvals/${sent.value.queuedForApproval}/approve`);
assert(decision.status === "approved" && decision.result.status === "delivered", "approval executes the real action");
void grant;

console.log("agent-side gatekeeper: request_access + chat grant");
const wsSock = await ana.socket();
wsSock.send({ t: "sub", kind: "ws", ws });
const snap = await wsSock.next((m) => m.t === "ws.snapshot");
assert(snap.approvals.actions[sent.value.queuedForApproval].status === "approved", "workspace snapshot carries approvals");

console.log("blueprints");
await ana.call("POST", "/api/blueprints", { gadgetId, name: `Mail list ${suffix}`, description: "test", visibility: "public" });
const bps = await ben.call("GET", "/api/blueprints");
assert(bps.blueprints.some((b: any) => b.name === `Mail list ${suffix}`), "published blueprint visible to others");
assert(bps.blueprints.filter((b: any) => b.id.startsWith("bp_") && !b.authorId).length >= 5, "built-in blueprints installed");

console.log("\nALL GOOD");
process.exit(0);
