import { readFileSync } from "node:fs";
import SwaggerParser from "@apidevtools/swagger-parser";
import YAML from "yaml";
import { guardedFetch } from "../net.ts";
import { applyAuth, boundSchema, type Connection, type ConnectionSecrets, type ConnMethod, type HttpOperation, redact, truncateText } from "./types.ts";

const VERBS = ["get", "put", "post", "delete", "patch", "head", "options"] as const;
const READ_VERBS = new Set(["get", "head", "options"]);
const MAX_OPERATIONS = 2000;

/** Parse a JSON or YAML OpenAPI/Swagger document and resolve its internal $refs (@apidevtools/swagger-parser). */
export async function parseSpec(text: string): Promise<any> {
	let doc: any;
	try {
		doc = JSON.parse(text);
	} catch {
		doc = YAML.parse(text);
	}
	if (!doc || typeof doc !== "object" || !(doc.openapi || doc.swagger)) throw new Error("Not an OpenAPI 3 or Swagger 2 document (no `openapi` or `swagger` field)");
	// External $refs would make the parser fetch arbitrary URLs: only references inside the document resolve.
	return SwaggerParser.dereference(doc, { resolve: { external: false }, dereference: { circular: "ignore" } } as any);
}

/** Read the document: fetched from its URL, or the pasted copy on disk. */
export async function loadSpecText(conn: Connection, inlinePath: string, secrets: ConnectionSecrets): Promise<string> {
	if (!conn.spec || conn.spec === "inline") return readFileSync(inlinePath, "utf8");
	// Specs behind the same auth as the API are common (e.g. internal gateways).
	const auth = applyAuthSafe(conn, secrets);
	const url = new URL(conn.spec);
	for (const [k, v] of Object.entries(auth.query)) url.searchParams.set(k, v);
	const res = await guardedFetch(url, { headers: { accept: "application/json, application/yaml, text/yaml, */*", ...auth.headers }, allowPrivate: conn.source === "config", maxBytes: 20 << 20 });
	if (res.status >= 400) throw new Error(`Fetching the OpenAPI document failed: HTTP ${res.status}`);
	if (res.truncated) throw new Error("The OpenAPI document is larger than 20 MB");
	return res.text;
}

function applyAuthSafe(conn: Connection, secrets: ConnectionSecrets) {
	try {
		return applyAuth(conn.auth, secrets);
	} catch {
		return { headers: {}, query: {} };
	}
}

/** The API's base URL: the connection's override, else the document's first server (relative to the document's URL). */
export function baseUrlOf(doc: any, conn: Connection): string {
	if (conn.baseUrl) return conn.baseUrl.replace(/\/+$/, "");
	const relativeTo = conn.spec && conn.spec !== "inline" ? conn.spec : undefined;
	if (doc.swagger) {
		if (!doc.host && !relativeTo) throw new Error("The document names no host; set the base URL");
		const scheme = (doc.schemes ?? []).includes("https") ? "https" : (doc.schemes?.[0] ?? "https");
		const origin = doc.host ? `${scheme}://${doc.host}` : new URL(relativeTo!).origin;
		return `${origin}${doc.basePath ?? ""}`.replace(/\/+$/, "");
	}
	const server = doc.servers?.[0];
	if (!server?.url) {
		if (!relativeTo) throw new Error("The document names no server; set the base URL");
		return new URL(relativeTo).origin;
	}
	let url: string = server.url;
	for (const [name, v] of Object.entries((server.variables ?? {}) as Record<string, any>)) url = url.replaceAll(`{${name}}`, String(v?.default ?? ""));
	return new URL(url, relativeTo ?? "https://invalid.local").href.replace(/\/+$/, "");
}

const slug = (s: string) =>
	s
		.replace(/[{}]/g, "")
		.replace(/[^A-Za-z0-9_]+/g, "_")
		.replace(/^_+|_+$/g, "")
		.slice(0, 64) || "op";

