/**
 * Generic connectors end to end, against real local services:
 *  - an MCP server over streamable HTTP (bearer auth) and one over stdio (admin-declared),
 *  - a REST API described by an OpenAPI document (API key header), added by URL and declared by an admin.
 * Covers discovery (reads/writes/always-ask), secrets never leaving the server, the private-address
 * guard, capabilities (method subsets, per-method policy, byo never auto-approved), the approval
 * queue with action_result, revoking, removing, and the export/import note.
 * Run: pnpm --filter @pi-os/server test -- connectors
 */
import { check, finish, must, testDir } from "./lib/harness.ts";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const { MCP_TOKEN, API_KEY, notes, items, SPEC, apiHits, startServices } = await import("./fixtures/services.ts");
const services = await startServices();
const { mcpUrl, apiOrigin } = services;

// Admin-declared (vetted) connections, read from the config file pi-os loads at startup.
const configPath = join(testDir, "pi-os.config.json");
process.env.TEST_API_KEY = API_KEY;
process.env.FIXTURE_SECRET_SRC = "from-env-42";
writeFileSync(
	configPath,
	JSON.stringify({
		connectors: [
			{ id: "local", kind: "mcp", command: process.execPath, args: [fileURLToPath(new URL("./fixtures/mcp-stdio.mjs", import.meta.url))], env: { FIXTURE_SECRET: "$FIXTURE_SECRET_SRC" } },
			{ id: "inventory", kind: "openapi", label: "inv", spec: `${apiOrigin}/openapi.yaml`, auth: { kind: "header", name: "x-api-key", value: "$TEST_API_KEY" } },
		],
	}),
);
process.env.PI_OS_CONFIG = configPath;

const { users, workspaces } = await import("../src/kernel/system-db.ts");
const { Workspace } = await import("../src/kernel/workspace.ts");
const { GrantsDoc, ConnectionsDoc, ApprovalsDoc, AuditDoc } = await import("../src/kernel/docs.ts");
const { isPrivateAddress } = await import("../src/gatekeepers/net.ts");
const { assess, GADGET_RUNTIME } = await import("../src/gadgets/compat.ts");
const { config } = await import("../src/config.ts");
const { connectionSecrets } = await import("../src/gatekeepers/connectors/types.ts");
const { BACKGROUND_CONTEXT: ctx } = await import("@earendil-works/chord/context");

const u = users.create("connectors", "password123");
const ws = await Workspace.get(workspaces.create("connectors", u.id).id);
const holder = { kind: "gadget" as const, id: "g_conn_test" };
const as = { ...holder, name: "test gadget" };
const call = (grant: string, method: string, args: any = {}) => ws.gatekeeperCall(holder, grant, method, args, as);
const fails = async (p: Promise<unknown>) => {
	try {
		await p;
		return "";
	} catch (e) {
		return String((e as Error).message ?? e);
	}
};

// ------------------------------------------------------------------ auth
const { applyAuth } = await import("../src/gatekeepers/connectors/types.ts");
check("basic auth with an empty username (personal access tokens)", applyAuth({ kind: "basic" }, { password: "pat123" }).headers.authorization === `Basic ${Buffer.from(":pat123").toString("base64")}`);

// ------------------------------------------------------------------ address guard
console.log("address guard");
check("private, loopback, link-local and metadata addresses are private", ["127.0.0.1", "10.1.2.3", "192.168.1.1", "169.254.169.254", "::1", "::ffff:127.0.0.1", "fd00::1", "100.64.0.1"].every(isPrivateAddress));
check("public addresses aren't", !isPrivateAddress("8.8.8.8") && !isPrivateAddress("2606:4700:4700::1111"));
const blocked = await ws.connections.create({ kind: "mcp", label: "notes", url: mcpUrl, auth: { kind: "bearer" }, secrets: { token: MCP_TOKEN } }, "owner");
check("a connection added in the UI can't reach a local address", blocked.status === "error" && /private or local/.test(blocked.error ?? ""), blocked.error);
process.env.PI_OS_ALLOW_PRIVATE_HOSTS = "1";

