import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { PIOS_VERSION } from "../../gadgets/compat.ts";
import { assertPublicUrl, checkedFetch } from "../net.ts";
import { applyAuth, boundSchema, type Connection, type ConnectionSecrets, type ConnMethod, redact, truncateText } from "./types.ts";

const TIMEOUT = 60_000;
const MAX_TOOLS = 2000;

/**
 * MCP clients, one per connection, opened on first use and reused. A call that fails because the
 * session dropped reconnects once. Uses the official SDK (@modelcontextprotocol/sdk).
 */
export class McpPool {
	readonly #clients = new Map<string, Promise<Client>>();

	async #open(conn: Connection, secrets: ConnectionSecrets): Promise<Client> {
		const vetted = conn.source === "config";
		const connectWith = async (transport: Transport) => {
			const client = new Client({ name: "pi-os", version: PIOS_VERSION });
			await client.connect(transport, { timeout: TIMEOUT });
			return client;
		};
		if (conn.transport === "stdio") {
			if (!vetted || !conn.command) throw new Error("Local MCP commands can only be declared by an admin in pi-os.config.json");
			const env: Record<string, string> = { ...getDefaultEnvironment() };
			for (const [k, v] of Object.entries(secrets)) if (k.startsWith("env.")) env[k.slice(4)] = v;
			return connectWith(new StdioClientTransport({ command: conn.command, args: conn.args ?? [], env, stderr: "ignore" }));
		}
		if (!conn.url) throw new Error("This MCP connection has no URL");
		const auth = applyAuth(conn.auth, secrets);
		const url = new URL(conn.url);
		for (const [k, v] of Object.entries(auth.query)) url.searchParams.set(k, v);
		await assertPublicUrl(url, { allowPrivate: vetted });
		const opts = { requestInit: { headers: auth.headers }, fetch: checkedFetch({ allowPrivate: vetted }) };
		if (conn.transport === "sse") return connectWith(new SSEClientTransport(url, opts));
		try {
			return await connectWith(new StreamableHTTPClientTransport(url, opts));
		} catch (error) {
			// Older servers speak only the HTTP+SSE transport (protocol 2024-11-05).
			if (conn.transport === "http") throw error;
			try {
				return await connectWith(new SSEClientTransport(url, opts));
			} catch {
				throw error;
			}
		}
	}

	client(key: string, conn: Connection, secrets: ConnectionSecrets): Promise<Client> {
		let c = this.#clients.get(key);
		if (!c) {
			c = this.#open(conn, secrets);
			this.#clients.set(key, c);
			c.then(
				(client) => {
					client.onclose = () => {
						if (this.#clients.get(key) === c) this.#clients.delete(key);
					};
				},
				() => this.#clients.delete(key),
			);
		}
		return c;
	}

	async close(key: string) {
		const c = this.#clients.get(key);
		this.#clients.delete(key);
		await (await c?.catch(() => undefined))?.close().catch(() => {});
	}

	async closeAll(prefix = "") {
		await Promise.all([...this.#clients.keys()].filter((k) => k.startsWith(prefix)).map((k) => this.close(k)));
	}

	/** Run `fn` with a connected client; if the session was lost, reconnect and retry once. */
	async #with<T>(key: string, conn: Connection, secrets: ConnectionSecrets, fn: (c: Client) => Promise<T>): Promise<T> {
		try {
			return await fn(await this.client(key, conn, secrets));
		} catch (error) {
			const msg = String((error as Error)?.message ?? error);
			if (!/closed|not connected|session|ECONNRESET|terminated|fetch failed|404/i.test(msg)) throw new Error(redact(msg, secrets));
			await this.close(key);
			try {
				return await fn(await this.client(key, conn, secrets));
			} catch (again) {
				throw new Error(redact(String((again as Error)?.message ?? again), secrets));
			}
		}
	}

	/** The server's tools as methods. `readOnlyHint: true` → read; anything else is a write; `destructiveHint: true` always asks. */
	discover(key: string, conn: Connection, secrets: ConnectionSecrets): Promise<ConnMethod[]> {
		return this.#with(key, conn, secrets, async (client) => {
			const tools: any[] = [];
			let cursor: string | undefined;
			do {
				const page = await client.listTools(cursor ? { cursor } : {}, { timeout: TIMEOUT });
				tools.push(...page.tools);
				cursor = page.nextCursor;
			} while (cursor && tools.length < MAX_TOOLS);
			const reads = new Set(conn.reads ?? []);
			return tools.slice(0, MAX_TOOLS).map((t): ConnMethod => {
				const readOnly = t.annotations?.readOnlyHint === true;
				const owner = reads.has(t.name);
				const title = t.annotations?.title ?? t.title;
				return {
					name: t.name,
					description: truncateText([title && title !== t.name ? title : "", t.description ?? ""].filter(Boolean).join(": "), 1500),
					inputSchema: boundSchema(t.inputSchema),
					effect: owner || readOnly ? "read" : "write",
					classifiedBy: owner ? "owner" : t.annotations && typeof t.annotations.readOnlyHint === "boolean" ? "server" : "default",
					...(t.annotations?.destructiveHint === true && !owner ? { alwaysAsk: true } : {}),
				};
			});
		});
	}

	/** Call a tool. Errors the tool reports (`isError`) throw; results come back as JSON when they are JSON. */
	call(key: string, conn: Connection, secrets: ConnectionSecrets, name: string, args: unknown): Promise<unknown> {
		return this.#with(key, conn, secrets, async (client) => {
			const res: any = await client.callTool({ name, arguments: (args ?? {}) as Record<string, unknown> }, undefined, { timeout: TIMEOUT });
			const texts = (res.content ?? []).filter((c: any) => c.type === "text").map((c: any) => String(c.text));
			if (res.isError) throw new Error(redact(texts.join("\n") || "The tool reported an error", secrets));
			if (res.structuredContent !== undefined) return res.structuredContent;
			const others = (res.content ?? [])
				.filter((c: any) => c.type !== "text")
				.map((c: any) => (c.type === "resource" ? { resource: c.resource?.uri, text: c.resource?.text && truncateText(String(c.resource.text), 20_000) } : { [c.type]: c.uri ?? c.mimeType ?? true }));
			if (texts.length === 1 && !others.length) {
				try {
					return JSON.parse(texts[0]!);
				} catch {
					return truncateText(texts[0]!);
				}
			}
			return [...texts.map((t: string) => truncateText(t)), ...others];
		});
	}
}
