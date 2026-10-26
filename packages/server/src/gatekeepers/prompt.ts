import { Type } from "@earendil-works/pi-ai";
import type { Grant, Holder } from "../kernel/docs.ts";
import type { Gatekeeper } from "./catalog.ts";

/**
 * What agents are told about their Gatekeeper access, shared by chats and project agents: the
 * resources a holder can use (methods, how each runs), and how to look methods up.
 */
type WorkspaceLike = {
	gatekeeperFor(grant: { gatekeeper: string; connection?: string }): Promise<Gatekeeper | undefined>;
	connections: { list(): Promise<{ id: string; label: string; title: string; kind: string; methods: unknown[] }[]> };
};

export const MAX_LISTED_METHODS = 40;

/** Does a grant held by `grantHolder` apply to `caller`? Project grants may be limited to some roles. */
export function holds(grantHolder: Holder, caller: Holder): boolean {
	if (grantHolder.kind !== caller.kind || grantHolder.id !== caller.id) return false;
	if (grantHolder.kind !== "project" || !grantHolder.roles?.length) return true;
	return !!caller.roles?.some((r) => grantHolder.roles!.includes(r));
}

/** How a call to `method` on this grant runs: read, needs approval, auto-approved, or not allowed. */
export function howItRuns(g: { autoApprove: boolean; policy?: Record<string, string> }, gk: Gatekeeper, method: string): string {
	const m = gk.methods[method];
	if (!m || m.effect === "read") return "read";
	const policy = g.policy?.[method] ?? (g.autoApprove ? "auto" : "ask");
	if (policy === "deny") return "write, not allowed";
	if (policy === "auto" && !m.alwaysAsk && gk.trust !== "byo") return "write, auto-approved";
	return "write, needs approval";
}

/** The <resources> prompt section for a holder's grants, plus the connections it could ask for. */
export async function resourcesSection(ws: WorkspaceLike, mine: Grant[]): Promise<string> {
	const conns = await ws.connections.list();
	const ungranted = conns.filter((c) => !mine.some((g) => g.connection === c.id));
	const available = ungranted.length
		? `\n\nWorkspace connections you can ask for (request_access with the label): ${ungranted.map((c) => `"${c.label}" (${c.title}, ${c.kind === "mcp" ? "MCP server" : "REST API"}, ${c.methods.length} methods)`).join("; ")}.`
		: "";
	if (!mine.length) return `No resources introduced yet. Use request_access if you need one.${available}`;
	const lines = await Promise.all(
		mine.map(async (g) => {
			const gk = await ws.gatekeeperFor(g);
			if (!gk) return `- grant "${g.id}" (label "${g.label}"): its connection was removed`;
			const entries = Object.entries(gk.methods).filter(([name]) => !g.methods || g.methods.includes(name));
			const shown = entries.slice(0, MAX_LISTED_METHODS);
			const methods = shown
				.map(([name, m]) => `  - ${name}(${Object.entries(m.params).map(([k, v]) => `${k}: ${v.slice(0, 140)}`).join(", ")}) [${howItRuns(g, gk, name)}] — ${m.description.replace(/\s+/g, " ").slice(0, 300)}`)
				.join("\n");
			const more = entries.length > shown.length ? `\n  … ${entries.length - shown.length} more: use gatekeeper_tools to search them.` : "";
			return `- grant "${g.id}" (label "${g.label}"): ${gk.title} → ${g.resource}\n${methods}${more}`;
		}),
	);
	return lines.join("\n") + available;
}

/** gatekeeper_tools: a granted resource's methods with full argument schemas, by name or search words. */
export function findMethods(grant: Grant, gk: Gatekeeper, opts: { search?: string; method?: string }) {
	const words = (opts.search ?? "").toLowerCase().split(/\s+/).filter(Boolean);
	return Object.entries(gk.methods)
		.filter(([name]) => !grant.methods || grant.methods.includes(name))
		.filter(([name]) => !opts.method || name === opts.method)
		.filter(([name, m]) => words.every((w) => `${name} ${m.description}`.toLowerCase().includes(w)))
		.slice(0, 20)
		.map(([name, m]) => ({ name, effect: m.effect, runs: howItRuns(grant, gk, name), description: m.description, arguments: m.inputSchema ?? m.params }));
}

/** propose_connection: shared by chats and project agents. The agent drafts; an owner adds the secret and connects. */
export const PROPOSE_CONNECTION = {
	description:
		"Propose a new workspace connection to a third-party service (an MCP server, or a REST API with an OpenAPI document) for a workspace owner to review and connect. You never handle credentials: name the auth scheme only, and say in `setup` how the owner gets the key. Never ask the user to paste keys or tokens into the chat, and never put one in a URL. Find the real endpoint first (documentation, the vendor's MCP page). Returns immediately; you're told when an owner connects or declines it, then ask for access with request_access.",
	parameters: Type.Object({
		kind: Type.Union([Type.Literal("mcp"), Type.Literal("openapi")]),
		label: Type.String({ description: "short name agents and gadgets will use, e.g. linear (a letter, then letters, digits, - or _)" }),
		title: Type.Optional(Type.String({ description: "display name, e.g. Linear" })),
		url: Type.Optional(Type.String({ description: "mcp: the server's endpoint URL" })),
		transport: Type.Optional(Type.Union([Type.Literal("http"), Type.Literal("sse")], { description: "mcp: omit to try streamable HTTP, then SSE" })),
		spec: Type.Optional(Type.String({ description: "openapi: URL of the OpenAPI/Swagger document" })),
		baseUrl: Type.Optional(Type.String({ description: "openapi: the API's base URL, if the document doesn't name it" })),
		auth: Type.Object(
			{
				kind: Type.Union([Type.Literal("none"), Type.Literal("bearer"), Type.Literal("header"), Type.Literal("basic"), Type.Literal("query")]),
				name: Type.Optional(Type.String({ description: "header or query parameter name, for kind header/query (e.g. x-api-key)" })),
			},
			{ description: "how the service authenticates: bearer token, an API key in a header or the URL, username+password, or none" },
		),
		reason: Type.String({ description: "what it's for, for the owner reviewing it" }),
		setup: Type.Optional(Type.String({ description: "how the owner gets the credential, e.g. 'Linear → Settings → API → Personal API keys'" })),
	}),
};
