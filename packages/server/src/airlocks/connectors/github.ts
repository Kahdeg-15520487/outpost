import { guardedFetch } from "../net.ts";
import { applyAuth, redact, truncateText, type Connection, type ConnectionSecrets, type ConnMethod } from "./types.ts";

/** GitHub.com REST, pinned to one repository. No ambient/global GitHub credentials. */
const host = () => (process.env.OUTPOST_GITHUB_URL ?? "https://api.github.com").replace(/\/+$/, "");
const str = (description: string) => ({ type: "string", description });
const number = { type: "integer", minimum: 1, description: "issue or pull request number" };
const schema = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required, additionalProperties: false });
const definitions: ConnMethod[] = [
	{ name: "repo_info", description: "Repository metadata, default branch and topics.", effect: "read", classifiedBy: "connector", inputSchema: schema({}) },
	{ name: "list_issues", description: "List issues (excludes pull requests); use page for more results.", effect: "read", classifiedBy: "connector", inputSchema: schema({ state: { enum: ["open", "closed", "all"], type: "string" }, labels: str("comma-separated labels"), limit: { type: "integer", minimum: 1, maximum: 100 }, page: { type: "integer", minimum: 1 } }) },
	{ name: "get_issue", description: "One issue or pull request's issue details, body and first 30 comments.", effect: "read", classifiedBy: "connector", inputSchema: schema({ number }, ["number"]) },
	{ name: "read_file", description: "Read a text file or list a directory. Empty path lists the root; optional branch, tag or commit ref.", effect: "read", classifiedBy: "connector", inputSchema: schema({ path: str("repository-relative path"), ref: str("branch, tag or commit") }) },
	{ name: "create_issue", description: "Create an issue. Requires approval for workspace-added connections.", effect: "write", classifiedBy: "connector", inputSchema: schema({ title: str("issue title"), body: str("Markdown body"), labels: { type: "array", items: { type: "string" } } }, ["title"]) },
	{ name: "comment", description: "Comment on an issue or pull request. Requires approval for workspace-added connections.", effect: "write", classifiedBy: "connector", inputSchema: schema({ number, body: str("Markdown comment") }, ["number", "body"]) },
];

