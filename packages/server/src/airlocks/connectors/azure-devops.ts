import { guardedFetch } from "../net.ts";
import { applyAuth, type Connection, type ConnectionSecrets, type ConnMethod, redact, truncateText } from "./types.ts";

/**
 * Azure DevOps, hand-written on the REST API (7.1): Microsoft doesn't publish OpenAPI documents any
 * more, and its hosted MCP server needs Entra sign-in. Authenticates with a personal access token
 * (basic auth, empty username). The connection fixes the organization, and optionally the project
 * (then methods don't take one). Results are trimmed to what an agent needs.
 */

const API = "7.1";
/** https://dev.azure.com, or a stand-in for tests. */
const host = () => (process.env.OUTPOST_AZDO_URL ?? "https://dev.azure.com").replace(/\/+$/, "");

type Ctx = {
	org: string;
	project?: string;
	/** dev.azure.com/<org>[/<project>]/_apis/<path> */
	url(path: string, opts?: { project?: string; query?: Record<string, string | number | boolean | undefined> }): string;
	req(method: string, url: string, opts?: { body?: unknown; contentType?: string; text?: boolean }): Promise<any>;
	/** The signed-in identity (for "mine" filters and votes). */
	me(): Promise<{ id: string; name: string }>;
	web(path: string): string;
};

type Def = {
	name: string;
	description: string;
	effect: "read" | "write";
	alwaysAsk?: boolean;
	/** Takes a project (unless the connection fixes one). */
	project?: boolean;
	params: Record<string, any>;
	required?: string[];
	run(ctx: Ctx & { p: string }, a: any): Promise<unknown>;
	simulate?(a: any, id: string): unknown;
};