// ------------------------------------------------------------------ MCP over HTTP
console.log("MCP server (HTTP)");
const notesConn = await ws.connections.refresh(blocked.id);
must("discovers the server's tools", notesConn.status === "ok" && notesConn.methods.length === 4, notesConn.error ?? notesConn.methods.map((m) => m.name));
const byName = (n: string) => notesConn.methods.find((m) => m.name === n)!;
check("readOnlyHint → read, classified by the server", byName("search_notes").effect === "read" && byName("search_notes").classifiedBy === "server");
check("no annotation → write (default)", byName("add_note").effect === "write" && byName("add_note").classifiedBy === "default" && !byName("add_note").alwaysAsk);
check("destructiveHint → always asks", byName("delete_note").alwaysAsk === true);
const described = JSON.stringify(ws.connections.describe(notesConn));
const stored = JSON.stringify(await ws.harness.snapshot(ConnectionsDoc, ctx));
check("the token never leaves the server: not in the API view, the workspace doc, or the file on disk", !described.includes(MCP_TOKEN) && !stored.includes(MCP_TOKEN) && !readFileSync(join(config.dataDir, "connections.enc.json"), "utf8").includes(MCP_TOKEN) && described.includes('"secretsSet":["token"]'));
check("byo connections can't be auto-approved", /can't be auto-approved/.test(await fails(ws.grant({ connection: notesConn.id, holder, autoApprove: true, by: "owner" }))));
check("…not even one method", /can't be auto-approved/.test(await fails(ws.grant({ connection: notesConn.id, holder, policy: { add_note: "auto" }, by: "owner" }))));
const g = await ws.grant({ connection: notesConn.id, holder, policy: { delete_note: "deny" }, by: "owner" });
check("a capability on a connection: gatekeeper is the connector, resource the label", g.gatekeeper === "mcp" && g.connection === notesConn.id && g.label === "notes");
const found = (await call("notes", "search_notes", { query: "hello" })) as any[];
check("reads run and return the tool's JSON", Array.isArray(found) && found[0]?.text === "hello world", found);
const audit = (await ws.harness.snapshot(AuditDoc, ctx))!.lines.at(-1)!;
check("the audit says who classified the read", audit.outcome === "ok" && /classified by server/.test(audit.detail ?? ""), audit);
const queued = (await call("notes", "add_note", { text: "from the agent" })) as any;
check("writes queue, with a pending result instead of a fake one", typeof queued.queuedForApproval === "string" && queued.result?.status === "pending" && queued.result?.actionId === queued.queuedForApproval);
check("…and the service wasn't called", !notes.some((n) => n.text === "from the agent"));
check("action_result: pending", (await ws.actionResult(holder, queued.queuedForApproval)).status === "pending");
await ws.decide(queued.queuedForApproval, true, "owner");
const done = await ws.actionResult(holder, queued.queuedForApproval);
check("approving runs it; action_result has the real result", done.status === "approved" && (done.result as any)?.text === "from the agent" && notes.some((n) => n.text === "from the agent"), done);
check("a denied method is refused", /doesn't allow delete_note/.test(await fails(call("notes", "delete_note", { id: 1 }))));
check("tool errors come back as errors", /kaboom/.test(await fails(call("notes", "explode"))));
check("unknown methods list what exists", /no method nope.*search_notes/.test(await fails(call("notes", "nope"))));
await ws.updateGrant(g.id, { methods: ["search_notes"] });
check("method subset: other methods are refused", /doesn't include add_note/.test(await fails(call("notes", "add_note", { text: "x" }))));
await ws.updateGrant(g.id, { methods: null });
const wrong = await ws.connections.update(notesConn.id, { secrets: { token: "wrong-token-999" } });
check("a bad token shows as an error, without echoing it", wrong.status === "error" && !(wrong.error ?? "").includes("wrong-token-999"), wrong.error);
await ws.connections.update(notesConn.id, { secrets: { token: MCP_TOKEN } });
const pendingDel = (await call("notes", "add_note", { text: "never" })) as any;
await ws.revoke(g.id);
check("revoking rejects the grant's queued actions", (await ws.actionResult(holder, pendingDel.queuedForApproval)).status === "rejected");

// ------------------------------------------------------------------ OpenAPI
console.log("REST API (OpenAPI)");
const inv = await ws.connections.create({ kind: "openapi", label: "items", spec: `${apiOrigin}/openapi.yaml`, auth: { kind: "header", name: "x-api-key" }, secrets: { value: API_KEY } }, "owner");
must("parses the document into operations", inv.status === "ok" && inv.methods.map((m) => m.name).sort().join() === "createItem,deleteItem,getItem,listItems", inv.error ?? inv.methods.map((m) => m.name));
check("the relative server URL resolves against the document's URL", inv.apiBase === `${apiOrigin}/api`, inv.apiBase);
const opBy = (n: string) => inv.methods.find((m) => m.name === n)!;
check("GET → read, POST → write, DELETE → always asks", opBy("listItems").effect === "read" && opBy("createItem").effect === "write" && opBy("deleteItem").alwaysAsk === true);
check("$refs resolved into the body schema", (opBy("createItem").inputSchema as any).properties?.body?.properties?.name?.type === "string");
const gi = await ws.grant({ connection: "items", holder, by: "owner" });
const listed = (await call("items", "listItems", { q: "anv" })) as any;
check("reads send query params and the API key", listed.status === 200 && listed.body?.[0]?.name === "Anvil" && apiHits.at(-1) === "GET /api/items?q=anv", listed);
const created = (await call("items", "createItem", { body: { name: "Bellows" } })) as any;
check("writes queue without calling the API", typeof created.queuedForApproval === "string" && !apiHits.some((h) => h.startsWith("POST")));
await ws.decide(created.queuedForApproval, true, "owner");
check("approved: the POST is sent with the JSON body", items.some((i) => i.name === "Bellows") && (await ws.actionResult(holder, created.queuedForApproval)).status === "approved");
const traversal = await fails(call("items", "getItem", { id: "../../openapi.yaml" }));
check("path parameters can't escape their segment", /HTTP 404/.test(traversal) && apiHits.at(-1) === "GET /api/items/..%2F..%2Fopenapi.yaml", [traversal, apiHits.at(-1)]);
check("missing path parameters are refused", /Missing path parameter "id"/.test(await fails(call("items", "getItem", {}))));
const relabeled = await ws.connections.update(inv.id, { reads: ["createItem"] });
check("the owner can mark a write as a read", relabeled.methods.find((m) => m.name === "createItem")?.effect === "read" && relabeled.methods.find((m) => m.name === "createItem")?.classifiedBy === "owner");
const pastedSpec = await ws.connections.create({ kind: "openapi", label: "pasted", specText: SPEC, baseUrl: `${apiOrigin}/api`, auth: { kind: "header", name: "x-api-key" }, secrets: { value: API_KEY } }, "owner");
check("a pasted document works too (with a base URL)", pastedSpec.status === "ok" && pastedSpec.spec === "inline" && pastedSpec.methods.length === 4, pastedSpec.error);
const pinned = await ws.connections.create({ kind: "openapi", label: "pinned", spec: `${apiOrigin}/openapi.yaml`, params: { q: "anv", id: "a1" }, auth: { kind: "header", name: "x-api-key" }, secrets: { value: API_KEY } }, "owner");
const pinnedList = pinned.methods.find((m) => m.name === "listItems")!;
check("fixed parameters are hidden from agents", !("q" in ((pinnedList.inputSchema as any).properties ?? {})) && !("id" in ((pinned.methods.find((m) => m.name === "getItem")!.inputSchema as any).properties ?? {})));
await ws.grant({ connection: "pinned", holder, by: "owner" });
const pinnedRes = (await call("pinned", "listItems", { q: "something else" })) as any;
check("…and always sent, whatever the agent passes", apiHits.at(-1) === "GET /api/items?q=anv" && pinnedRes.body?.[0]?.name === "Anvil", apiHits.at(-1));
const pinnedGet = (await call("pinned", "getItem", {})) as any;
check("a fixed path parameter fills its place (like an Azure DevOps organization)", pinnedGet.status === 200 && pinnedGet.body?.id === "a1" && apiHits.at(-1) === "GET /api/items/a1");
check("labels are unique and can't shadow built-ins", /already called/.test(await fails(ws.connections.create({ kind: "openapi", label: "items", specText: SPEC }, "o"))) && /built-in/.test(await fails(ws.connections.create({ kind: "openapi", label: "github", specText: SPEC }, "o"))));

// ------------------------------------------------------------------ admin-declared (vetted)
console.log("admin-declared connections");
const all = await ws.connections.list();
check("config connections appear in every workspace", all.some((c) => c.id === "cfg.local") && all.some((c) => c.id === "cfg.inventory" && c.label === "inv"));
const local = await ws.connections.require("local");
check("a local MCP command (stdio) runs for admin-declared connections", local.status === "ok" && local.methods.length === 2 && local.trust === "vetted", local.error);
const gl = await ws.grant({ connection: "local", holder, policy: { echo: "auto" }, by: "owner" });
const who = (await call("local", "whoami")) as any;
check("…with the env the config gives it ($VAR resolved)", who?.secret === "from-env-42" && typeof who?.pid === "number", who);
const echoed = (await call("local", "echo", { message: "hi" })) as any;
check("vetted writes can be auto-approved per method", echoed?.echoed === "hi", echoed);
const gv = await ws.grant({ connection: "inv", holder, by: "owner" });
check("vetted connections still always ask for DELETE", /always asks/.test(await fails(ws.updateGrant(gv.id, { policy: { deleteItem: "auto" } }))));
await ws.updateGrant(gv.id, { autoApprove: true });
const autoCreate = (await call("inv", "createItem", { body: { name: "Chisel" } })) as any;
const autoDelete = (await call("inv", "deleteItem", { id: "a1" })) as any;
check("auto-approve runs writes but not always-ask ones", autoCreate?.status === 201 && typeof autoDelete?.queuedForApproval === "string", [autoCreate, autoDelete]);
check("config connections can't be edited or removed in the UI", /pi-os.config.json/.test(await fails(ws.connections.update("cfg.local", { title: "x" }))) && /pi-os.config.json/.test(await fails(ws.removeConnection("cfg.local"))));
check("UI connections can't run local commands", /http\(s\)/.test(await fails(ws.connections.create({ kind: "mcp", label: "cmd", url: "file:///bin/sh" }, "o"))));
void gl;

// ------------------------------------------------------------------ project teams
console.log("project teams");
const pm = ws.projects;
pm.build.nudges = false;
const proj = await pm.create(u, { goal: "Connector project", model: { provider: "pi-os-demo", modelId: "demo" } });
await pm.stopAll(proj.id);
for (const role of ["worker", "planner"]) await pm.addAgent(proj.id, { role, brief: "wait", start: false });
const keyOf = async (role: string) => Object.values((await pm.state(proj.id)).agents).find((x) => x.role === role)!.key;
let seq = 5000;
const asAgent = async (role: string, name: string, args: unknown) => {
	const ag = (await pm.state(proj.id)).agents[await keyOf(role)]!;
	return pm.tools.get(name)!.execute(args, { conversationId: Number(ag.conversationId), taskId: ++seq } as any) as Promise<any>;
};
const out = (r: any) => (r?.output ?? []).map((o: any) => o.text).join("");
await ws.grant({ connection: notesConn.id, holder: { kind: "project", id: proj.id, roles: ["worker"] }, by: "owner" });
const dev = out(await asAgent("worker", "gatekeeper_call", { grant: "notes", method: "search_notes", args: { query: "hello" } }));
check("a grant for a project's developers: a developer calls it", dev.includes("hello world"), dev);
check("…other roles on the team can't", /No grant "notes"/.test(await fails(asAgent("planner", "gatekeeper_call", { grant: "notes", method: "search_notes", args: {} }))));
const devWrite = JSON.parse(out(await asAgent("worker", "gatekeeper_call", { grant: "notes", method: "add_note", args: { text: "from a developer" } })));
check("a developer's write queues for approval", typeof devWrite.queuedForApproval === "string" && !notes.some((n) => n.text === "from a developer"));
check("action_result works for project agents", JSON.parse(out(await asAgent("worker", "action_result", { actionId: devWrite.queuedForApproval }))).status === "pending");
const tools = JSON.parse(out(await asAgent("worker", "gatekeeper_tools", { grant: "notes", search: "delete" })));
check("gatekeeper_tools finds methods with their schemas", tools[0]?.name === "delete_note" && tools[0]?.arguments?.properties?.id?.type === "number" && tools[0]?.runs === "write, needs approval", tools);
const { resourcesSection } = await import("../src/gatekeepers/prompt.ts");
const held = Object.values((await ws.harness.snapshot(GrantsDoc, ctx))!.grants).filter((x) => x.holder.kind === "project");
const prompt = await resourcesSection(ws, held);
check("the agent's <resources> lists methods and how each runs", /search_notes\(query: string\?/.test(prompt) && /\[read\]/.test(prompt) && /add_note\(text: string\) \[write, needs approval\]/.test(prompt), prompt.slice(0, 400));
const asked = JSON.parse(out(await asAgent("planner", "request_access", { gatekeeper: "notes", reason: "read notes for the requirements", methods: ["search_notes"] })));
const req = (await ws.harness.snapshot(GrantsDoc, ctx))!.requests[asked.requested];
check("a project agent's access request is for its role and the methods it named", req?.connection === notesConn.id && req.holder.kind === "project" && req.holder.roles?.[0] === "planner" && req.methods?.join() === "search_notes", req);

// ------------------------------------------------------------------ proposals (agents draft, owners connect)
console.log("proposals");
const { createOsExtension } = await import("../src/agent/extension.ts");
const chatId = await ws.createChat(u, "proposals");
const proposeTool = createOsExtension(ws).tools!.find((t: any) => t.name === "propose_connection") as any;
const propose = async (args: any) => {
	const r = await proposeTool.execute(args, { conversationId: Number(chatId), taskId: 9000 + Math.floor(Math.random() * 1000) }, ctx);
	return JSON.parse(r.output.map((o: any) => o.text).join(""));
};
const paramNames = [...Object.keys(proposeTool.parameters.properties), ...Object.keys(proposeTool.parameters.properties.auth.properties)];
check("the tool has no field for a credential", !paramNames.some((n) => /token|password|secret|value|key/i.test(n)), paramNames);
const drafted = await propose({ kind: "openapi", label: "stock", title: "Stock API", spec: `${apiOrigin}/openapi.yaml`, auth: { kind: "header", name: "x-api-key" }, reason: "check stock levels for the report", setup: "Inventory admin → API keys" });
const prop = (await ws.connections.proposals()).find((p) => p.id === drafted.proposed);
check("a chat's agent drafts a connection: it waits for an owner", prop?.status === "pending" && prop.proposedBy.id === chatId && prop.setup === "Inventory admin → API keys" && !(await ws.connections.list()).some((c) => c.label === "stock"), prop);
check("an existing label is refused, pointing at request_access", /request_access/.test(await fails(propose({ kind: "mcp", label: "notes", url: mcpUrl, auth: { kind: "none" }, reason: "x" }))));
check("the same label can't be proposed twice", /already proposed/.test(await fails(propose({ kind: "openapi", label: "stock", spec: `${apiOrigin}/openapi.yaml`, auth: { kind: "none" }, reason: "x" }))));
check("URLs must be http(s)", /http\(s\)/.test(await fails(propose({ kind: "mcp", label: "evil", url: "file:///etc/passwd", auth: { kind: "none" }, reason: "x" }))));
const accepted = await ws.acceptProposal(prop!.id, { secrets: { value: API_KEY } }, "owner");
check("the owner adds the key and connects it", accepted.label === "stock" && accepted.status === "ok" && accepted.methods.length === 4 && accepted.trust === "byo", accepted.error);
check("the proposal records the connection it became", (await ws.connections.proposals()).find((p) => p.id === prop!.id)?.connection === accepted.id);
check("…and can't be accepted twice", /isn't waiting/.test(await fails(ws.acceptProposal(prop!.id, {}, "owner"))));
check("a made-up document URL goes back to the agent", /no OpenAPI document at that address/.test(await fails(propose({ kind: "openapi", label: "ghost", spec: `${apiOrigin}/specs/gone.json`, auth: { kind: "none" }, reason: "x" }))));
check("…so does an MCP URL with nothing behind it", /no MCP server at that address/.test(await fails(propose({ kind: "mcp", label: "ghost", url: `${apiOrigin}/nothing/mcp`, auth: { kind: "none" }, reason: "x" }))));
check("an MCP server that wants a key (401) is fine to propose", !(await fails(propose({ kind: "mcp", label: "notes2", url: mcpUrl, auth: { kind: "bearer" }, reason: "x" }))));
const second = await propose({ kind: "mcp", label: "maybe", url: mcpUrl, auth: { kind: "bearer" }, reason: "might help" });
await ws.declineProposal(second.proposed, "owner");
check("an owner can decline one", (await ws.connections.proposals()).find((p) => p.id === second.proposed)?.status === "declined");
await ws.removeConnection(accepted.id);

// ------------------------------------------------------------------ removal, export
console.log("removal and export");
void gi;
await ws.connections.update(inv.id, { reads: [] });
const pendingItem2 = (await call("items", "createItem", { body: { name: "Never" } })) as any;
await ws.removeConnection(inv.id);
const grantsAfter = Object.values((await ws.harness.snapshot(GrantsDoc, ctx))!.grants).filter((x) => x.connection === inv.id);
const approvals = (await ws.harness.snapshot(ApprovalsDoc, ctx))!.actions;
check("removing a connection revokes its grants and rejects their queued actions", grantsAfter.length === 0 && approvals[pendingItem2.queuedForApproval]?.status === "rejected", grantsAfter.length);
check("…and forgets its secrets", Object.keys(connectionSecrets.get(ws.id, inv.id)).length === 0 && Object.keys(connectionSecrets.get(ws.id, pastedSpec.id)).length === 1);
const a = assess({ runtime: GADGET_RUNTIME, server: ["gatekeepers"], client: [], gatekeepers: [{ id: "mcp", methods: ["search_notes"] }] });
check("import check: a gadget using a connection runs, with a note to connect the service", a.status === "ok" && /Connections/.test(a.notes.join(" ")), a);

services.close();
await finish();
