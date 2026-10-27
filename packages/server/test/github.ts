/**
 * The GitHub repository connector against a stand-in for api.github.com that records requests: the
 * token and repository check, reads (repository, issues, files), approved writes, scoping to one
 * repository, secret redaction, always-queued writes for connections added in the UI, and proposals.
 * Run: pnpm --filter @outpost/server test -- github
 */
import { check, finish, must } from "./lib/harness.ts";
import { createServer } from "node:http";

const TOKEN = "github_pat_secret_0123456789";
const REPO = "acme/widgets";
type Hit = { method: string; path: string; query: Record<string, string>; auth?: string; accept?: string; version?: string; body?: any };
const hits: Hit[] = [];
const issues = [
	{ number: 1, title: "Crash on start", state: "open", user: { login: "ana" }, labels: [{ name: "bug" }], comments: 1, html_url: `https://github.com/${REPO}/issues/1`, created_at: "2026-01-01T00:00:00Z", body: "It crashes." },
	{ number: 2, title: "Add dark mode (PR)", state: "open", user: { login: "bo" }, labels: [], comments: 0, html_url: `https://github.com/${REPO}/pull/2`, created_at: "2026-01-02T00:00:00Z", pull_request: {} },
];
const created: any[] = [];
const posted: any[] = [];
let leakToken = false;
let userForbidden = false;

const server = createServer(async (req, res) => {
	const url = new URL(req.url!, "http://x");
	const body = await new Promise<string>((r) => {
		let b = "";
		req.on("data", (c) => (b += c));
		req.on("end", () => r(b));
	});
	const send = (status: number, v: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(v));
	hits.push({ method: req.method!, path: url.pathname, query: Object.fromEntries(url.searchParams), auth: req.headers.authorization, accept: req.headers.accept, version: req.headers["x-github-api-version"] as string, body: body ? JSON.parse(body) : undefined });
	if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { message: leakToken ? `Bad credentials for ${req.headers.authorization}` : "Bad credentials" });
	const p = url.pathname;
	if (p === "/user") return userForbidden ? send(403, { message: "Resource not accessible by integration" }) : send(200, { login: "build-bot" });
	if (p === "/rate-limited") return send(403, { message: "API rate limit exceeded" });
	if (!p.startsWith(`/repos/${REPO}`)) return send(404, { message: "Not Found" });
	const rest = p.slice(`/repos/${REPO}`.length);
	if (rest === "") return send(200, { full_name: REPO, description: "Widgets", stargazers_count: 7, default_branch: "main", topics: ["tools"], open_issues_count: 2, html_url: `https://github.com/${REPO}` });
	if (rest === "/issues" && req.method === "GET") return send(200, url.searchParams.get("state") === "closed" ? [] : issues);
	if (rest === "/issues" && req.method === "POST") {
		const b = JSON.parse(body);
		const issue = { number: 50 + created.length, title: b.title, state: "open", user: { login: "build-bot" }, labels: (b.labels ?? []).map((name: string) => ({ name })), comments: 0, html_url: `https://github.com/${REPO}/issues/${50 + created.length}`, created_at: "2026-02-01T00:00:00Z" };
		created.push(issue);
		return send(201, issue);
	}
	if (rest === "/issues/1") return send(200, issues[0]);
	if (rest === "/issues/1/comments" && req.method === "GET") return send(200, [{ user: { login: "bo" }, body: "Same here", created_at: "2026-01-03T00:00:00Z" }]);
	if (rest === "/issues/1/comments" && req.method === "POST") {
		posted.push(JSON.parse(body));
		return send(201, { html_url: `https://github.com/${REPO}/issues/1#issuecomment-9` });
	}
	if (rest === "/contents/") return send(200, [{ name: "src", path: "src", type: "dir", size: 0 }, { name: "README.md", path: "README.md", type: "file", size: 12 }]);
	if (rest === "/contents/README.md") return send(200, { path: "README.md", size: 12, encoding: "base64", content: Buffer.from("# Widgets\nhi").toString("base64") });
	if (rest === "/contents/src/a%20b.txt") return send(200, { path: "src/a b.txt", size: 3, encoding: "base64", content: Buffer.from("odd").toString("base64") });
	send(404, { message: "Not Found" });
});
const port = await new Promise<number>((r) => server.listen(0, "127.0.0.1", () => r((server.address() as any).port)));
process.env.OUTPOST_GITHUB_URL = `http://127.0.0.1:${port}`;
process.env.OUTPOST_ALLOW_PRIVATE_HOSTS = "1";

