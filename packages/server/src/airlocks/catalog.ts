import type { Harness } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { config } from "../config.ts";
import { type ApprovalAction, MailboxDoc } from "../kernel/docs.ts";

/**
 * A Airlock is the "device driver" between agents/modules and an external service. It exposes
 * a small, typed API scoped to one resource (a repo, an origin, an outbox). Reads run; writes are
 * simulated and queued for human approval unless the grant says otherwise. `overlay` folds the
 * still-pending writes into later reads, so the agent sees a consistent world while it works.
 */
export type AirlockIo = { harness: Harness };
export type AirlockMethod = {
	description: string;
	params: Record<string, string>;
	effect: "read" | "write";
	run(resource: string, args: any, io: AirlockIo): Promise<unknown>;
	simulate?(resource: string, args: any, actionId: string): unknown;
	summarize?(args: any): string;
	/** Never auto-approved, whatever the grant says (deletes, destructive tools). */
	alwaysAsk?: boolean;
	/** JSON Schema of the arguments (generic connectors), shown by airlock_tools. */
	inputSchema?: Record<string, unknown>;
	/** Who classified a read as a read: the connector, the server's annotation, the HTTP verb, the owner. */
	classifiedBy?: string;
};
export type Airlock = {
	id: string;
	title: string;
	icon: string;
	description: string;
	resourceHint: string;
	setup?: string;
	normalizeResource(input: string): string;
	methods: Record<string, AirlockMethod>;
	overlay?(method: string, args: any, result: any, pending: ApprovalAction[]): any;
	/** byo: added by a workspace owner, so its writes are never auto-approved. Built-ins and admin-declared connections are trusted. */
	trust?: "vetted" | "byo";
	/** The workspace connection behind it (generic connectors). */
	connection?: string;
};

const truncate = (s: string, n = 60_000) => (s.length > n ? `${s.slice(0, n)}\n…[truncated ${s.length - n} chars]` : s);

async function http(url: string, init: RequestInit = {}) {
	const response = await fetch(url, { ...init, signal: AbortSignal.timeout(20_000), redirect: "manual" });
	const text = await response.text();
	let body: unknown = truncate(text);
	if ((response.headers.get("content-type") ?? "").includes("json")) {
		try {
			body = JSON.parse(text);
		} catch {}
	}
	return { status: response.status, contentType: response.headers.get("content-type"), body };
}

// ---------------------------------------------------------------- web: one origin

const web: Airlock = {
	id: "web",
	title: "Web origin",
	icon: "🌐",
	description: "HTTP access to exactly one origin (scheme + host). GET runs; other verbs need approval.",
	resourceHint: "https://api.example.com",
	normalizeResource(input) {
		const url = new URL(input.includes("://") ? input : `https://${input}`);
		if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Only http(s) origins");
		return url.origin;
	},
	methods: {
		get: {
			description: "GET a path on the origin. Returns { status, contentType, body } (JSON parsed when possible).",
			params: { path: "string — path + query, e.g. /v1/items?limit=5", headers: "object? — extra request headers" },
			effect: "read",
			run: (origin, a) => http(new URL(a.path ?? "/", origin).href, { headers: a.headers }),
		},
		request: {
			description: "Send a non-GET request (POST/PUT/PATCH/DELETE). Side effect: queued for approval.",
			params: { method: "string", path: "string", body: "any? — JSON-encoded unless string", headers: "object?" },
			effect: "write",
			summarize: (a) => `${a.method ?? "POST"} ${a.path}`,
			simulate: (_o, a) => ({ status: 202, simulated: true, note: `${a.method} ${a.path} will be sent once approved` }),
			run: (origin, a) =>
				http(new URL(a.path ?? "/", origin).href, {
					method: a.method ?? "POST",
					headers: { "content-type": "application/json", ...a.headers },
					body: a.body === undefined ? undefined : typeof a.body === "string" ? a.body : JSON.stringify(a.body),
				}),
		},
	},
};

// ---------------------------------------------------------------- github: one repository

const gh = (path: string, init: RequestInit = {}) =>
	http(`https://api.github.com${path}`, {
		...init,
		headers: {
			accept: "application/vnd.github+json",
			"user-agent": "outpost",
			...(config.githubToken() ? { authorization: `Bearer ${config.githubToken()}` } : {}),
			...(init.body ? { "content-type": "application/json" } : {}),
		},
	}).then((r) => {
		if (r.status >= 400) throw new Error(`GitHub ${r.status}: ${JSON.stringify(r.body).slice(0, 300)}`);
		return r.body as any;
	});

const issueSummary = (i: any) => ({ number: i.number, title: i.title, state: i.state, user: i.user?.login, labels: i.labels?.map((l: any) => l.name), comments: i.comments, url: i.html_url, createdAt: i.created_at });

