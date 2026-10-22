import type { IncomingMessage, ServerResponse } from "node:http";
import { HttpError, sessions, type User } from "../kernel/system-db.ts";

export function parseCookies(header: string | undefined): Record<string, string> {
	const out: Record<string, string> = {};
	for (const part of header?.split(";") ?? []) {
		const i = part.indexOf("=");
		if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
	}
	return out;
}

export type Req = {
	raw: IncomingMessage;
	res: ServerResponse;
	method: string;
	path: string;
	query: URLSearchParams;
	params: Record<string, string>;
	user: User | undefined;
	body(): Promise<any>;
	need(): User;
};

type Handler = (req: Req) => unknown | Promise<unknown>;
type Route = { method: string; pattern: RegExp; keys: string[]; handler: Handler };

export class Router {
	routes: Route[] = [];
	on(method: string, path: string, handler: Handler) {
		const keys: string[] = [];
		const pattern = new RegExp(`^${path.replace(/:(\w+)/g, (_, k) => (keys.push(k), "([^/]+)"))}$`);
		this.routes.push({ method, pattern, keys, handler });
		return this;
	}
	get = (p: string, h: Handler) => this.on("GET", p, h);
	post = (p: string, h: Handler) => this.on("POST", p, h);
	put = (p: string, h: Handler) => this.on("PUT", p, h);
	patch = (p: string, h: Handler) => this.on("PATCH", p, h);
	delete = (p: string, h: Handler) => this.on("DELETE", p, h);

	/** Returns false when no route matched. */
	async handle(raw: IncomingMessage, res: ServerResponse): Promise<boolean> {
		const url = new URL(raw.url ?? "/", "http://x");
		for (const route of this.routes) {
			if (route.method !== raw.method) continue;
			const match = route.pattern.exec(url.pathname);
			if (!match) continue;
			const params = Object.fromEntries(route.keys.map((k, i) => [k, decodeURIComponent(match[i + 1]!)]));
			const user = sessions.user(parseCookies(raw.headers.cookie).pios_session);
			let bodyCache: Promise<any> | undefined;
			const req: Req = {
				raw,
				res,
				method: raw.method!,
				path: url.pathname,
				query: url.searchParams,
				params,
				user,
				body: () => (bodyCache ??= readJson(raw)),
				need: () => {
					if (!user) throw new HttpError(401, "Sign in required");
					return user;
				},
			};
			try {
				const result = await route.handler(req);
				if (!res.headersSent && !res.writableEnded) sendJson(res, 200, result ?? { ok: true });
			} catch (error) {
				const status = error instanceof HttpError ? error.status : 500;
				if (status === 500) console.error(error);
				if (!res.headersSent) sendJson(res, status, { error: error instanceof Error ? error.message : String(error) });
			}
			return true;
		}
		return false;
	}
}

async function readJson(req: IncomingMessage): Promise<any> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req) {
		size += chunk.length;
		if (size > 8 << 20) throw new HttpError(413, "Body too large");
		chunks.push(chunk);
	}
	if (!chunks.length) return {};
	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		throw new HttpError(400, "Invalid JSON");
	}
}

/** Read a raw request body, failing with 413 past `limit` bytes. */
export async function readRaw(req: Req, limit: number): Promise<Buffer> {
	const declared = Number(req.raw.headers["content-length"] ?? 0);
	if (declared > limit) throw new HttpError(413, `File too large (max ${Math.round(limit / (1 << 20))} MB)`);
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req.raw) {
		size += chunk.length;
		if (size > limit) throw new HttpError(413, `File too large (max ${Math.round(limit / (1 << 20))} MB)`);
		chunks.push(chunk);
	}
	return Buffer.concat(chunks);
}

export function sendJson(res: ServerResponse, status: number, value: unknown) {
	const body = JSON.stringify(value);
	res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
	res.end(body);
}
