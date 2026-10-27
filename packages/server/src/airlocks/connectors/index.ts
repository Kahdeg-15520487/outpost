import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import type { Harness } from "@earendil-works/pi-durable";
import { config, resolveSecret, type ConnectorConfig } from "../../config.ts";
import { ConnectionsDoc } from "../../kernel/docs.ts";
import { HttpError, newId } from "../../kernel/system-db.ts";
import { AIRLOCKS, type Airlock, type AirlockMethod } from "../catalog.ts";
import { assertPublicUrl, guardedFetch } from "../net.ts";
import { McpPool } from "./mcp.ts";
import { baseUrlOf, invoke, loadSpecText, operationsOf, parseSpec } from "./openapi.ts";
import { azdoCall, azdoCheck, azdoMethods, azdoOrgExists, azdoSimulate } from "./azure-devops.ts";
import { githubCall, githubCheck, githubMethods, githubRepository } from "./github.ts";
import { CONNECTOR_INFO, type Connection, type ConnectionAuth, type ConnectionProposal, type ConnectionSecrets, type ConnMethod, connectionSecrets, paramHints, redact, requiredSecretNames, secretNames } from "./types.ts";

export * from "./types.ts";

/** MCP sessions for every workspace; keys are `<workspace>/<connection>` or `cfg/<id>` for admin-declared ones. */
const pool = new McpPool();

// ------------------------------------------------------------------ admin-declared (vetted) connections

type ConfigEntry = { conn: Connection; secrets: ConnectionSecrets; workspaces?: string[]; discovering?: Promise<void> };
const fromConfig = new Map<string, ConfigEntry>();
for (const c of config.file.connectors ?? []) {
	if (!c?.id || !CONNECTOR_INFO[c.kind]) {
		console.warn(`outpost: connectors entry needs an id and kind "mcp" or "openapi": ${JSON.stringify(c).slice(0, 120)}`);
		continue;
	}
	const { auth, secrets } = configAuth(c);
	for (const [k, v] of Object.entries(c.env ?? {})) {
		const value = resolveSecret(v).value;
		if (value !== undefined) secrets[`env.${k}`] = value;
	}
	const info = CONNECTOR_INFO[c.kind];
	fromConfig.set(`cfg.${c.id}`, {
		conn: plain({
			id: `cfg.${c.id}`,
			kind: c.kind,
			label: c.label ?? c.id,
			title: c.title ?? c.id,
			icon: c.icon ?? info.icon,
			source: "config",
			trust: "vetted",
			url: c.url,
			transport: c.transport ?? (c.command ? "stdio" : undefined),
			command: c.command,
			args: c.args,
			spec: c.spec,
			baseUrl: c.baseUrl,
			params: c.params,
			auth,
			reads: c.reads,
			methods: [],
			status: "pending",
			createdBy: "outpost.config.json",
			createdAt: 0,
		}),
		secrets,
		workspaces: c.workspaces,
	});
}

function configAuth(c: ConnectorConfig): { auth: ConnectionAuth; secrets: ConnectionSecrets } {
	const a = c.auth ?? { kind: "none" };
	const v = (x: string | undefined) => resolveSecret(x).value ?? "";
	switch (a.kind) {
		case "bearer":
			return { auth: { kind: "bearer" }, secrets: { token: v(a.token) } };
		case "header":
			return { auth: { kind: "header", name: a.name }, secrets: { value: v(a.value) } };
		case "query":
			return { auth: { kind: "query", name: a.name }, secrets: { value: v(a.value) } };
		case "basic":
			return { auth: { kind: "basic" }, secrets: { username: v(a.username), password: v(a.password) } };
		default:
			return { auth: { kind: "none" }, secrets: {} };
	}
}

/** Docs reject `undefined`; JSON round-trip drops it (and any proxies). */
function plain<T>(v: T): T {
	return JSON.parse(JSON.stringify(v));
}

const LABEL = /^[A-Za-z][A-Za-z0-9_-]{0,39}$/;

