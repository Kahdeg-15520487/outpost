/**
 * The Azure DevOps connector against a stand-in for dev.azure.com that records requests: the token
 * check, boards (WIQL query, get, create with JSON Patch, comment), approvals that depend on each
 * other (a comment on a work item still being created), pull requests, always-ask methods, a fixed
 * project, bad tokens, and proposals (unknown organizations are refused).
 * Run: pnpm --filter @pi-os/server test -- azure-devops
 */
import { check, finish, must } from "./lib/harness.ts";
import { createServer } from "node:http";

const PAT = "pat-secret-0123456789";
const ORG = "contoso";
type Hit = { method: string; path: string; query: Record<string, string>; auth?: string; type?: string; body?: any };
const hits: Hit[] = [];
const items: Record<number, any> = {
	1: { id: 1, fields: { "System.Id": 1, "System.WorkItemType": "User Story", "System.Title": "Sign in", "System.State": "Active", "System.TeamProject": "Shop", "System.AssignedTo": { displayName: "Ana" }, "System.Description": "<div>Users sign in with <b>email</b>.</div>" }, relations: [{ rel: "System.LinkTypes.Hierarchy-Forward", url: "https://dev.azure.com/contoso/_apis/wit/workItems/2" }] },
	2: { id: 2, fields: { "System.Id": 2, "System.WorkItemType": "Task", "System.Title": "Login form", "System.State": "New", "System.TeamProject": "Shop" } },
};
let nextId = 100;
const comments: { item: number; text: string }[] = [];