const { users, workspaces } = await import("../src/kernel/system-db.ts");
const { Workspace } = await import("../src/kernel/workspace.ts");
const { ConnectionsDoc } = await import("../src/kernel/docs.ts");
const { githubRepository } = await import("../src/airlocks/connectors/github.ts");
const { BACKGROUND_CONTEXT: ctx } = await import("@earendil-works/chord/context");

const u = users.create("gh", "password123");
const ws = await Workspace.get(workspaces.create("gh", u.id).id);
const holder = { kind: "module" as const, id: "g_gh" };
const call = (grant: string, method: string, args: any = {}) => ws.airlockCall(holder, grant, method, args, { ...holder, name: "test" });
const fails = async (p: Promise<unknown>) => {
	try {
		await p;
		return "";
	} catch (e) {
		return String((e as Error).message ?? e);
	}
};

console.log("repository names");
check("owner/repo and the GitHub URL forms are accepted", githubRepository("acme/widgets") === REPO && githubRepository("https://github.com/acme/widgets.git/") === REPO);
check("anything else is refused", ["acme", "a/b/c", "https://evil.example/a/b", "../x", "acme/..", "acme/wid gets", ""].every((v) => !!(() => { try { githubRepository(v); return ""; } catch (e) { return "x"; } })()));
check("an invalid repository is refused when connecting", /owner\/repo/.test(await fails(ws.connections.create({ kind: "github-repo", label: "bad", params: { repository: "acme" }, secrets: { token: TOKEN } }, "owner"))));

console.log("connect");
const bad = await ws.connections.create({ kind: "github-repo", label: "gh", params: { repository: REPO }, secrets: { token: "wrong-token-xyz" } }, "owner");
check("a wrong token: a clear error", bad.status === "error" && /GitHub 401.*Check the token/.test(bad.error ?? ""), bad.error);
leakToken = true;
const leaky = await ws.connections.update(bad.id, { secrets: { token: "wrong-token-xyz" } });
check("a server that echoes the token back doesn't leak it", leaky.status === "error" && !(leaky.error ?? "").includes("wrong-token-xyz"), leaky.error);
leakToken = false;
const missing = await ws.connections.create({ kind: "github-repo", label: "gone", params: { repository: "acme/missing" }, secrets: { token: TOKEN } }, "owner");
check("a repository the token can't see: a helpful error", missing.status === "error" && /GitHub 404.*repository name/.test(missing.error ?? ""), missing.error);
const conn = await ws.connections.update(bad.id, { secrets: { token: TOKEN } });
must("with a good token: connected, and says who it acts as", conn.status === "ok" && conn.account === "build-bot" && conn.apiBase === `https://github.com/${REPO}`, conn.error);
const last = hits.filter((h) => h.path === `/repos/${REPO}`).at(-1)!;
check("bearer token, the GitHub media type and API version are sent", last.auth === `Bearer ${TOKEN}` && last.accept === "application/vnd.github+json" && last.version === "2026-03-10", last);
check("authentication can't be changed to something else", (await ws.connections.require(conn.id)).auth.kind === "bearer");
check("the token is never stored in the workspace doc", !JSON.stringify(await ws.harness.snapshot(ConnectionsDoc, ctx)).includes(TOKEN));
check("it's a workspace-added connection: untrusted", conn.trust === "byo" && conn.source === "workspace");
const names = conn.methods.map((m) => m.name).sort().join();
check("six basic methods", names === "comment,create_issue,get_issue,list_issues,read_file,repo_info", names);
check("reads read, writes write", conn.methods.filter((m) => m.effect === "read").map((m) => m.name).sort().join() === "get_issue,list_issues,read_file,repo_info" && conn.methods.filter((m) => m.effect === "write").length === 2);

console.log("reads");
await ws.grant({ connection: "gh", holder, by: "owner" });
const info = (await call("gh", "repo_info")) as any;
check("repo_info", info.name === REPO && info.stars === 7 && info.defaultBranch === "main", info);
const open = (await call("gh", "list_issues", { limit: 5, page: 2, labels: "bug" })) as any[];
check("list_issues drops pull requests", open.length === 1 && open[0].number === 1 && open[0].labels[0] === "bug", open);
const q = hits.filter((h) => h.path === `/repos/${REPO}/issues`).at(-1)!.query;
check("…and sends state, page size, page and labels", q.state === "open" && q.per_page === "5" && q.page === "2" && q.labels === "bug", q);
check("a bad state is refused before any request", /state must be/.test(await fails(call("gh", "list_issues", { state: "everything" }))));
check("a non-numeric limit is refused", /positive integer/.test(await fails(call("gh", "list_issues", { limit: "ten" }))));
const issue = (await call("gh", "get_issue", { number: 1 })) as any;
check("get_issue: body and comments", issue.body === "It crashes." && issue.commentsList[0]?.user === "bo", issue);
check("get_issue needs a number", /needs number/.test(await fails(call("gh", "get_issue", {}))));
const file = (await call("gh", "read_file", { path: "README.md", ref: "dev" })) as any;
check("read_file decodes the content and passes the ref", file.content === "# Widgets\nhi" && hits.filter((h) => h.path.endsWith("/contents/README.md")).at(-1)?.query.ref === "dev", file);
const dir = (await call("gh", "read_file", { path: "" })) as any[];
check("an empty path lists the repository root", dir.length === 2 && dir[1].name === "README.md", dir);
check("paths are encoded", ((await call("gh", "read_file", { path: "src/a b.txt" })) as any).content === "odd");
const before = hits.length;
check("path tricks are refused without a request", (await Promise.all(["../secret", "/etc/passwd", "a/../../b", "a\\b"].map((path) => fails(call("gh", "read_file", { path }))))).every((m) => /repository-relative/.test(m)) && hits.length === before);

