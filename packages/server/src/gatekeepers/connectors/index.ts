import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import type { Harness } from "@earendil-works/pi-durable";
import { config, resolveSecret, type ConnectorConfig } from "../../config.ts";
import { ConnectionsDoc } from "../../kernel/docs.ts";
import { HttpError, newId } from "../../kernel/system-db.ts";
import { GATEKEEPERS, type Gatekeeper, type GatekeeperMethod } from "../catalog.ts";
import { assertPublicUrl } from "../net.ts";
import { McpPool } from "./mcp.ts";
import { baseUrlOf, invoke, loadSpecText, operationsOf, parseSpec } from "./openapi.ts";
import { CONNECTOR_INFO, type Connection, type ConnectionAuth, type ConnectionSecrets, type ConnMethod, connectionSecrets, paramHints, redact, secretNames } from "./types.ts";

export * from "./types.ts";

/** MCP sessions for every workspace; keys are `<workspace>/<connection>` or `cfg/<id>` for admin-declared ones. */
const pool = new McpPool();

// ------------------------------------------------------------------ admin-declared (vetted) connections

type ConfigEntry = { conn: Connection; secrets: ConnectionSecrets; workspaces?: string[]; discovering?: Promise<void> };
const fromConfig = new Map<string, ConfigEntry>();
for (const c of config.file.connectors ?? []) {
	if (!c?.id || !CONNECTOR_INFO[c.kind]) {
		console.warn(`pi-os: connectors entry needs an id and kind "mcp" or "openapi": ${JSON.stringify(c).slice(0, 120)}`);
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
			auth,
			reads: c.reads,
			methods: [],
			status: "pending",
			createdBy: "pi-os.config.json",
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
	auth?: ConnectionAuth;
	/** Values per secret name; "" deletes one. Never returned by the API. */
	secrets?: ConnectionSecrets;
	reads?: string[];
};

/**
 * One workspace's connections: the ones its owners added (ConnectionsDoc) plus the admin's from
 * pi-os.config.json. Discovery (tools / operations) is cached on the connection; calls go through
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
			secretsNeeded: secretNames(conn.auth),
			methods: conn.methods.map((m) => ({ name: m.name, description: m.description, effect: m.effect, alwaysAsk: !!m.alwaysAsk, classifiedBy: m.classifiedBy, params: paramHints(m.inputSchema) })),
		};
	}

	async #checkLabel(label: string, exceptId?: string) {
		if (!LABEL.test(label)) throw new HttpError(400, "Label: a letter, then letters, digits, - or _ (at most 40)");
		if (GATEKEEPERS[label]) throw new HttpError(400, `"${label}" is a built-in Gatekeeper's name`);
		if ((await this.list()).some((c) => c.label === label && c.id !== exceptId)) throw new HttpError(409, `A connection is already called "${label}"`);
	}

	#validate(c: Connection) {
		if (c.kind === "mcp") {
			if (!c.url) throw new HttpError(400, "An MCP connection needs the server's URL");
			if (!/^https?:\/\//i.test(c.url)) throw new HttpError(400, "The MCP URL must be http(s). Local commands (stdio) can only be declared by an admin in pi-os.config.json.");
		}
		if (c.kind === "openapi" && !c.spec) throw new HttpError(400, "A REST API connection needs its OpenAPI document: a URL or the document itself");
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
			auth: normalizeAuth(input.auth),
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
		if (current.source === "config") throw new HttpError(403, "This connection is declared in pi-os.config.json");
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
			...(input.auth ? { auth: normalizeAuth(input.auth) } : {}),
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
		if (conn.source === "config") throw new HttpError(403, "This connection is declared in pi-os.config.json");
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
		if (!conn.apiBase) throw new Error(`${conn.label} has no base URL yet${conn.error ? `: ${conn.error}` : ""}`);
		return invoke(conn, conn.apiBase, m, args ?? {}, secrets);
	}

	/** A connection as a Gatekeeper, so grants, approvals, audit and ctx.gatekeepers treat it like a built-in one. */
	gatekeeper(conn: Connection): Gatekeeper {
		const info = CONNECTOR_INFO[conn.kind];
		const methods: Record<string, GatekeeperMethod> = {};
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
		};
	}

	#method(conn: Connection, m: ConnMethod): GatekeeperMethod {
		return {
			description: m.description,
			params: paramHints(m.inputSchema),
			effect: m.effect,
			inputSchema: m.inputSchema,
			classifiedBy: m.classifiedBy,
			...(m.alwaysAsk ? { alwaysAsk: true } : {}),
			summarize: (a) => `${conn.label}.${m.name}${summarizeArgs(a)}`,
			// A generic connector can't know what the service would have returned.
			simulate: (_r, _a, id) => ({ status: "pending", actionId: id, simulated: true, note: "Queued for approval. The service hasn't been called; use action_result with this actionId later for the real result." }),
			run: async (_resource, args) => this.call((await this.require(conn.id)) ?? conn, m.name, args),
		};
	}

	async close() {
		await pool.closeAll(`${this.wsId}/`);
	}
}

function summarizeArgs(a: unknown) {
	const json = JSON.stringify(a ?? {});
	return json === "{}" ? "()" : ` ${json.length > 160 ? `${json.slice(0, 160)}…` : json}`;
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
