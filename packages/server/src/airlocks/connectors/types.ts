import { join } from "node:path";
import { config } from "../../config.ts";
import { EncryptedFileStore } from "../../kernel/credentials.ts";

/**
 * Generic connectors turn a third-party service into a Airlock without service-specific code:
 *  - `mcp`: any Model Context Protocol server (streamable HTTP, SSE, or a local command). Its tools
 *    become methods.
 *  - `openapi`: any HTTP API described by an OpenAPI 3 / Swagger 2 document. Its operations become
 *    methods.
 * A **connection** is one configured service: the workspace's service account on it. Workspace
 * owners add connections in the UI ("byo": untrusted, public hosts only, writes never auto-approved);
 * admins declare them in outpost.config.json ("vetted": may reach private hosts, run local commands,
 * and have writes auto-approved).
 */
export type ConnectorKind = "mcp" | "openapi" | "azure-devops";

export type ConnectionAuth =
	| { kind: "none" }
	/** secret `token` → `Authorization: Bearer <token>` */
	| { kind: "bearer" }
	/** secret `value` → `<name>: <value>` */
	| { kind: "header"; name: string }
	/** secrets `username`, `password` → `Authorization: Basic …` */
	| { kind: "basic" }
	/** secret `value` → `?<name>=<value>` */
	| { kind: "query"; name: string };

/** Secret values for one connection. `env.<NAME>` entries are environment variables for a local MCP command. */
export type ConnectionSecrets = Record<string, string>;

export type HttpOperation = {
	method: string;
	path: string;
	params: { name: string; in: "path" | "query" | "header"; required?: boolean }[];
	/** The request body goes in the `body` argument. */
	body?: boolean;
};

/** One callable method of a connection, discovered from the service. */
export type ConnMethod = {
	name: string;
	description: string;
	/** JSON Schema of the arguments object. */
	inputSchema: Record<string, any>;
	effect: "read" | "write";
	/** Never auto-approved, whatever the capability's policy says. */
	alwaysAsk?: boolean;
	/** Who decided it's a read or a write: the server's annotation, the HTTP verb, the owner, or the default (write). */
	classifiedBy: "server" | "spec" | "owner" | "default" | "connector";
	http?: HttpOperation;
};

export type Connection = {
	id: string;
	kind: ConnectorKind;
	/** What agents and modules call it, e.g. "linear". Unique in the workspace. */
	label: string;
	title: string;
	icon: string;
	source: "workspace" | "config";
	trust: "vetted" | "byo";
	/** mcp over http/sse: the endpoint. */
	url?: string;
	transport?: "http" | "sse" | "stdio";
	/** mcp over stdio (config only). */
	command?: string;
	args?: string[];
	/** openapi: where the document is (a URL), or "inline" when it was pasted. */
	spec?: string;
	/** openapi: override the document's server URL. */
	baseUrl?: string;
	/** openapi: the base URL in use (the override, or the document's server), set on discovery. */
	apiBase?: string;
	/** openapi: parameter values outpost always sends (e.g. organization=rosen-nxt); hidden from agents, who can't change them. azure-devops: organization, and optionally project. */
	params?: Record<string, string>;
	/** Who the service says the connection acts as (azure-devops), set on discovery. */
	account?: string;
	auth: ConnectionAuth;
	/** Methods the owner marks as reads (no approval), overriding the server or the verb. */
	reads?: string[];
	methods: ConnMethod[];
	status: "ok" | "error" | "pending";
	error?: string;
	refreshedAt?: number;
	createdBy: string;
	createdAt: number;
};

export const CONNECTOR_INFO: Record<ConnectorKind, { title: string; icon: string; description: string }> = {
	mcp: { title: "MCP server", icon: "🔌", description: "Any Model Context Protocol server. Its tools become methods; tools the server marks read-only run, the rest queue for approval." },
	openapi: { title: "REST API (OpenAPI)", icon: "🧾", description: "Any HTTP API with an OpenAPI 3 or Swagger 2 document. GET operations run; everything else queues for approval." },
	"azure-devops": { title: "Azure DevOps", icon: "🔷", description: "Boards, repos, pull requests, pipelines and wiki of one organization (optionally one project), with a personal access token." },
};

/** Which secrets an auth kind must have (basic: the username may be empty, e.g. Azure DevOps personal access tokens). */
export function requiredSecretNames(auth: ConnectionAuth): string[] {
	return auth.kind === "basic" ? ["password"] : secretNames(auth);
}

/** Which secret names an auth kind uses. */
export function secretNames(auth: ConnectionAuth): string[] {
	switch (auth.kind) {
		case "bearer":
			return ["token"];
		case "header":
		case "query":
			return ["value"];
		case "basic":
			return ["username", "password"];
		default:
			return [];
	}
}