const server = createServer(async (req, res) => {
	const url = new URL(req.url!, "http://x");
	const body = await new Promise<string>((r) => {
		let b = "";
		req.on("data", (c) => (b += c));
		req.on("end", () => r(b));
	});
	const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
	const send = (status: number, v?: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(v === undefined ? "" : JSON.stringify(v));
	if (parts[0] !== ORG) return send(404, { message: "no such organization" });
	const auth = req.headers.authorization;
	if (auth !== `Basic ${Buffer.from(`:${PAT}`).toString("base64")}`) {
		// Like dev.azure.com: off to Microsoft's sign-in.
		res.writeHead(302, { location: "https://spsprodneu1.vssps.visualstudio.com/_signin?realm=dev.azure.com" }).end();
		return;
	}
	const rest = parts.slice(1);
	const apis = rest.indexOf("_apis");
	const project = apis === 1 ? rest[0] : undefined;
	const path = rest.slice(apis + 1).join("/");
	hits.push({ method: req.method!, path: `${project ? `${project}/` : ""}${path}`, query: Object.fromEntries(url.searchParams), auth, type: req.headers["content-type"], body: body ? JSON.parse(body) : undefined });
	const m = (re: RegExp) => re.exec(path);
	if (path === "connectionData") return send(200, { authenticatedUser: { id: "u-1", providerDisplayName: "Build Bot", descriptor: "Microsoft.IdentityModel.Claims.ClaimsIdentity;bot" } });
	if (path === "projects") return send(200, { value: [{ id: "p1", name: "Shop", state: "wellFormed" }] });
	if (path === "wit/wiql" && req.method === "POST") return send(200, { workItems: Object.keys(items).map((id) => ({ id: Number(id) })) });
	if (path === "wit/workitemsbatch" && req.method === "POST") return send(200, { value: JSON.parse(body).ids.map((id: number) => items[id]).filter(Boolean) });
	let g = m(/^wit\/workitems\/\$(.+)$/);
	if (g && req.method === "POST") {
		const id = nextId++;
		const fields: any = { "System.Id": id, "System.WorkItemType": g[1], "System.State": "New", "System.TeamProject": project };
		for (const op of JSON.parse(body)) if (op.path.startsWith("/fields/")) fields[op.path.slice(8)] = op.value;
		items[id] = { id, fields };
		return send(200, items[id]);
	}
	g = m(/^wit\/workitems\/(\d+)$/i);
	if (g && req.method === "GET") return items[Number(g[1])] ? send(200, items[Number(g[1])]) : send(404, { message: `Work item ${g[1]} does not exist` });
	if (g && req.method === "DELETE") return send(200, {});
	g = m(/^wit\/workItems\/(\d+)\/comments$/i);
	if (g && req.method === "POST") {
		comments.push({ item: Number(g[1]), text: JSON.parse(body).text });
		return send(200, { id: comments.length, createdBy: { displayName: "Build Bot" } });
	}
	if (path === "git/pullrequests") return send(200, { value: [{ pullRequestId: 7, title: "Add login", status: "active", sourceRefName: "refs/heads/login", targetRefName: "refs/heads/main", repository: { name: "web", project: { name: "Shop" } }, createdBy: { displayName: "Ana" }, reviewers: [{ displayName: "Bob", vote: 10 }] }] });
	send(404, { message: `no route ${req.method} ${path}` });
});
const port = await new Promise<number>((r) => server.listen(0, "127.0.0.1", () => r((server.address() as any).port)));
process.env.PI_OS_AZDO_URL = `http://127.0.0.1:${port}`;
process.env.PI_OS_ALLOW_PRIVATE_HOSTS = "1";

const { users, workspaces } = await import("../src/kernel/system-db.ts");
const { Workspace } = await import("../src/kernel/workspace.ts");
const { ConnectionsDoc } = await import("../src/kernel/docs.ts");
const { BACKGROUND_CONTEXT: ctx } = await import("@earendil-works/chord/context");

const u = users.create("azdo", "password123");
const ws = await Workspace.get(workspaces.create("azdo", u.id).id);
const holder = { kind: "gadget" as const, id: "g_azdo" };
const call = (grant: string, method: string, args: any = {}) => ws.gatekeeperCall(holder, grant, method, args, { ...holder, name: "test" });
const fails = async (p: Promise<unknown>) => {
	try {
		await p;
		return "";
	} catch (e) {
		return String((e as Error).message ?? e);
	}
};

console.log("connect");
const bad = await ws.connections.create({ kind: "azure-devops", label: "ado", params: { organization: ORG }, secrets: { password: "wrong-token-xyz" } }, "owner");
check("a wrong token: a clear error, not the sign-in page", bad.status === "error" && /rejected the credentials/.test(bad.error ?? "") && !(bad.error ?? "").includes("wrong-token-xyz"), bad.error);
const conn = await ws.connections.update(bad.id, { secrets: { password: PAT } });
must("with the token: connected, and says who it acts as", conn.status === "ok" && conn.account === "Build Bot", conn.error);
check("basic auth with an empty username", hits.at(-1)?.auth === `Basic ${Buffer.from(`:${PAT}`).toString("base64")}`);
check("the token is never stored in the workspace doc", !JSON.stringify(await ws.harness.snapshot(ConnectionsDoc, ctx)).includes(PAT));
const byName = (n: string) => conn.methods.find((m) => m.name === n)!;
check("about 30 methods across boards, repos, pipelines, wiki", conn.methods.length >= 28 && ["query_work_items", "create_pull_request", "run_pipeline", "get_wiki_page"].every((n) => byName(n)), conn.methods.length);
check("reads and writes classified by the connector; destructive ones always ask", byName("query_work_items").effect === "read" && byName("create_work_item").effect === "write" && byName("query_work_items").classifiedBy === "connector" && ["delete_work_item", "vote_on_pull_request", "complete_pull_request"].every((n) => byName(n).alwaysAsk));
check("without a fixed project, methods take one", (byName("query_work_items").inputSchema as any).required.includes("project"));

console.log("boards");
await ws.grant({ connection: "ado", holder, by: "owner" });
const found = (await call("ado", "query_work_items", { project: "Shop", wiql: "SELECT [System.Id] FROM WorkItems" })) as any[];
check("WIQL query → work items with their fields", found.length === 2 && found[0].title === "Sign in" && found[0].assignedTo === "Ana" && /\/contoso\/Shop\/_workitems\/edit\/1$/.test(found[0].url), found[0]);
check("…posted to the project's wiql endpoint, api-version 7.1", hits.some((h) => h.method === "POST" && h.path === "Shop/wit/wiql" && h.query["api-version"] === "7.1" && /SELECT/.test(h.body?.query)));
const one = (await call("ado", "get_work_item", { id: 1 })) as any;
check("get_work_item: description as text, links by type", one.description === "Users sign in with email." && one.links[0]?.type === "child" && one.links[0]?.id === 2, one);
check("a write missing a required argument is refused before it queues", /needs title/.test(await fails(call("ado", "create_work_item", { project: "Shop", type: "Bug" }))));
const created = (await call("ado", "create_work_item", { project: "Shop", type: "Bug", title: "Crash on login", description: "Steps:\n1. open\n2. <crash>", priority: 1 })) as any;
check("create_work_item queues with a believable pending item", created.result?.id === `pending:${created.queuedForApproval}` && created.result?.title === "Crash on login");
const listed = (await call("ado", "query_work_items", { project: "Shop", wiql: "SELECT [System.Id] FROM WorkItems" })) as any[];
check("…and shows up in queries while it waits", listed[0]?.id === created.result.id && listed.length === 3);
const commented = (await call("ado", "add_work_item_comment", { project: "Shop", id: created.result.id, text: "Found by the agent" })) as any;
check("approving the comment before the bug it's on is refused", /approve that one first/.test(await fails(ws.decide(commented.queuedForApproval, true, "owner"))));
await ws.decide(created.queuedForApproval, true, "owner");
const newBug = hits.find((h) => h.method === "POST" && h.path === "Shop/wit/workitems/$Bug")!;
check("create: JSON Patch with mapped fields, text turned into HTML", newBug.type === "application/json-patch+json" && newBug.body.some((o: any) => o.path === "/fields/System.Title" && o.value === "Crash on login") && newBug.body.some((o: any) => o.path === "/fields/Microsoft.VSTS.Common.Priority" && o.value === 1) && newBug.body.some((o: any) => o.path === "/fields/System.Description" && o.value === "Steps:<br>1. open<br>2. &lt;crash&gt;"), newBug.body);
await ws.decide(commented.queuedForApproval, true, "owner");
check("then the comment lands on the real work item", comments.at(-1)?.item === 100 && comments.at(-1)?.text === "Found by the agent", comments);
check("…via the preview comments API", hits.some((h) => h.path === "Shop/wit/workItems/100/comments" && h.query["api-version"] === "7.1-preview.4"));
const del = (await call("ado", "delete_work_item", { project: "Shop", id: 2 })) as any;
check("deleting always waits for approval", typeof del.queuedForApproval === "string");

console.log("repos");
const prs = (await call("ado", "list_pull_requests", { project: "Shop" })) as any[];
check("pull requests: branches, reviewers and votes", prs[0]?.source === "login" && prs[0]?.reviewers?.[0]?.vote === "approved" && hits.at(-1)?.query["searchCriteria.status"] === "active", prs[0]);
check("voting can never be auto-approved", /always asks|can't be auto-approved/.test(await fails(ws.grant({ connection: "ado", holder: { kind: "gadget", id: "g2" }, policy: { vote_on_pull_request: "auto" }, by: "owner" }))));

console.log("fixed project, proposals");
const pinned = await ws.connections.create({ kind: "azure-devops", label: "shop", params: { organization: ORG, project: "Shop" }, secrets: { password: PAT } }, "owner");
check("a fixed project: methods don't take one", pinned.status === "ok" && !("project" in ((pinned.methods.find((m) => m.name === "query_work_items")!.inputSchema as any).properties)));
await ws.grant({ connection: "shop", holder, by: "owner" });
await call("shop", "query_work_items", { project: "Elsewhere", wiql: "SELECT [System.Id] FROM WorkItems" });
check("…and an agent can't point it at another project", hits.filter((h) => h.path.endsWith("wit/wiql")).at(-1)?.path === "Shop/wit/wiql");
const chat = await ws.createChat(u, "p");
const asChat = { kind: "conversation" as const, id: chat, name: "Agent" };
check("proposing an unknown organization is refused", /no Azure DevOps organization "nope-org"/.test(await fails(ws.connections.propose({ kind: "azure-devops", label: "x1", params: { organization: "nope-org" }, auth: { kind: "basic" }, reason: "x" }, asChat))));
const prop = await ws.connections.propose({ kind: "azure-devops", label: "ado2", params: { organization: ORG, project: "Shop" }, auth: { kind: "none" }, reason: "boards" }, asChat);
check("a proposal for a real organization waits for an owner (auth forced to a token)", prop.status === "pending" && prop.auth.kind === "basic" && prop.params?.organization === ORG);
const fromProp = await ws.acceptProposal(prop.id, { secrets: { password: PAT } }, "owner");
check("the owner adds the token and it connects", fromProp.status === "ok" && fromProp.kind === "azure-devops");

server.close();
await finish();