console.log("scope");
await call("gh", "list_issues", { repo: "other/repo", repository: "other/repo", owner: "other" });
check("an agent can't point it at another repository", hits.filter((h) => h.path.endsWith("/issues") && h.method === "GET").at(-1)?.path === `/repos/${REPO}/issues`);
check("every repository request stayed on the configured repository", hits.every((h) => h.path === "/user" || h.path === `/repos/${REPO}` || h.path.startsWith(`/repos/${REPO}/`) || h.path === "/repos/acme/missing"));

console.log("writes");
const queued = (await call("gh", "create_issue", { title: "Flaky test", body: "Fails on CI", labels: ["ci"] })) as any;
check("create_issue queues and nothing is sent yet", typeof queued.queuedForApproval === "string" && !hits.some((h) => h.method === "POST" && h.path.endsWith("/issues")) && created.length === 0, queued);
check("a write needs its required arguments before it queues", /needs title/.test(await fails(call("gh", "create_issue", {}))));
await ws.decide(queued.queuedForApproval, true, "owner");
check("approving sends it, with the labels", created.length === 1 && created[0].title === "Flaky test" && hits.filter((h) => h.method === "POST" && h.path.endsWith("/issues")).at(-1)?.body.labels?.[0] === "ci");
const commentAction = (await call("gh", "comment", { number: 1, body: "Thanks!" })) as any;
check("comment queues too", typeof commentAction.queuedForApproval === "string" && posted.length === 0);
await ws.decide(commentAction.queuedForApproval, true, "owner");
check("…and posts once approved", posted.at(-1)?.body === "Thanks!");
check("writes added in the UI can never be auto-approved", /can't be auto-approved|never|always/i.test(await fails(ws.grant({ connection: "gh", holder: { kind: "module", id: "g_gh2" }, policy: { create_issue: "auto" }, autoApprove: true, by: "owner" }))));
userForbidden = true;
const noUser = await ws.connections.refresh(conn.id);
check("a token that can't read /user (403) still connects when the repository is readable", noUser.status === "ok" && noUser.account === "token", noUser.error);
userForbidden = false;

const viaUrl = await ws.connections.create({ kind: "github-repo", label: "viaurl", params: { repository: `https://github.com/${REPO}.git/` }, secrets: { token: TOKEN } }, "owner");
check("a repository typed as a URL is stored as owner/repo", viaUrl.params?.repository === REPO && viaUrl.status === "ok", viaUrl.params);
const edited = await ws.connections.update(viaUrl.id, { params: { repository: `https://github.com/${REPO}` } });
check("…also when edited", edited.params?.repository === REPO);

console.log("proposals");
const chat = await ws.createChat(u, "p");
const asChat = { kind: "conversation" as const, id: chat, name: "Agent" };
check("proposing a bad repository is refused", /owner\/repo/.test(await fails(ws.connections.propose({ kind: "github-repo", label: "p1", params: { repository: "nope" }, reason: "x" }, asChat))));
const prop = await ws.connections.propose({ kind: "github-repo", label: "p2", params: { repository: `https://github.com/${REPO}` }, auth: { kind: "none" }, reason: "triage issues", setup: "Settings → Developer settings → Fine-grained tokens" }, asChat);
check("a proposal waits for an owner, with auth forced to a token", prop.status === "pending" && prop.auth.kind === "bearer" && prop.params?.repository === REPO);
const accepted = await ws.acceptProposal(prop.id, { secrets: { token: TOKEN } }, "owner");
check("the owner adds the token and it connects", accepted.status === "ok" && accepted.kind === "github-repo" && accepted.account === "build-bot", accepted.error);

server.close();
await finish();