const enc = encodeURIComponent;
const str = (description: string, extra: object = {}) => ({ type: "string", description, ...extra });
const num = (description: string, extra: object = {}) => ({ type: "number", description, ...extra });
const bool = (description: string) => ({ type: "boolean", description });
const html = (s: unknown) =>
	typeof s === "string"
		? truncateText(
				s
					.replace(/<br\s*\/?>/gi, "\n")
					.replace(/<\/(p|div|li|h\d)>/gi, "\n")
					.replace(/<[^>]+>/g, "")
					.replace(/&nbsp;/g, " ")
					.replace(/&lt;/g, "<")
					.replace(/&gt;/g, ">")
					.replace(/&quot;/g, '"')
					.replace(/&#39;/g, "'")
					.replace(/&amp;/g, "&")
					.replace(/\n{3,}/g, "\n\n")
					.trim(),
				20_000,
			)
		: undefined;
/** Plain text or markdown from an agent → the HTML Azure DevOps stores in rich-text fields. */
const HTML_TAG = /<\/?(p|div|br|b|i|u|em|strong|ul|ol|li|a|h[1-6]|span|code|pre|table|tr|td|th|img|blockquote)\b[^>]*>/i;
const toHtml = (s: string) => (HTML_TAG.test(s) ? s : s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "<br>"));
const who = (v: any) => (v && typeof v === "object" ? (v.displayName ?? v.uniqueName) : v);
const branch = (b: string | undefined) => (b ? (b.startsWith("refs/") ? b : `refs/heads/${b}`) : undefined);
const short = (ref: string | undefined) => ref?.replace(/^refs\/heads\//, "");

const WI_FIELDS = ["System.Id", "System.WorkItemType", "System.Title", "System.State", "System.AssignedTo", "System.AreaPath", "System.IterationPath", "System.Tags", "System.ChangedDate", "System.TeamProject"];
const FIELD_ALIASES: Record<string, string> = {
	title: "System.Title",
	description: "System.Description",
	state: "System.State",
	assignedTo: "System.AssignedTo",
	areaPath: "System.AreaPath",
	iterationPath: "System.IterationPath",
	tags: "System.Tags",
	priority: "Microsoft.VSTS.Common.Priority",
	acceptanceCriteria: "Microsoft.VSTS.Common.AcceptanceCriteria",
	storyPoints: "Microsoft.VSTS.Scheduling.StoryPoints",
	reproSteps: "Microsoft.VSTS.TCM.ReproSteps",
};
const RICH = new Set(["System.Description", "Microsoft.VSTS.Common.AcceptanceCriteria", "Microsoft.VSTS.TCM.ReproSteps"]);
const FIELD_PARAMS = {
	description: str("plain text or markdown (stored as HTML)"),
	state: str("e.g. New, Active, Resolved, Closed (depends on the process)"),
	assignedTo: str("a person's email or display name"),
	areaPath: str("e.g. Project\\Team"),
	iterationPath: str("e.g. Project\\Sprint 12"),
	tags: str("semicolon-separated, e.g. 'ui; urgent'"),
	priority: num("1 (highest) to 4"),
	acceptanceCriteria: str("plain text or markdown"),
	storyPoints: num("effort estimate"),
	fields: { type: "object", description: "any other fields by reference name, e.g. {\"Custom.Team\": \"Core\"}" },
};

function patchOps(a: any): { op: string; path: string; value: unknown }[] {
	const ops: { op: string; path: string; value: unknown }[] = [];
	const set = (ref: string, v: unknown) => {
		if (v === undefined || v === null) return;
		ops.push({ op: "add", path: `/fields/${ref}`, value: RICH.has(ref) && typeof v === "string" ? toHtml(v) : v });
	};
	for (const [alias, ref] of Object.entries(FIELD_ALIASES)) set(ref, a[alias]);
	for (const [ref, v] of Object.entries((a.fields ?? {}) as Record<string, unknown>)) set(ref, v);
	return ops;
}

function wiSummary(w: any, ctx: Ctx) {
	const f = w.fields ?? {};
	return {
		id: w.id,
		type: f["System.WorkItemType"],
		title: f["System.Title"],
		state: f["System.State"],
		assignedTo: who(f["System.AssignedTo"]),
		areaPath: f["System.AreaPath"],
		iterationPath: f["System.IterationPath"],
		tags: f["System.Tags"],
		changed: f["System.ChangedDate"],
		url: ctx.web(`${enc(f["System.TeamProject"] ?? ctx.project ?? "")}/_workitems/edit/${w.id}`),
	};
}

const REL: Record<string, string> = {
	parent: "System.LinkTypes.Hierarchy-Reverse",
	child: "System.LinkTypes.Hierarchy-Forward",
	related: "System.LinkTypes.Related",
	predecessor: "System.LinkTypes.Dependency-Reverse",
	successor: "System.LinkTypes.Dependency-Forward",
};
const relName = (rel: string) => Object.entries(REL).find(([, v]) => v === rel)?.[0] ?? rel;

function prSummary(pr: any, ctx: Ctx) {
	return {
		id: pr.pullRequestId,
		title: pr.title,
		status: pr.status,
		draft: pr.isDraft || undefined,
		repository: pr.repository?.name,
		source: short(pr.sourceRefName),
		target: short(pr.targetRefName),
		createdBy: who(pr.createdBy),
		created: pr.creationDate,
		reviewers: (pr.reviewers ?? []).map((r: any) => ({ name: r.displayName, vote: VOTE_NAME[r.vote] ?? r.vote })),
		url: ctx.web(`${enc(pr.repository?.project?.name ?? ctx.project ?? "")}/_git/${enc(pr.repository?.name ?? "")}/pullrequest/${pr.pullRequestId}`),
	};
}
const VOTE: Record<string, number> = { approve: 10, "approve-with-suggestions": 5, reset: 0, wait: -5, reject: -10 };
const VOTE_NAME: Record<number, string> = { 10: "approved", 5: "approved with suggestions", 0: "no vote", [-5]: "waiting for author", [-10]: "rejected" };

function buildSummary(b: any, ctx: Ctx) {
	return {
		id: b.id,
		number: b.buildNumber,
		pipeline: b.definition?.name,
		pipelineId: b.definition?.id,
		status: b.status,
		result: b.result,
		branch: short(b.sourceBranch),
		requestedFor: who(b.requestedFor),
		queued: b.queueTime,
		finished: b.finishTime,
		url: ctx.web(`${enc(b.project?.name ?? ctx.project ?? "")}/_build/results?buildId=${b.id}`),
	};
}

const DEFS: Def[] = [
	// ------------------------------------------------------------ core
	{
		name: "list_projects",
		description: "Projects in the organization.",
		effect: "read",
		params: { top: num("default 100") },
		run: async (c, a) => (await c.req("GET", c.url("projects", { query: { $top: a.top ?? 100 } }))).value.map((p: any) => ({ id: p.id, name: p.name, description: p.description, state: p.state })),
	},
	{
		name: "list_teams",
		description: "Teams in a project.",
		effect: "read",
		project: true,
		params: {},
		run: async (c) => (await c.req("GET", c.url(`projects/${enc(c.p)}/teams`))).value.map((t: any) => ({ id: t.id, name: t.name, description: t.description })),
	},
	{
		name: "get_current_user",
		description: "Who this connection acts as.",
		effect: "read",
		params: {},
		run: async (c) => c.me(),
	},
	// ------------------------------------------------------------ boards
	{
		name: "query_work_items",
		description:
			"Find work items with a WIQL query. Returns id, type, title, state, assignee, area, iteration, tags. Example: SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND [System.State] <> 'Closed' AND [System.AssignedTo] = @Me ORDER BY [System.ChangedDate] DESC",
		effect: "read",
		project: true,
		params: { wiql: str("the WIQL query (SELECT [System.Id] FROM WorkItems WHERE …)"), top: num("at most this many (default 50, max 200)") },
		required: ["wiql"],
		run: async (c, a) => {
			const top = Math.min(Math.max(Number(a.top) || 50, 1), 200);
			const r = await c.req("POST", c.url("wit/wiql", { project: c.p, query: { $top: top } }), { body: { query: a.wiql } });
			const ids: number[] = [...new Set<number>([...(r.workItems ?? []).map((w: any) => w.id), ...(r.workItemRelations ?? []).map((w: any) => w.target?.id).filter(Boolean)])].slice(0, top);
			if (!ids.length) return [];
			const batch = await c.req("POST", c.url("wit/workitemsbatch"), { body: { ids, fields: WI_FIELDS } });
			const byId = new Map<number, any>(batch.value.map((w: any) => [w.id, w]));
			return ids.map((id) => byId.get(id)).filter(Boolean).map((w) => wiSummary(w, c));
		},
	},
	{
		name: "get_work_item",
		description: "One work item: fields, description, acceptance criteria, links (parent, children, related, pull requests).",
		effect: "read",
		params: { id: num("work item id") },
		required: ["id"],
		run: async (c, a) => {
			const w = await c.req("GET", c.url(`wit/workitems/${enc(a.id)}`, { query: { $expand: "relations" } }));
			const f = w.fields ?? {};
			return {
				...wiSummary(w, c),
				project: f["System.TeamProject"],
				description: html(f["System.Description"]),
				acceptanceCriteria: html(f["Microsoft.VSTS.Common.AcceptanceCriteria"]),
				reproSteps: html(f["Microsoft.VSTS.TCM.ReproSteps"]),
				priority: f["Microsoft.VSTS.Common.Priority"],
				storyPoints: f["Microsoft.VSTS.Scheduling.StoryPoints"],
				createdBy: who(f["System.CreatedBy"]),
				created: f["System.CreatedDate"],
				comments: f["System.CommentCount"],
				links: (w.relations ?? []).map((r: any) => ({ type: relName(r.rel), id: /workItems\/(\d+)$/i.exec(r.url ?? "")?.[1] ? Number(/workItems\/(\d+)$/i.exec(r.url)![1]) : undefined, url: r.url, name: r.attributes?.name })),
				otherFields: Object.fromEntries(Object.entries(f).filter(([k]) => !k.startsWith("System.") && !k.startsWith("Microsoft.VSTS.Common.") && !k.startsWith("Microsoft.VSTS.Scheduling.") && !k.startsWith("WEF_"))),
			};
		},
	},
	{
		name: "list_work_item_comments",
		description: "The discussion on a work item, newest first.",
		effect: "read",
		project: true,
		params: { id: num("work item id"), top: num("default 50") },
		required: ["id"],
		run: async (c, a) => {
			const r = await c.req("GET", c.url(`wit/workItems/${enc(a.id)}/comments`, { project: c.p, query: { $top: a.top ?? 50, "api-version": "7.1-preview.4" } }));
			return (r.comments ?? []).map((x: any) => ({ id: x.id, by: who(x.createdBy), at: x.createdDate, text: html(x.text) }));
		},
	},
	{
		name: "list_work_item_types",
		description: "Work item types in the project (User Story, Bug, Task, …) and their states.",
		effect: "read",
		project: true,
		params: {},
		run: async (c) => (await c.req("GET", c.url("wit/workitemtypes", { project: c.p }))).value.map((t: any) => ({ name: t.name, description: t.description, states: (t.states ?? []).map((s: any) => s.name) })),
	},
	{
		name: "list_iterations",
		description: "A team's sprints (iterations). timeframe 'current' gives the running one.",
		effect: "read",
		project: true,
		params: { team: str("team name (default: the project's default team)"), timeframe: str("'current' for only the running iteration", { enum: ["current"] }) },
		run: async (c, a) => {
			const base = `${host()}/${enc(c.org)}/${enc(c.p)}${a.team ? `/${enc(a.team)}` : ""}/_apis/work/teamsettings/iterations`;
			const u = new URL(base);
			u.searchParams.set("api-version", API);
			if (a.timeframe) u.searchParams.set("$timeframe", a.timeframe);
			return (await c.req("GET", u.href)).value.map((i: any) => ({ id: i.id, name: i.name, path: i.path, start: i.attributes?.startDate, finish: i.attributes?.finishDate, timeFrame: i.attributes?.timeFrame }));
		},
	},
	{
		name: "create_work_item",
		description: "Create a work item (User Story, Bug, Task, Feature, Epic, …). Optionally under a parent.",
		effect: "write",
		project: true,
		params: { type: str("work item type, e.g. 'User Story', 'Bug', 'Task'"), title: str("title"), ...FIELD_PARAMS, parent: num("parent work item id") },
		required: ["type", "title"],
		run: async (c, a) => {
			const ops = patchOps(a);
			if (a.parent !== undefined) ops.push({ op: "add", path: "/relations/-", value: { rel: REL.parent, url: `${host()}/${enc(c.org)}/_apis/wit/workItems/${enc(a.parent)}` } });
			const w = await c.req("POST", c.url(`wit/workitems/$${enc(a.type)}`, { project: c.p }), { body: ops, contentType: "application/json-patch+json" });
			return wiSummary(w, c);
		},
		simulate: (a, id) => ({ id: `pending:${id}`, type: a.type, title: a.title, state: a.state ?? "New", assignedTo: a.assignedTo, parent: a.parent, simulated: true }),
	},
	{
		name: "update_work_item",
		description: "Change a work item's fields: state, title, assignee, iteration, tags, description, priority, or any field by reference name.",
		effect: "write",
		params: { id: num("work item id"), title: str("new title"), ...FIELD_PARAMS },
		required: ["id"],
		run: async (c, a) => {
			const ops = patchOps(a).map((o) => ({ ...o, op: "add" }));
			if (!ops.length) throw new Error("Nothing to change: give at least one field");
			return wiSummary(await c.req("PATCH", c.url(`wit/workitems/${enc(a.id)}`), { body: ops, contentType: "application/json-patch+json" }), c);
		},
		simulate: (a) => ({ id: a.id, updated: Object.keys(a).filter((k) => k !== "id"), simulated: true }),
	},
	{
		name: "add_work_item_comment",
		description: "Comment on a work item.",
		effect: "write",
		project: true,
		params: { id: num("work item id"), text: str("plain text or markdown") },
		required: ["id", "text"],
		run: async (c, a) => {
			const r = await c.req("POST", c.url(`wit/workItems/${enc(a.id)}/comments`, { project: c.p, query: { "api-version": "7.1-preview.4" } }), { body: { text: toHtml(String(a.text)) } });
			return { id: r.id, workItem: a.id, by: who(r.createdBy) };
		},
		simulate: (a, id) => ({ id: `pending:${id}`, workItem: a.id, simulated: true }),
	},
	{
		name: "link_work_items",
		description: "Link two work items: the second becomes the first's parent, child, related item, predecessor or successor.",
		effect: "write",
		params: { id: num("work item to link from"), to: num("work item to link to"), as: str("what `to` is to `id`", { enum: Object.keys(REL) }) },
		required: ["id", "to", "as"],
		run: async (c, a) => {
			const rel = REL[a.as];
			if (!rel) throw new Error(`as: one of ${Object.keys(REL).join(", ")}`);
			await c.req("PATCH", c.url(`wit/workitems/${enc(a.id)}`), { body: [{ op: "add", path: "/relations/-", value: { rel, url: `${host()}/${enc(c.org)}/_apis/wit/workItems/${enc(a.to)}` } }], contentType: "application/json-patch+json" });
			return { linked: true, id: a.id, to: a.to, as: a.as };
		},
	},
	{
		name: "delete_work_item",
		description: "Delete a work item (it goes to the recycle bin).",
		effect: "write",
		alwaysAsk: true,
		project: true,
		params: { id: num("work item id") },
		required: ["id"],
		run: async (c, a) => {
			await c.req("DELETE", c.url(`wit/workitems/${enc(a.id)}`, { project: c.p }));
			return { deleted: a.id };
		},
	},
	// ------------------------------------------------------------ repos
	{
		name: "list_repositories",
		description: "Git repositories in the project.",
		effect: "read",
		project: true,
		params: {},
		run: async (c) => (await c.req("GET", c.url("git/repositories", { project: c.p }))).value.map((r: any) => ({ id: r.id, name: r.name, defaultBranch: short(r.defaultBranch), url: r.webUrl, disabled: r.isDisabled || undefined })),
	},
	{
		name: "list_branches",
		description: "Branches of a repository.",
		effect: "read",
		project: true,
		params: { repository: str("repository name or id"), filter: str("only branches starting with this") },
		required: ["repository"],
		run: async (c, a) => {
			const r = await c.req("GET", c.url(`git/repositories/${enc(a.repository)}/refs`, { project: c.p, query: { filter: `heads/${a.filter ?? ""}` } }));
			return r.value.map((b: any) => ({ name: short(b.name), commit: b.objectId, creator: who(b.creator) }));
		},
	},
	{
		name: "list_files",
		description: "Files and folders in a repository path.",
		effect: "read",
		project: true,
		params: { repository: str("repository name or id"), path: str("folder, default /"), branch: str("default: the default branch"), recursive: bool("the whole tree under path (at most 1000 entries)") },
		required: ["repository"],
		run: async (c, a) => {
			const r = await c.req("GET", c.url(`git/repositories/${enc(a.repository)}/items`, { project: c.p, query: { scopePath: a.path ?? "/", recursionLevel: a.recursive ? "Full" : "OneLevel", "versionDescriptor.version": a.branch, "versionDescriptor.versionType": a.branch ? "branch" : undefined } }));
			return r.value.slice(0, 1000).map((i: any) => ({ path: i.path, folder: i.isFolder || undefined }));
		},
	},
	{
		name: "get_file",
		description: "A text file's content from a repository.",
		effect: "read",
		project: true,
		params: { repository: str("repository name or id"), path: str("file path"), branch: str("default: the default branch") },
		required: ["repository", "path"],
		run: async (c, a) => {
			const r = await c.req("GET", c.url(`git/repositories/${enc(a.repository)}/items`, { project: c.p, query: { path: a.path, includeContent: true, $format: "json", "versionDescriptor.version": a.branch, "versionDescriptor.versionType": a.branch ? "branch" : undefined } }));
			return { path: r.path, commit: r.commitId, content: truncateText(String(r.content ?? "")) };
		},
	},
	{
		name: "list_pull_requests",
		description: "Pull requests in the project (or one repository): active by default.",
		effect: "read",
		project: true,
		params: { repository: str("only this repository (name or id)"), status: str("default active", { enum: ["active", "completed", "abandoned", "all"] }), mine: bool("only ones this connection's account created"), reviewing: bool("only ones it's asked to review"), top: num("default 25") },
		run: async (c, a) => {
			const me = a.mine || a.reviewing ? await c.me() : undefined;
			const path = a.repository ? `git/repositories/${enc(a.repository)}/pullrequests` : "git/pullrequests";
			const r = await c.req("GET", c.url(path, { project: c.p, query: { "searchCriteria.status": a.status ?? "active", "searchCriteria.creatorId": a.mine ? me!.id : undefined, "searchCriteria.reviewerId": a.reviewing ? me!.id : undefined, $top: a.top ?? 25 } }));
			return r.value.map((pr: any) => prSummary(pr, c));
		},
	},
	{
		name: "get_pull_request",
		description: "One pull request: description, branches, reviewers and votes, linked work items, merge status.",
		effect: "read",
		project: true,
		params: { id: num("pull request id") },
		required: ["id"],
		run: async (c, a) => {
			const pr = await c.req("GET", c.url(`git/pullrequests/${enc(a.id)}`, { project: c.p }));
			const items = await c.req("GET", c.url(`git/repositories/${enc(pr.repository.id)}/pullRequests/${enc(a.id)}/workitems`, { project: c.p })).catch(() => ({ value: [] }));
			return { ...prSummary(pr, c), description: pr.description, mergeStatus: pr.mergeStatus, workItems: (items.value ?? []).map((w: any) => Number(w.id)) };
		},
	},
	{
		name: "list_pull_request_comments",
		description: "Discussion threads on a pull request (people's comments, not system messages), with file and line when on code.",
		effect: "read",
		project: true,
		params: { repository: str("repository name or id"), id: num("pull request id") },
		required: ["repository", "id"],
		run: async (c, a) => {
			const r = await c.req("GET", c.url(`git/repositories/${enc(a.repository)}/pullRequests/${enc(a.id)}/threads`, { project: c.p }));
			return r.value
				.filter((t: any) => !t.isDeleted && (t.comments ?? []).some((x: any) => x.commentType !== "system"))
				.map((t: any) => ({ thread: t.id, status: t.status, file: t.threadContext?.filePath, line: t.threadContext?.rightFileStart?.line, comments: t.comments.filter((x: any) => x.commentType !== "system" && !x.isDeleted).map((x: any) => ({ by: who(x.author), at: x.publishedDate, text: x.content })) }));
		},
	},
	{
		name: "create_pull_request",
		description: "Open a pull request from one branch into another.",
		effect: "write",
		project: true,
		params: { repository: str("repository name or id"), source: str("source branch"), target: str("target branch (default: the repository's default branch)"), title: str("title"), description: str("markdown"), draft: bool("open as a draft"), workItems: { type: "array", items: { type: "number" }, description: "work item ids to link" } },
		required: ["repository", "source", "title"],
		run: async (c, a) => {
			let target = a.target;
			if (!target) target = short((await c.req("GET", c.url(`git/repositories/${enc(a.repository)}`, { project: c.p }))).defaultBranch);
			const pr = await c.req("POST", c.url(`git/repositories/${enc(a.repository)}/pullrequests`, { project: c.p }), {
				body: { sourceRefName: branch(a.source), targetRefName: branch(target), title: a.title, description: a.description, isDraft: !!a.draft, workItemRefs: (a.workItems ?? []).map((id: number) => ({ id: String(id) })) },
			});
			return prSummary(pr, c);
		},
		simulate: (a, id) => ({ id: `pending:${id}`, title: a.title, status: "active", source: a.source, target: a.target, repository: a.repository, simulated: true }),
	},
	{
		name: "comment_on_pull_request",
		description: "Comment on a pull request: generally, or on a line of a file.",
		effect: "write",
		project: true,
		params: { repository: str("repository name or id"), id: num("pull request id"), text: str("markdown"), file: str("file path, to comment on code"), line: num("line in the new version of the file") },
		required: ["repository", "id", "text"],
		run: async (c, a) => {
			const ctxFile = a.file ? { threadContext: { filePath: a.file.startsWith("/") ? a.file : `/${a.file}`, ...(a.line ? { rightFileStart: { line: a.line, offset: 1 }, rightFileEnd: { line: a.line, offset: 1 } } : {}) } } : {};
			const t = await c.req("POST", c.url(`git/repositories/${enc(a.repository)}/pullRequests/${enc(a.id)}/threads`, { project: c.p }), { body: { comments: [{ parentCommentId: 0, content: a.text, commentType: 1 }], status: 1, ...ctxFile } });
			return { thread: t.id, pullRequest: a.id };
		},
		simulate: (a, id) => ({ thread: `pending:${id}`, pullRequest: a.id, simulated: true }),
	},
	{
		name: "vote_on_pull_request",
		description: "Vote on a pull request as this connection's account: approve, approve-with-suggestions, wait, reject, or reset.",
		effect: "write",
		alwaysAsk: true,
		project: true,
		params: { repository: str("repository name or id"), id: num("pull request id"), vote: str("the vote", { enum: Object.keys(VOTE) }) },
		required: ["repository", "id", "vote"],
		run: async (c, a) => {
			if (!(a.vote in VOTE)) throw new Error(`vote: one of ${Object.keys(VOTE).join(", ")}`);
			const me = await c.me();
			await c.req("PUT", c.url(`git/repositories/${enc(a.repository)}/pullRequests/${enc(a.id)}/reviewers/${enc(me.id)}`, { project: c.p }), { body: { vote: VOTE[a.vote] } });
			return { pullRequest: a.id, vote: a.vote, by: me.name };
		},
	},
	{
		name: "complete_pull_request",
		description: "Complete (merge) a pull request.",
		effect: "write",
		alwaysAsk: true,
		project: true,
		params: { repository: str("repository name or id"), id: num("pull request id"), mergeStrategy: str("default squash", { enum: ["squash", "noFastForward", "rebase", "rebaseMerge"] }), deleteSourceBranch: bool("delete the source branch after merging") },
		required: ["repository", "id"],
		run: async (c, a) => {
			const pr = await c.req("GET", c.url(`git/repositories/${enc(a.repository)}/pullrequests/${enc(a.id)}`, { project: c.p }));
			const done = await c.req("PATCH", c.url(`git/repositories/${enc(a.repository)}/pullrequests/${enc(a.id)}`, { project: c.p }), {
				body: { status: "completed", lastMergeSourceCommit: pr.lastMergeSourceCommit, completionOptions: { mergeStrategy: a.mergeStrategy ?? "squash", deleteSourceBranch: !!a.deleteSourceBranch } },
			});
			return prSummary(done, c);
		},
	},
	// ------------------------------------------------------------ pipelines
	{
		name: "list_pipelines",
		description: "Pipelines in the project.",
		effect: "read",
		project: true,
		params: {},
		run: async (c) => (await c.req("GET", c.url("pipelines", { project: c.p }))).value.map((p: any) => ({ id: p.id, name: p.name, folder: p.folder })),
	},
	{
		name: "list_pipeline_runs",
		description: "A pipeline's recent runs.",
		effect: "read",
		project: true,
		params: { pipelineId: num("pipeline id"), top: num("default 10") },
		required: ["pipelineId"],
		run: async (c, a) =>
			(await c.req("GET", c.url(`pipelines/${enc(a.pipelineId)}/runs`, { project: c.p }))).value.slice(0, a.top ?? 10).map((r: any) => ({ id: r.id, name: r.name, state: r.state, result: r.result, branch: short(r.resources?.repositories?.self?.refName), created: r.createdDate, finished: r.finishedDate, url: r._links?.web?.href })),
	},
	{
		name: "run_pipeline",
		description: "Start a pipeline run.",
		effect: "write",
		project: true,
		params: { pipelineId: num("pipeline id"), branch: str("branch to run (default: the pipeline's default)"), parameters: { type: "object", description: "template parameters" }, variables: { type: "object", description: "variables, name → value" } },
		required: ["pipelineId"],
		run: async (c, a) => {
			const r = await c.req("POST", c.url(`pipelines/${enc(a.pipelineId)}/runs`, { project: c.p }), {
				body: {
					...(a.branch ? { resources: { repositories: { self: { refName: branch(a.branch) } } } } : {}),
					...(a.parameters ? { templateParameters: a.parameters } : {}),
					...(a.variables ? { variables: Object.fromEntries(Object.entries(a.variables).map(([k, v]) => [k, { value: String(v) }])) } : {}),
				},
			});
			return { id: r.id, name: r.name, state: r.state, url: r._links?.web?.href };
		},
		simulate: (a, id) => ({ id: `pending:${id}`, pipelineId: a.pipelineId, state: "queued (pending approval)", simulated: true }),
	},
	{
		name: "list_builds",
		description: "Recent builds, optionally of one pipeline, branch or result.",
		effect: "read",
		project: true,
		params: { pipelineId: num("pipeline (build definition) id"), branch: str("branch"), result: str("only this result", { enum: ["succeeded", "partiallySucceeded", "failed", "canceled"] }), top: num("default 20") },
		run: async (c, a) =>
			(await c.req("GET", c.url("build/builds", { project: c.p, query: { definitions: a.pipelineId, branchName: branch(a.branch), resultFilter: a.result, $top: a.top ?? 20, queryOrder: "queueTimeDescending" } }))).value.map((b: any) => buildSummary(b, c)),
	},
	{
		name: "get_build_failures",
		description: "Why a build failed: its failed steps with their error messages and log ids (read a log with get_build_log).",
		effect: "read",
		project: true,
		params: { buildId: num("build id") },
		required: ["buildId"],
		run: async (c, a) => {
			const [b, t] = await Promise.all([c.req("GET", c.url(`build/builds/${enc(a.buildId)}`, { project: c.p })), c.req("GET", c.url(`build/builds/${enc(a.buildId)}/timeline`, { project: c.p }))]);
			const failed = (t.records ?? []).filter((r: any) => r.result === "failed" || r.result === "canceled" || (r.issues ?? []).some((i: any) => i.type === "error"));
			return { ...buildSummary(b, c), failures: failed.map((r: any) => ({ step: r.name, type: r.type, result: r.result, logId: r.log?.id, errors: (r.issues ?? []).filter((i: any) => i.type === "error").map((i: any) => i.message).slice(0, 10) })) };
		},
	},
	{
		name: "get_build_log",
		description: "The end of one build log (default the last 200 lines).",
		effect: "read",
		project: true,
		params: { buildId: num("build id"), logId: num("log id (from get_build_failures)"), tail: num("lines from the end, default 200") },
		required: ["buildId", "logId"],
		run: async (c, a) => {
			const text: string = await c.req("GET", c.url(`build/builds/${enc(a.buildId)}/logs/${enc(a.logId)}`, { project: c.p }), { text: true });
			const lines = text.split(/\r?\n/);
			return { lines: lines.length, log: truncateText(lines.slice(-(a.tail ?? 200)).join("\n")) };
		},
	},
	// ------------------------------------------------------------ wiki
	{
		name: "list_wikis",
		description: "Wikis in the project.",
		effect: "read",
		project: true,
		params: {},
		run: async (c) => (await c.req("GET", c.url("wiki/wikis", { project: c.p }))).value.map((w: any) => ({ id: w.id, name: w.name, type: w.type })),
	},
	{
		name: "get_wiki_page",
		description: "A wiki page's markdown, and its sub-pages.",
		effect: "read",
		project: true,
		params: { wiki: str("wiki name or id"), path: str("page path, e.g. /Home or /Guides/Setup") },
		required: ["wiki", "path"],
		run: async (c, a) => {
			const r = await c.req("GET", c.url(`wiki/wikis/${enc(a.wiki)}/pages`, { project: c.p, query: { path: a.path, includeContent: true, recursionLevel: "oneLevel" } }));
			return { path: r.path, content: truncateText(String(r.content ?? "")), subPages: (r.subPages ?? []).map((p: any) => p.path) };
		},
	},
];

const BY_NAME = new Map(DEFS.map((d) => [d.name, d]));

/** The methods this connection offers: the project parameter only when the connection doesn't fix one. */
export function azdoMethods(conn: Connection): ConnMethod[] {
	const pinned = !!conn.params?.project;
	const reads = new Set(conn.reads ?? []);
	return DEFS.map((d) => {
		const properties: Record<string, any> = { ...(d.project && !pinned ? { project: str("project name") } : {}), ...d.params };
		const required = [...(d.project && !pinned ? ["project"] : []), ...(d.required ?? [])];
		const owner = d.effect === "write" && reads.has(d.name);
		return {
			name: d.name,
			description: d.description,
			inputSchema: { type: "object", properties, ...(required.length ? { required } : {}) },
			effect: owner ? "read" : d.effect,
			classifiedBy: owner ? "owner" : "connector",
			...(d.alwaysAsk && !owner ? { alwaysAsk: true } : {}),
		} satisfies ConnMethod;
	});
}

export function azdoSimulate(name: string, args: any, id: string): unknown {
	return BY_NAME.get(name)?.simulate?.(args, id);
}

/** Calls as the connection's account. Errors come back readable, with the token redacted. */
function context(conn: Connection, secrets: ConnectionSecrets): Ctx {
	const org = conn.params?.organization;
	if (!org) throw new Error("This Azure DevOps connection has no organization");
	const auth = applyAuth(conn.auth, secrets);
	const allowPrivate = conn.source === "config";
	let me: Promise<{ id: string; name: string }> | undefined;
	const ctx: Ctx = {
		org,
		project: conn.params?.project,
		url(path, opts = {}) {
			const u = new URL(`${host()}/${enc(org)}${opts.project ? `/${enc(opts.project)}` : ""}/_apis/${path}`);
			u.searchParams.set("api-version", API);
			for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined && v !== "") u.searchParams.set(k, String(v));
			return u.href;
		},
		async req(method, url, opts = {}) {
			const headers: Record<string, string> = { accept: opts.text ? "text/plain" : "application/json", ...auth.headers };
			if (opts.body !== undefined) headers["content-type"] = opts.contentType ?? "application/json";
			let res: Awaited<ReturnType<typeof guardedFetch>>;
			try {
				res = await guardedFetch(url, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body), allowPrivate, maxBytes: 8 << 20 });
			} catch (error) {
				const msg = String((error as Error).message ?? error);
				// A bad or expired token gets a redirect to Microsoft's sign-in page.
				if (/redirect to another host/i.test(msg)) throw new Error("Azure DevOps rejected the credentials (redirected to sign-in): the personal access token is wrong, expired, or lacks the scope for this.");
				throw new Error(redact(msg, secrets));
			}
			if (res.status === 203 || res.status === 401 || (/text\/html/i.test(res.contentType ?? "") && !opts.text)) throw new Error(`Azure DevOps rejected the credentials (HTTP ${res.status}): the personal access token is wrong, expired, or lacks the scope for this.`);
			if (res.status >= 400) {
				let message = res.text.slice(0, 500);
				try {
					message = JSON.parse(res.text).message ?? message;
				} catch {}
				throw new Error(redact(`Azure DevOps ${res.status}: ${message}`, secrets));
			}
			if (opts.text) return res.text;
			if (!res.text) return {};
			return JSON.parse(res.text);
		},
		me() {
			me ??= ctx.req("GET", `${host()}/${enc(org)}/_apis/connectionData`).then((d: any) => {
				const u = d.authenticatedUser;
				if (!u?.id || /anonymous/i.test(u.descriptor ?? "")) throw new Error("Azure DevOps didn't recognise the credentials");
				return { id: u.id, name: u.providerDisplayName ?? u.customDisplayName ?? u.id };
			});
			return me;
		},
		web: (path) => `${host()}/${enc(org)}/${path}`,
	};
	return ctx;
}