export function githubRepository(value: string): string {
	let repo = value.trim();
	if (/^https:\/\/github\.com\//i.test(repo)) repo = repo.replace(/^https:\/\/github\.com\//i, "");
	repo = repo.replace(/\/$/, "").replace(/\.git$/, "");
	const parts = repo.split("/");
	if (parts.length !== 2 || parts.some((p) => !/^[A-Za-z0-9_.-]+$/.test(p) || p === "." || p === "..")) throw new Error("GitHub needs a repository: owner/repo or https://github.com/owner/repo");
	return repo;
}

export function githubMethods(conn: Connection): ConnMethod[] {
	return definitions.map((m) => ({ ...m, ...(m.effect === "write" && conn.reads?.includes(m.name) ? { effect: "read" as const, classifiedBy: "owner" as const } : {}) }));
}

function client(conn: Connection, secrets: ConnectionSecrets) {
	const repo = githubRepository(conn.params?.repository ?? "");
	const prefix = `/repos/${repo.split("/").map(encodeURIComponent).join("/")}`;
	const auth = applyAuth({ kind: "bearer" }, secrets);
	const request = async (method: string, path: string, body?: unknown, query: Record<string, string> = {}) => {
		const url = new URL(`${host()}${path}`);
		for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
		try {
			const res = await guardedFetch(url, { method, headers: { ...auth.headers, accept: "application/vnd.github+json", "x-github-api-version": "2026-03-10", "user-agent": "outpost", ...(body === undefined ? {} : { "content-type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body), allowPrivate: conn.source === "config", timeoutMs: 20_000, maxBytes: 4 << 20 });
			if (res.truncated) throw new Error("GitHub response is too large; request a smaller page or file");
			let data: any;
			try { data = res.text ? JSON.parse(res.text) : {}; } catch { throw new Error(`GitHub returned an unexpected response (HTTP ${res.status})`); }
			if (res.status >= 400) {
				const hint = res.status === 401 ? "Check the token and its expiry." : res.status === 403 ? "Check token permissions, organization approval/SSO and rate limits." : res.status === 404 ? "Check the repository name and the token's repository access." : "";
				throw new Error(`GitHub ${res.status}: ${String(data.message ?? "Request failed").slice(0, 300)} ${hint}`.trim());
			}
			return data;
		} catch (e) { throw new Error(redact(String((e as Error).message ?? e), secrets)); }
	};
	return { repo, prefix, request };
}

/** Read-only validation: identify the account and verify access to the configured repository. */
export async function githubCheck(conn: Connection, secrets: ConnectionSecrets) {
	const c = client(conn, secrets);
	// Some tokens (GitHub App installation tokens) may not read /user; the repository check below still proves access.
	const user = await c.request("GET", "/user").catch((e: Error) => {
		if (/^GitHub 403/.test(e.message)) return { login: "token" };
		throw e;
	});
	if (!user.login) throw new Error("GitHub did not identify this token's account");
	const repo = await c.request("GET", c.prefix);
	if (!repo.full_name) throw new Error("GitHub did not return repository metadata");
	return { name: String(user.login), repository: String(repo.full_name), url: `https://github.com/${c.repo}` };
}

const issue = (i: any) => ({ number: i.number, title: i.title, state: i.state, user: i.user?.login, labels: i.labels?.map((l: any) => typeof l === "string" ? l : l.name), comments: i.comments, url: i.html_url, createdAt: i.created_at });
const positive = (v: unknown, fallback?: number) => {
	if (v === undefined && fallback !== undefined) return fallback;
	if (!Number.isSafeInteger(v) || (v as number) < 1) throw new Error("Expected a positive integer");
	return v as number;
};
export async function githubCall(conn: Connection, secrets: ConnectionSecrets, name: string, args: any = {}): Promise<unknown> {
	const method = definitions.find((m) => m.name === name);
	if (!method) throw new Error(`GitHub has no method "${name}"`);
	for (const key of method.inputSchema.required ?? []) if (args[key] === undefined || args[key] === null || args[key] === "") throw new Error(`Missing ${key}`);
	const c = client(conn, secrets);
	switch (name) {
		case "repo_info": {
			const r = await c.request("GET", c.prefix);
			return { name: r.full_name, description: r.description, stars: r.stargazers_count, defaultBranch: r.default_branch, topics: r.topics, openIssues: r.open_issues_count, url: r.html_url };
		}
		case "list_issues": {
			const state = args.state ?? "open";
			if (!["open", "closed", "all"].includes(state)) throw new Error("state must be open, closed or all");
			const result = await c.request("GET", `${c.prefix}/issues`, undefined, { state, per_page: String(Math.min(positive(args.limit, 30), 100)), page: String(positive(args.page, 1)), ...(args.labels ? { labels: String(args.labels) } : {}) });
			return result.filter((i: any) => !i.pull_request).map(issue);
		}
		case "get_issue": {
			const path = `${c.prefix}/issues/${positive(args.number)}`;
			const i = await c.request("GET", path);
			const comments = await c.request("GET", `${path}/comments`, undefined, { per_page: "30" });
			return { ...issue(i), body: truncateText(i.body ?? ""), commentsList: comments.map((x: any) => ({ user: x.user?.login, body: truncateText(x.body ?? ""), at: x.created_at })) };
		}
		case "read_file": {
			const path = String(args.path ?? "");
			if (path.startsWith("/") || path.includes("\\") || path.includes("\0") || path.split("/").some((p) => p === "." || p === "..")) throw new Error("Use a repository-relative file path without . or .. segments");
			const r = await c.request("GET", `${c.prefix}/contents/${path.split("/").map(encodeURIComponent).join("/")}`, undefined, args.ref ? { ref: String(args.ref) } : {});
			if (Array.isArray(r)) return r.map((e: any) => ({ name: e.name, path: e.path, type: e.type, size: e.size }));
			if (r.encoding !== "base64") throw new Error("GitHub cannot return this file as inline content; it may be too large");
			return { path: r.path, size: r.size, content: truncateText(Buffer.from(r.content ?? "", "base64").toString("utf8")) };
		}
		case "create_issue": return issue(await c.request("POST", `${c.prefix}/issues`, { title: args.title, body: args.body, labels: args.labels }));
		case "comment": {
			const r = await c.request("POST", `${c.prefix}/issues/${positive(args.number)}/comments`, { body: args.body });
			return { ok: true, url: r.html_url };
		}
	}
}