/** Headers and query parameters that authenticate a request. */
export function applyAuth(auth: ConnectionAuth, secrets: ConnectionSecrets): { headers: Record<string, string>; query: Record<string, string> } {
	const need = (k: string) => {
		const v = secrets[k];
		if (!v) throw new Error(`This connection has no ${k} set. A workspace owner can set it under Connections.`);
		return v;
	};
	switch (auth.kind) {
		case "bearer":
			return { headers: { authorization: `Bearer ${need("token")}` }, query: {} };
		case "header":
			return { headers: { [auth.name]: need("value") }, query: {} };
		case "basic":
			return { headers: { authorization: `Basic ${Buffer.from(`${secrets.username ?? ""}:${need("password")}`).toString("base64")}` }, query: {} };
		case "query":
			return { headers: {}, query: { [auth.name]: need("value") } };
		default:
			return { headers: {}, query: {} };
	}
}

/** Remove secret values from text that may reach an agent (errors echo URLs and headers). */
export function redact(text: string, secrets: ConnectionSecrets): string {
	let out = text;
	for (const v of Object.values(secrets)) if (v && v.length >= 4) out = out.split(v).join("•••");
	return out;
}

/** Connection secrets, AES-256-GCM encrypted with the instance secret, keyed `<workspace>/<connection>`. */
class SecretStore {
	readonly #file = new EncryptedFileStore<ConnectionSecrets>(join(config.dataDir, "connections.enc.json"), config.secret);
	#chain: Promise<unknown> = Promise.resolve();
	get(wsId: string, connId: string): ConnectionSecrets {
		return this.#file.load()[`${wsId}/${connId}`] ?? {};
	}
	/** Merge: a value of "" deletes that secret; absent keys stay. */
	update(wsId: string, connId: string, patch: ConnectionSecrets | null) {
		const run = () => {
			const all = this.#file.load();
			const key = `${wsId}/${connId}`;
			if (patch === null) delete all[key];
			else {
				const next = { ...all[key] };
				for (const [k, v] of Object.entries(patch)) if (v === "") delete next[k];
				else next[k] = v;
				all[key] = next;
			}
			this.#file.save(all);
		};
		const p = this.#chain.then(run, run);
		this.#chain = p.catch(() => {});
		return p;
	}
}
export const connectionSecrets = new SecretStore();

/** JSON Schema property list → `name: type` hints for prompts. */
export function paramHints(schema: Record<string, any>): Record<string, string> {
	const props = (schema.properties ?? {}) as Record<string, any>;
	const required = new Set((schema.required as string[] | undefined) ?? []);
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(props)) {
		const type = Array.isArray(v?.enum) ? v.enum.map((e: unknown) => JSON.stringify(e)).join("|") : (v?.type ?? (v?.properties ? "object" : "any"));
		const desc = typeof v?.description === "string" ? ` — ${v.description.replace(/\s+/g, " ").slice(0, 120)}` : "";
		out[k] = `${Array.isArray(type) ? type.join("|") : type}${required.has(k) ? "" : "?"}${desc}`;
	}
	return out;
}

/** Keep stored schemas bounded: a method whose schema is huge keeps only its property names and types. */
export function boundSchema(schema: unknown, max = 12_000): Record<string, any> {
	const s = (schema && typeof schema === "object" ? schema : { type: "object" }) as Record<string, any>;
	let json: string;
	try {
		json = JSON.stringify(s);
	} catch {
		return { type: "object", description: "(schema has cycles; see the service's documentation)" };
	}
	if (json.length <= max) return JSON.parse(json);
	const props: Record<string, unknown> = {};
	for (const [k, v] of Object.entries((s.properties ?? {}) as Record<string, any>)) props[k] = { type: v?.type ?? "object", ...(typeof v?.description === "string" ? { description: v.description.slice(0, 200) } : {}) };
	return { type: "object", properties: props, ...(Array.isArray(s.required) ? { required: s.required } : {}), description: "(schema abridged: too large)" };
}

export const truncateText = (s: string, n = 60_000) => (s.length > n ? `${s.slice(0, n)}\n…[truncated ${s.length - n} chars]` : s);

/**
 * A connection an agent drafted for an owner to add: everything but the secret. Agents never create
 * connections; an owner reviews the proposal, types the key, and connects it.
 */
export type ConnectionProposal = {
	id: string;
	kind: ConnectorKind;
	label: string;
	title?: string;
	url?: string;
	transport?: "http" | "sse";
	spec?: string;
	baseUrl?: string;
	params?: Record<string, string>;
	auth: ConnectionAuth;
	/** Why the agent wants it. */
	reason: string;
	/** How the owner gets the credential (e.g. "Settings → API → New key"). */
	setup?: string;
	proposedBy: { kind: "conversation"; id: string; name: string };
	status: "pending" | "accepted" | "declined";
	/** The connection created from it. */
	connection?: string;
	decidedBy?: string;
	decidedAt?: number;
	createdAt: number;
};