const github: Airlock = {
	id: "github",
	title: "GitHub repository",
	icon: "🐙",
	description: "Read a repository's metadata, issues and files; create issues and comments with approval.",
	resourceHint: "owner/repo or https://github.com/owner/repo",
	setup: "Set airlocks.github.token in outpost.config.json (e.g. \"$GITHUB_TOKEN\") for private repositories, writes, and higher rate limits.",
	normalizeResource(input) {
		const m = /(?:github\.com[/:])?([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(input.trim());
		if (!m) throw new Error("Expected owner/repo");
		return `${m[1]}/${m[2]}`;
	},
	methods: {
		repo_info: {
			description: "Repository metadata: description, stars, default branch, topics, open issues.",
			params: {},
			effect: "read",
			run: async (repo) => {
				const r = await gh(`/repos/${repo}`);
				return { name: r.full_name, description: r.description, stars: r.stargazers_count, forks: r.forks_count, defaultBranch: r.default_branch, topics: r.topics, openIssues: r.open_issues_count, url: r.html_url, pushedAt: r.pushed_at };
			},
		},
		list_issues: {
			description: "List issues (excludes PRs).",
			params: { state: "'open'|'closed'|'all' = 'open'", labels: "string? comma-separated", limit: "number = 30" },
			effect: "read",
			run: async (repo, a) => {
				const q = new URLSearchParams({ state: a.state ?? "open", per_page: String(Math.min(a.limit ?? 30, 100)) });
				if (a.labels) q.set("labels", a.labels);
				return (await gh(`/repos/${repo}/issues?${q}`)).filter((i: any) => !i.pull_request).map(issueSummary);
			},
		},
		get_issue: {
			description: "One issue with body and the latest comments.",
			params: { number: "number" },
			effect: "read",
			run: async (repo, a) => {
				const issue = await gh(`/repos/${repo}/issues/${a.number}`);
				const comments = await gh(`/repos/${repo}/issues/${a.number}/comments?per_page=30`);
				return { ...issueSummary(issue), body: issue.body, commentsList: comments.map((c: any) => ({ user: c.user?.login, body: c.body, at: c.created_at })) };
			},
		},
		read_file: {
			description: "Read a text file (or list a directory) at a ref.",
			params: { path: "string", ref: "string? branch/tag/sha" },
			effect: "read",
			run: async (repo, a) => {
				const r = await gh(`/repos/${repo}/contents/${encodeURIComponent(a.path ?? "").replaceAll("%2F", "/")}${a.ref ? `?ref=${a.ref}` : ""}`);
				if (Array.isArray(r)) return r.map((e: any) => ({ name: e.name, type: e.type, size: e.size }));
				return { path: r.path, size: r.size, content: truncate(Buffer.from(r.content ?? "", "base64").toString("utf8")) };
			},
		},
		create_issue: {
			description: "Create an issue. Side effect: queued for approval.",
			params: { title: "string", body: "string?", labels: "string[]?" },
			effect: "write",
			summarize: (a) => `Create issue “${a.title}”`,
			simulate: (repo, a, id) => ({ number: `pending:${id}`, title: a.title, state: "open", url: `https://github.com/${repo}/issues (pending approval)`, simulated: true }),
			run: async (repo, a) => issueSummary(await gh(`/repos/${repo}/issues`, { method: "POST", body: JSON.stringify({ title: a.title, body: a.body, labels: a.labels }) })),
		},
		comment: {
			description: "Comment on an issue or PR. Side effect: queued for approval.",
			params: { number: "number", body: "string" },
			effect: "write",
			summarize: (a) => `Comment on #${a.number}`,
			simulate: (_r, a) => ({ ok: true, issue: a.number, simulated: true }),
			run: async (repo, a) => {
				const c = await gh(`/repos/${repo}/issues/${a.number}/comments`, { method: "POST", body: JSON.stringify({ body: a.body }) });
				return { ok: true, url: c.html_url };
			},
		},
	},
	overlay(method, args, result, pending) {
		if (method !== "list_issues" || (args.state ?? "open") === "closed") return result;
		const created = pending.filter((p) => p.method === "create_issue").map((p) => p.simulated);
		return [...created, ...(result as any[])];
	},
};

// ---------------------------------------------------------------- mailbox: local outbox

const mailbox: Airlock = {
	id: "mailbox",
	title: "Mailbox (local)",
	icon: "✉️",
	description: "A local outbox to try deferred approvals safely: sending is queued, approving 'delivers' it.",
	resourceHint: "you@company.example",
	normalizeResource: (input) => input.trim() || "me@outpost.local",
	methods: {
		list_sent: {
			description: "Messages sent from this mailbox, newest first (pending ones included).",
			params: {},
			effect: "read",
			run: async (_r, _a, io) => [...((await io.harness.snapshot(MailboxDoc, BACKGROUND_CONTEXT))?.sent ?? [])].reverse(),
		},
		send: {
			description: "Send an email. Side effect: queued for approval.",
			params: { to: "string", subject: "string", body: "string" },
			effect: "write",
			summarize: (a) => `Email ${a.to}: “${a.subject}”`,
			simulate: (_r, a, id) => ({ id, ...a, status: "pending approval", simulated: true }),
			run: async (_r, a, io) => {
				const mail = { id: `m_${Date.now().toString(36)}`, to: String(a.to), subject: String(a.subject), body: String(a.body), sentAt: Date.now() };
				await io.harness.commit(async (tx) => {
					(await tx.doc(MailboxDoc)).sent.push(mail);
				}, BACKGROUND_CONTEXT);
				return { ...mail, status: "delivered" };
			},
		},
	},
	overlay(method, _args, result, pending) {
		if (method !== "list_sent") return result;
		return [...pending.filter((p) => p.method === "send").map((p) => p.simulated).reverse(), ...(result as any[])];
	},
};

export const AIRLOCKS: Record<string, Airlock> = { web, github, mailbox };

export function describeAirlock(gk: Airlock) {
	return {
		id: gk.id,
		title: gk.title,
		icon: gk.icon,
		description: gk.description,
		resourceHint: gk.resourceHint,
		setup: gk.setup,
		methods: Object.entries(gk.methods).map(([name, m]) => ({ name, description: m.description, params: m.params, effect: m.effect })),
	};
}