/** Check the organization and the token: who the connection acts as. */
export async function azdoCheck(conn: Connection, secrets: ConnectionSecrets) {
	return context(conn, secrets).me();
}

export async function azdoCall(conn: Connection, secrets: ConnectionSecrets, name: string, args: any): Promise<unknown> {
	const d = BY_NAME.get(name);
	if (!d) throw new Error(`Azure DevOps has no method ${name}`);
	const ctx = context(conn, secrets);
	const project = conn.params?.project ?? args?.project;
	if (d.project && !project) throw new Error("Which project? Pass project (list_projects shows them).");
	for (const k of d.required ?? []) if (args?.[k] === undefined || args[k] === null || args[k] === "") throw new Error(`Missing ${k}`);
	return d.run({ ...ctx, p: project }, args ?? {});
}

/** Does an organization exist? (A proposal check: dev.azure.com answers 404 for unknown ones.) */
export async function azdoOrgExists(org: string): Promise<boolean> {
	const res = await guardedFetch(`${host()}/${enc(org)}/_apis/connectionData`, { method: "GET", timeoutMs: 15_000, maxBytes: 64 << 10 }).catch((e) => {
		// Unauthenticated requests to a real organization redirect to sign-in.
		if (/redirect to another host/i.test(String(e?.message))) return { status: 302 };
		throw e;
	});
	return res.status !== 404;
}