export type ConnectionInput = {
	kind?: Connection["kind"];
	label?: string;
	title?: string;
	icon?: string;
	url?: string;
	transport?: "http" | "sse";
	/** openapi: URL of the document… */
	spec?: string;
	/** …or the document itself, pasted. */
	specText?: string;
	baseUrl?: string;
	/** openapi: fixed parameter values (name → value). */
	params?: Record<string, string>;
	auth?: ConnectionAuth;
	/** Values per secret name; "" deletes one. Never returned by the API. */
	secrets?: ConnectionSecrets;
	reads?: string[];
};

/**
 * One workspace's connections: the ones its owners added (ConnectionsDoc) plus the admin's from
 * outpost.config.json. Discovery (tools / operations) is cached on the connection; calls go through
 * the MCP pool or the OpenAPI invoker.
 */
export class Connections {
	constructor(
		readonly wsId: string,
		readonly harness: Harness,
		readonly onChange: () => void = () => {},
	) {}

	#specFile(id: string) {
		return join(config.dataDir, "connectors", this.wsId, `${id}.spec`);
	}
	#key(conn: Connection) {
		return conn.source === "config" ? `cfg/${conn.id}` : `${this.wsId}/${conn.id}`;
	}
	#secrets(conn: Connection): ConnectionSecrets {
		return conn.source === "config" ? (fromConfig.get(conn.id)?.secrets ?? {}) : connectionSecrets.get(this.wsId, conn.id);
	}

	#configEntries() {
		return [...fromConfig.values()].filter((e) => !e.workspaces || e.workspaces.includes(this.wsId));
	}

	/** Admin connections discover on first use (once per process), not at startup. */
	#discoverConfig(e: ConfigEntry): Promise<void> {
		e.discovering ??= this.#discover(e.conn)
			.then((patch) => void Object.assign(e.conn, patch))
			.finally(() => this.onChange());
		return e.discovering!;
	}

	async list(): Promise<Connection[]> {
		const doc = await this.harness.snapshot(ConnectionsDoc, ctx);
		for (const e of this.#configEntries()) if (!e.discovering) void this.#discoverConfig(e);
		return [...this.#configEntries().map((e) => e.conn), ...Object.values(doc?.connections ?? {}).map(plain)];
	}

	/** By id or label. */
	async get(ref: string): Promise<Connection | undefined> {
		const all = await this.list();
		const conn = all.find((c) => c.id === ref) ?? all.find((c) => c.label === ref);
		const cfg = conn && fromConfig.get(conn.id);
		if (cfg) await this.#discoverConfig(cfg).catch(() => {});
		return conn && plain(conn);
	}

	async require(ref: string): Promise<Connection> {
		const conn = await this.get(ref);
		if (!conn) throw new HttpError(404, `No connection "${ref}"`);
		return conn;
	}

	/** What the API shows: everything but secret values (it says which are set). */
	describe(conn: Connection) {
		const secrets = this.#secrets(conn);
		const names = [...secretNames(conn.auth), ...Object.keys(secrets).filter((k) => k.startsWith("env."))];
		return {
			...conn,
			secretsSet: names.filter((n) => !!secrets[n]),
			secretsNeeded: requiredSecretNames(conn.auth),
			methods: conn.methods.map((m) => ({ name: m.name, description: m.description, effect: m.effect, alwaysAsk: !!m.alwaysAsk, classifiedBy: m.classifiedBy, params: paramHints(m.inputSchema) })),
		};
	}

	async #checkLabel(label: string, exceptId?: string) {
		if (!LABEL.test(label)) throw new HttpError(400, "Label: a letter, then letters, digits, - or _ (at most 40)");
		if (AIRLOCKS[label]) throw new HttpError(400, `"${label}" is a built-in Airlock's name`);
		if ((await this.list()).some((c) => c.label === label && c.id !== exceptId)) throw new HttpError(409, `A connection is already called "${label}"`);
	}

	#validate(c: Connection) {
		if (c.kind === "mcp") {
			if (!c.url) throw new HttpError(400, "An MCP connection needs the server's URL");
			if (!/^https?:\/\//i.test(c.url)) throw new HttpError(400, "The MCP URL must be http(s). Local commands (stdio) can only be declared by an admin in outpost.config.json.");
		}
		if (c.kind === "openapi" && !c.spec) throw new HttpError(400, "A REST API connection needs its OpenAPI document: a URL or the document itself");
		if (c.kind === "azure-devops") {
			if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,49}$/.test(c.params?.organization ?? "")) throw new HttpError(400, "Azure DevOps needs the organization's name (dev.azure.com/<organization>)");
			if (c.auth.kind !== "basic" && c.auth.kind !== "bearer") throw new HttpError(400, "Azure DevOps authenticates with a personal access token");
		}
		if (c.kind === "github-repo") {
			try {
				githubRepository(c.params?.repository ?? "");
			} catch (e) {
				throw new HttpError(400, (e as Error).message);
			}
			if (c.auth.kind !== "bearer") throw new HttpError(400, "GitHub authenticates with a personal access token");
		}
		if (c.baseUrl && !/^https?:\/\//i.test(c.baseUrl)) throw new HttpError(400, "The base URL must be http(s)");
	}

	async create(input: ConnectionInput, by: string): Promise<Connection> {
		const kind = input.kind;
		if (!kind || !CONNECTOR_INFO[kind]) throw new HttpError(400, `kind must be one of ${Object.keys(CONNECTOR_INFO).join(", ")}`);
		const label = (input.label ?? "").trim();
		await this.#checkLabel(label);
		const id = newId("cn");
		const conn: Connection = plain({
			id,
			kind,
			label,
			title: input.title?.trim() || label,
			icon: input.icon || CONNECTOR_INFO[kind].icon,
			source: "workspace" as const,
			trust: "byo" as const,
			url: kind === "mcp" ? input.url?.trim() : undefined,
			transport: kind === "mcp" ? (input.transport === "sse" ? "sse" : input.transport === "http" ? "http" : undefined) : undefined,
			spec: kind === "openapi" ? (input.specText?.trim() ? "inline" : input.spec?.trim()) : undefined,
			baseUrl: input.baseUrl?.trim() || undefined,
			params: kind === "openapi" || kind === "azure-devops" || kind === "github-repo" ? canonicalParams(kind, normalizeParams(input.params)) : undefined,
			auth: kind === "azure-devops" ? { kind: "basic" as const } : kind === "github-repo" ? { kind: "bearer" as const } : normalizeAuth(input.auth),
			reads: input.reads?.length ? [...new Set(input.reads)] : undefined,
			methods: [],
			status: "pending" as const,
			createdBy: by,
			createdAt: Date.now(),
		});
		this.#validate(conn);
		if (conn.spec === "inline") {
			await parseSpec(input.specText!).catch((e) => {
				throw new HttpError(400, `The OpenAPI document doesn't parse: ${e.message}`);
			});
			mkdirSync(join(config.dataDir, "connectors", this.wsId), { recursive: true });
			writeFileSync(this.#specFile(id), input.specText!);
		}
		if (input.secrets) await connectionSecrets.update(this.wsId, id, onlyKnown(conn, input.secrets));
		await this.harness.commit(async (tx) => {
			(await tx.doc(ConnectionsDoc)).connections[id] = conn;
		}, ctx);
		return this.refresh(id);
	}

	async update(id: string, input: ConnectionInput): Promise<Connection> {
		const current = await this.require(id);
		if (current.source === "config") throw new HttpError(403, "This connection is declared in outpost.config.json");
		if (input.label !== undefined && input.label !== current.label) await this.#checkLabel(input.label.trim(), id);
		const next: Connection = plain({
			...current,
			...(input.label !== undefined ? { label: input.label.trim() } : {}),
			...(input.title !== undefined ? { title: input.title.trim() || current.label } : {}),
			...(input.icon ? { icon: input.icon } : {}),
			...(current.kind === "mcp" && input.url !== undefined ? { url: input.url.trim() } : {}),
			...(current.kind === "mcp" && input.transport !== undefined ? { transport: input.transport === "sse" || input.transport === "http" ? input.transport : undefined } : {}),
			...(current.kind === "openapi" && input.specText?.trim() ? { spec: "inline" } : current.kind === "openapi" && input.spec !== undefined ? { spec: input.spec.trim() } : {}),
			...(input.baseUrl !== undefined ? { baseUrl: input.baseUrl.trim() || undefined } : {}),
			...((current.kind === "openapi" || current.kind === "azure-devops" || current.kind === "github-repo") && input.params !== undefined ? { params: canonicalParams(current.kind, normalizeParams(input.params)) } : {}),
			...(input.auth && current.kind !== "azure-devops" && current.kind !== "github-repo" ? { auth: normalizeAuth(input.auth) } : {}),
			...(input.reads !== undefined ? { reads: input.reads.length ? [...new Set(input.reads)] : undefined } : {}),
		});
		this.#validate(next);
		if (input.specText?.trim()) {
			await parseSpec(input.specText).catch((e) => {
				throw new HttpError(400, `The OpenAPI document doesn't parse: ${e.message}`);
			});
			mkdirSync(join(config.dataDir, "connectors", this.wsId), { recursive: true });
			writeFileSync(this.#specFile(id), input.specText);
		}
		if (input.secrets) await connectionSecrets.update(this.wsId, id, onlyKnown(next, input.secrets));
		await this.harness.commit(async (tx) => {
			(await tx.doc(ConnectionsDoc)).connections[id] = next;
		}, ctx);
		await pool.close(this.#key(next));
		return this.refresh(id);
	}

	async remove(id: string) {
		const conn = await this.require(id);
		if (conn.source === "config") throw new HttpError(403, "This connection is declared in outpost.config.json");
		await this.harness.commit(async (tx) => {
			delete (await tx.doc(ConnectionsDoc)).connections[id];
		}, ctx);
		await pool.close(this.#key(conn));
		await connectionSecrets.update(this.wsId, id, null);
		rmSync(this.#specFile(id), { force: true });
		this.onChange();
	}

	/** Discover the service's methods again; the result (or the error) is stored on the connection. */
	async refresh(id: string): Promise<Connection> {
		const conn = await this.require(id);
		const cfg = fromConfig.get(conn.id);
		if (cfg) {
			cfg.discovering = undefined;
			await pool.close(this.#key(conn));
			await this.#discoverConfig(cfg);
			return plain(cfg.conn);
		}
		const patch = await this.#discover(conn);
		let saved: Connection | undefined;
		await this.harness.commit(async (tx) => {
			const c = (await tx.doc(ConnectionsDoc)).connections[id];
			if (!c) return;
			delete c.error;
			delete c.apiBase;
			delete c.account;
			Object.assign(c, plain(patch));
			saved = plain(c);
		}, ctx);
		this.onChange();
		return saved ?? conn;
	}

	async #discover(conn: Connection): Promise<Partial<Connection>> {
		const secrets = this.#secrets(conn);
		try {
			if (conn.kind === "mcp") {
				const methods = await pool.discover(this.#key(conn), conn, secrets);
				return { methods, status: "ok", refreshedAt: Date.now() };
			}
			if (conn.kind === "azure-devops") {
				const me = await azdoCheck(conn, secrets);
				return { methods: azdoMethods(conn), account: me.name, apiBase: `https://dev.azure.com/${conn.params!.organization}${conn.params?.project ? `/${conn.params.project}` : ""}`, status: "ok", refreshedAt: Date.now() };
			}
			if (conn.kind === "github-repo") {
				const me = await githubCheck(conn, secrets);
				return { methods: githubMethods(conn), account: me.name, apiBase: me.url, status: "ok", refreshedAt: Date.now() };
			}
			const doc = await parseSpec(await loadSpecText(conn, this.#specFile(conn.id), secrets));
			const apiBase = baseUrlOf(doc, conn);
			await assertPublicUrl(apiBase, { allowPrivate: conn.source === "config" });
			return { methods: operationsOf(doc, conn), apiBase, status: "ok", refreshedAt: Date.now() };
		} catch (error) {
			return { status: "error", error: redact(String((error as Error)?.message ?? error), secrets).slice(0, 500), refreshedAt: Date.now() };
		}
	}

	/** Run one method for real (a read, an auto-approved write, or an approved action). */
	async call(conn: Connection, name: string, args: any): Promise<unknown> {
		let m = conn.methods.find((x) => x.name === name);
		if (!m) {
			conn = await this.refresh(conn.id);
			m = conn.methods.find((x) => x.name === name);
			if (!m) throw new Error(`${conn.label} has no method "${name}"${conn.status === "error" ? ` (the connection is failing: ${conn.error})` : ""}`);
		}
		const secrets = this.#secrets(conn);
		if (conn.kind === "mcp") return pool.call(this.#key(conn), conn, secrets, name, args);
		if (conn.kind === "azure-devops") return azdoCall(conn, secrets, name, args);
		if (conn.kind === "github-repo") return githubCall(conn, secrets, name, args);
		if (!conn.apiBase) throw new Error(`${conn.label} has no base URL yet${conn.error ? `: ${conn.error}` : ""}`);
		return invoke(conn, conn.apiBase, m, args ?? {}, secrets);
	}

	/** A connection as a Airlock, so grants, approvals, audit and ctx.airlocks treat it like a built-in one. */
	airlock(conn: Connection): Airlock {
		const info = CONNECTOR_INFO[conn.kind];
		const methods: Record<string, AirlockMethod> = {};
		for (const m of conn.methods) methods[m.name] = this.#method(conn, m);
		return {
			id: conn.kind,
			title: `${conn.title} (${info.title})`,
			icon: conn.icon,
			description: info.description,
			resourceHint: conn.label,
			normalizeResource: () => conn.label,
			methods,
			trust: conn.trust,
			connection: conn.id,
			...(conn.kind === "azure-devops" ? { overlay: azdoOverlay } : {}),
		};
	}

	#method(conn: Connection, m: ConnMethod): AirlockMethod {
		return {
			description: m.description,
			params: paramHints(m.inputSchema),
			effect: m.effect,
			inputSchema: m.inputSchema,
			classifiedBy: m.classifiedBy,
			...(m.alwaysAsk ? { alwaysAsk: true } : {}),
			summarize: (a) => `${conn.label}.${m.name}${summarizeArgs(a)}`,
			// A generic connector can't know what the service would have returned.
			simulate: (_r, a, id) =>
				(conn.kind === "azure-devops" ? azdoSimulate(m.name, a, id) : undefined) ?? { status: "pending", actionId: id, simulated: true, note: "Queued for approval. The service hasn't been called; use action_result with this actionId later for the real result." },
			run: async (_resource, args) => this.call((await this.require(conn.id)) ?? conn, m.name, args),
		};
	}

	async close() {
		await pool.closeAll(`${this.wsId}/`);
	}

	// ---------------------------------------------------------------- proposals (drafted by agents)

	async proposals(): Promise<ConnectionProposal[]> {
		const doc = await this.harness.snapshot(ConnectionsDoc, ctx);
		return Object.values(doc?.proposals ?? {})
			.map(plain)
			.sort((a, b) => b.createdAt - a.createdAt);
	}

	/** An agent drafts a connection (no secret) for an owner to review and connect. */
	async propose(input: Omit<ConnectionInput, "auth"> & { auth?: { kind: string; name?: string }; reason?: string; setup?: string }, proposedBy: ConnectionProposal["proposedBy"]): Promise<ConnectionProposal> {
		const kind = input.kind;
		if (!kind || !CONNECTOR_INFO[kind]) throw new Error(`kind must be one of ${Object.keys(CONNECTOR_INFO).join(", ")}`);
		const label = (input.label ?? "").trim();
		if (!LABEL.test(label)) throw new Error("label: a letter, then letters, digits, - or _ (at most 40)");
		if (AIRLOCKS[label]) throw new Error(`"${label}" is a built-in Airlock's name; pick another label`);
		if ((await this.list()).some((c) => c.label === label)) throw new Error(`A connection called "${label}" already exists: ask for access to it with request_access instead`);
		const pending = (await this.proposals()).filter((p) => p.status === "pending");
		if (pending.some((p) => p.label === label)) throw new Error(`"${label}" is already proposed and waiting for an owner`);
		if (pending.length >= 20) throw new Error("Too many connection proposals are waiting; ask the user to review them first");
		const http = (v: string | undefined, what: string) => {
			const t = v?.trim();
			if (t && !/^https?:\/\/[^\s]+$/i.test(t)) throw new Error(`${what} must be an http(s) URL`);
			return t || undefined;
		};
		const url = kind === "mcp" ? http(input.url, "url") : undefined;
		const spec = kind === "openapi" ? http(input.spec, "spec") : undefined;
		if (kind === "mcp" && !url) throw new Error("An MCP connection needs the server's url");
		if (kind === "openapi" && !spec) throw new Error("A REST API connection needs the URL of its OpenAPI document (spec)");
		let params = kind === "openapi" || kind === "azure-devops" || kind === "github-repo" ? normalizeParams(input.params) : undefined;
		if (kind === "github-repo") {
			try {
				params = canonicalParams(kind, params);
			} catch (e) {
				throw new Error((e as Error).message);
			}
		}
		if (kind === "azure-devops") {
			const org = params?.organization ?? "";
			if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,49}$/.test(org)) throw new Error('Azure DevOps needs params.organization: the organization\'s name (dev.azure.com/<organization>), and optionally params.project');
			if (!(await azdoOrgExists(org).catch(() => true))) throw new Error(`There's no Azure DevOps organization "${org}" (dev.azure.com/${org} answers 404). Check the name.`);
		}
		let auth: ConnectionAuth;
		try {
			auth = normalizeAuth(input.auth as ConnectionAuth | undefined);
		} catch (e) {
			throw new Error((e as Error).message);
		}
		if (kind === "mcp" || kind === "openapi") await this.#probe(kind, url, spec);
		const proposal: ConnectionProposal = plain({
			id: newId("cp"),
			kind,
			label,
			title: input.title?.trim() || undefined,
			url,
			transport: kind === "mcp" && (input.transport === "http" || input.transport === "sse") ? input.transport : undefined,
			spec,
			baseUrl: http(input.baseUrl, "baseUrl"),
			params,
			auth: kind === "azure-devops" ? { kind: "basic" as const } : kind === "github-repo" ? { kind: "bearer" as const } : auth,
			reason: (input.reason ?? "").trim().slice(0, 1000) || "(no reason given)",
			setup: input.setup?.trim().slice(0, 1000) || undefined,
			proposedBy,
			status: "pending" as const,
			createdAt: Date.now(),
		});
		await this.harness.commit(async (tx) => {
			const doc = await tx.doc(ConnectionsDoc);
			doc.proposals ??= {};
			doc.proposals[proposal.id] = proposal;
		}, ctx);
		this.onChange();
		return proposal;
	}

	/**
	 * Check a proposed address before an owner sees it, so made-up or outdated URLs go back to the
	 * agent: an OpenAPI document must load and parse (or ask for credentials); an MCP endpoint must
	 * answer (any status but 404: without the key, servers reply 401, 405, 406…).
	 */
	async #probe(kind: "mcp" | "openapi", url: string | undefined, spec: string | undefined) {
		const target = (kind === "mcp" ? url : spec)!;
		let res: Awaited<ReturnType<typeof guardedFetch>>;
		try {
			res = await guardedFetch(target, {
				method: kind === "mcp" ? "POST" : "GET",
				headers: kind === "mcp" ? { "content-type": "application/json", accept: "application/json, text/event-stream" } : { accept: "application/json, application/yaml, */*" },
				body: kind === "mcp" ? JSON.stringify({ jsonrpc: "2.0", id: 0, method: "ping" }) : undefined,
				timeoutMs: 15_000,
				maxBytes: kind === "mcp" ? 64 << 10 : 20 << 20,
			});
		} catch (error) {
			throw new Error(`Couldn't reach ${target}: ${(error as Error).message}. Check the address (the vendor's documentation) and propose again.`);
		}
		if (res.status === 404 || res.status === 410) throw new Error(`${target} answered HTTP ${res.status}: there's no ${kind === "mcp" ? "MCP server" : "OpenAPI document"} at that address. Find the current one in the vendor's documentation and propose again.`);
		if (kind === "mcp") return;
		if (res.status === 401 || res.status === 403) return; // the document itself needs the key
		if (res.status >= 400) throw new Error(`Fetching the OpenAPI document at ${target} failed: HTTP ${res.status}.`);
		try {
			await parseSpec(res.text);
		} catch (error) {
			throw new Error(`${target} isn't a usable OpenAPI document: ${(error as Error).message}`);
		}
	}

	/** An owner connects a proposal: its fields, overridden by what the owner changed, plus the secret. */
	async accept(id: string, input: ConnectionInput, by: string): Promise<{ connection: Connection; proposal: ConnectionProposal }> {
		const proposal = (await this.proposals()).find((p) => p.id === id);
		if (!proposal || proposal.status !== "pending") throw new HttpError(409, "This proposal isn't waiting any more");
		const { id: _id, reason: _r, setup: _s, proposedBy: _p, status: _st, createdAt: _c, ...fields } = proposal;
		const connection = await this.create({ ...fields, ...input, kind: proposal.kind }, by);
		await this.#settle(id, { status: "accepted", connection: connection.id, decidedBy: by, decidedAt: Date.now() });
		return { connection, proposal: { ...proposal, status: "accepted", connection: connection.id } };
	}

	async decline(id: string, by: string): Promise<ConnectionProposal> {
		const proposal = (await this.proposals()).find((p) => p.id === id);
		if (!proposal || proposal.status !== "pending") throw new HttpError(409, "This proposal isn't waiting any more");
		await this.#settle(id, { status: "declined", decidedBy: by, decidedAt: Date.now() });
		return { ...proposal, status: "declined" };
	}

	async #settle(id: string, patch: Partial<ConnectionProposal>) {
		await this.harness.commit(async (tx) => {
			const p = (await tx.doc(ConnectionsDoc)).proposals?.[id];
			if (p) Object.assign(p, plain(patch));
		}, ctx);
		this.onChange();
	}
}

function summarizeArgs(a: unknown) {
	const json = JSON.stringify(a ?? {});
	return json === "{}" ? "()" : ` ${json.length > 160 ? `${json.slice(0, 160)}…` : json}`;
}

/** Azure DevOps: work items and pull requests waiting for approval show up in the lists they'd be in. */
function azdoOverlay(method: string, _args: any, result: any, pending: { method: string; simulated: any }[]) {
	if (!Array.isArray(result)) return result;
	const match = method === "query_work_items" ? "create_work_item" : method === "list_pull_requests" ? "create_pull_request" : undefined;
	if (!match) return result;
	return [...pending.filter((p) => p.method === match).map((p) => p.simulated), ...result];
}

/** github-repo stores the repository as owner/repo, whatever form (owner/repo or a github.com URL) was typed. */
function canonicalParams(kind: Connection["kind"], params: Record<string, string> | undefined) {
	if (kind !== "github-repo") return params;
	try {
		return { ...params, repository: githubRepository(params?.repository ?? "") };
	} catch (e) {
		throw new HttpError(400, (e as Error).message);
	}
}

/** Fixed parameters: string values, sane names, at most 20. */
function normalizeParams(p: unknown): Record<string, string> | undefined {
	if (p === undefined || p === null) return undefined;
	if (typeof p !== "object" || Array.isArray(p)) throw new HttpError(400, "params: an object of name → value");
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(p as Record<string, unknown>)) {
		const name = k.trim();
		if (!name) continue;
		if (!/^[A-Za-z0-9_.$-]{1,80}$/.test(name)) throw new HttpError(400, `params: "${name}" isn't a parameter name`);
		if (typeof v !== "string" && typeof v !== "number") throw new HttpError(400, `params: ${name} needs a text value`);
		out[name] = String(v).trim();
	}
	if (Object.keys(out).length > 20) throw new HttpError(400, "params: at most 20");
	return Object.keys(out).length ? out : undefined;
}

function normalizeAuth(a: ConnectionAuth | undefined): ConnectionAuth {
	switch (a?.kind) {
		case "bearer":
		case "basic":
			return { kind: a.kind };
		case "header":
		case "query": {
			const name = String((a as any).name ?? "").trim();
			if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,100}$/.test(name)) throw new HttpError(400, `${a.kind === "header" ? "Header" : "Query parameter"} name is required`);
			return { kind: a.kind, name };
		}
		default:
			return { kind: "none" };
	}
}

/** Keep only the secrets this connection's auth uses (UI connections can't set stdio env). */
function onlyKnown(conn: Connection, secrets: ConnectionSecrets): ConnectionSecrets {
	const names = new Set(secretNames(conn.auth));
	return Object.fromEntries(Object.entries(secrets).filter(([k, v]) => names.has(k) && typeof v === "string"));
}