/** Operations → methods. GET/HEAD/OPTIONS are reads; DELETE always asks; the owner can mark more reads. */
export function operationsOf(doc: any, conn: Connection): ConnMethod[] {
	const out: ConnMethod[] = [];
	const used = new Set<string>();
	const reads = new Set(conn.reads ?? []);
	const fixed = new Set(Object.keys(conn.params ?? {}));
	for (const [path, item] of Object.entries((doc.paths ?? {}) as Record<string, any>)) {
		if (!item || typeof item !== "object") continue;
		for (const verb of VERBS) {
			const op = item[verb];
			if (!op || out.length >= MAX_OPERATIONS) continue;
			let name = slug(op.operationId ?? `${verb}_${path}`);
			for (let i = 2; used.has(name); i++) name = `${slug(op.operationId ?? `${verb}_${path}`)}_${i}`;
			used.add(name);
			const params = new Map<string, any>();
			for (const p of [...(item.parameters ?? []), ...(op.parameters ?? [])]) if (p?.name && p.in) params.set(`${p.in}:${p.name}`, p);
			const properties: Record<string, any> = {};
			const required: string[] = [];
			const httpParams: HttpOperation["params"] = [];
			let body = false;
			for (const p of params.values()) {
				if (p.in === "body") {
					properties.body = { ...(p.schema ?? {}), description: p.description ?? "request body (JSON)" };
					if (p.required) required.push("body");
					body = true;
					continue;
				}
				if (!["path", "query", "header"].includes(p.in)) continue;
				if (httpParams.some((x) => x.name === p.name)) continue;
				httpParams.push({ name: p.name, in: p.in, required: !!(p.required || p.in === "path") });
				// Fixed by the connection: sent by pi-os, not shown to agents.
				if (fixed.has(p.name)) continue;
				properties[p.name] = { ...(p.schema ?? { type: p.type ?? "string", ...(p.enum ? { enum: p.enum } : {}) }), ...(p.description ? { description: p.description } : {}) };
				if (p.required || p.in === "path") required.push(p.name);
			}
			const content = op.requestBody?.content as Record<string, any> | undefined;
			if (content) {
				const type = Object.keys(content).find((t) => /json/i.test(t)) ?? Object.keys(content)[0];
				properties.body = { ...(content[type!]?.schema ?? {}), description: op.requestBody.description ?? `request body (${type})` };
				if (op.requestBody.required) required.push("body");
				body = true;
			}
			const read = READ_VERBS.has(verb);
			const owner = reads.has(name);
			out.push({
				name,
				description: truncateText([`${verb.toUpperCase()} ${path}`, op.summary, op.description].filter(Boolean).join(" — "), 1500),
				inputSchema: boundSchema({ type: "object", properties, ...(required.length ? { required: [...new Set(required)] } : {}) }),
				effect: read || owner ? "read" : "write",
				classifiedBy: owner && !read ? "owner" : "spec",
				...(verb === "delete" && !owner ? { alwaysAsk: true } : {}),
				http: { method: verb.toUpperCase(), path, params: httpParams, ...(body ? { body: true } : {}) },
			});
		}
	}
	return out;
}

/** Send one operation. Path parameters are encoded into their segment, so they can't escape the base URL. */
export async function invoke(conn: Connection, baseUrl: string, m: ConnMethod, input: Record<string, any>, secrets: ConnectionSecrets): Promise<unknown> {
	const op = m.http!;
	// Fixed parameters win over anything the caller passed.
	const args: Record<string, any> = { ...input };
	for (const [k, v] of Object.entries(conn.params ?? {})) if (op.params.some((p) => p.name === k)) args[k] = v;
	let path = op.path;
	for (const p of op.params.filter((p) => p.in === "path")) {
		const v = args[p.name];
		if (v === undefined || v === null || v === "") throw new Error(`Missing path parameter "${p.name}"`);
		path = path.replaceAll(`{${p.name}}`, encodeURIComponent(String(v)));
	}
	const url = new URL(baseUrl + (path.startsWith("/") ? path : `/${path}`));
	const base = new URL(baseUrl);
	if (url.origin !== base.origin) throw new Error("Request URL left the API's origin");
	const headers: Record<string, string> = { accept: "application/json, */*" };
	for (const p of op.params) {
		const v = args[p.name];
		if (v === undefined || v === null) {
			if (p.required && p.in !== "path") throw new Error(`Missing ${p.in} parameter "${p.name}"`);
			continue;
		}
		if (p.in === "query") for (const one of Array.isArray(v) ? v : [v]) url.searchParams.append(p.name, typeof one === "object" ? JSON.stringify(one) : String(one));
		if (p.in === "header" && !/^(authorization|cookie|host)$/i.test(p.name)) headers[p.name] = String(v);
	}
	const auth = applyAuth(conn.auth, secrets);
	for (const [k, v] of Object.entries(auth.query)) url.searchParams.set(k, v);
	Object.assign(headers, auth.headers);
	let body: string | undefined;
	if (op.body && args.body !== undefined) {
		body = typeof args.body === "string" ? args.body : JSON.stringify(args.body);
		headers["content-type"] = typeof args.body === "string" ? "text/plain" : "application/json";
	}
	const res = await guardedFetch(url, { method: op.method, headers, body, allowPrivate: conn.source === "config" }).catch((e) => {
		throw new Error(redact(String(e?.message ?? e), secrets));
	});
	let parsed: unknown = truncateText(res.text);
	if ((res.contentType ?? "").includes("json") && !res.truncated) {
		try {
			parsed = JSON.parse(res.text);
		} catch {}
	}
	if (res.status >= 400) throw new Error(redact(`HTTP ${res.status}: ${typeof parsed === "string" ? parsed.slice(0, 500) : JSON.stringify(parsed).slice(0, 500)}`, secrets));
	return { status: res.status, body: parsed, ...(res.truncated ? { truncated: true } : {}) };
}
