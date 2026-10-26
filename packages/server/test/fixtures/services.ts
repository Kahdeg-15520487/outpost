/**
 * Local third-party services for the connector tests: an MCP server over streamable HTTP (bearer
 * auth, stateless) with a notes API, and a REST API with an OpenAPI document (API key header).
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

export const MCP_TOKEN = "mcp-secret-token-123";
export const API_KEY = "api-key-456";
export const notes: { id: number; text: string }[] = [{ id: 1, text: "hello world" }];
let nextNote = 2;

function mcpServer() {
	const server = new Server({ name: "fixture-notes", version: "1.0.0" }, { capabilities: { tools: {} } });
	server.setRequestHandler(ListToolsRequestSchema, async () => ({
		tools: [
			{ name: "search_notes", description: "Search notes by text", inputSchema: { type: "object", properties: { query: { type: "string", description: "words to find" } } }, annotations: { readOnlyHint: true } },
			{ name: "add_note", description: "Add a note", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
			{ name: "delete_note", description: "Delete a note", inputSchema: { type: "object", properties: { id: { type: "number" } }, required: ["id"] }, annotations: { readOnlyHint: false, destructiveHint: true } },
			{ name: "explode", description: "Always fails", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } },
		],
	}));
	server.setRequestHandler(CallToolRequestSchema, async (req) => {
		const a = (req.params.arguments ?? {}) as any;
		const json = (v: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(v) }] });
		switch (req.params.name) {
			case "search_notes":
				return json(notes.filter((n) => n.text.includes(String(a.query ?? ""))));
			case "add_note": {
				const note = { id: nextNote++, text: String(a.text) };
				notes.push(note);
				return json(note);
			}
			case "delete_note": {
				const i = notes.findIndex((n) => n.id === a.id);
				if (i >= 0) notes.splice(i, 1);
				return json({ deleted: i >= 0 });
			}
			default:
				return { isError: true, content: [{ type: "text" as const, text: "kaboom: the tool failed" }] };
		}
	});
	return server;
}

const readBody = (req: IncomingMessage) =>
	new Promise<string>((resolve) => {
		let b = "";
		req.on("data", (c) => (b += c));
		req.on("end", () => resolve(b));
	});

const mcpHttp = createServer(async (req: IncomingMessage, res: ServerResponse) => {
	if (req.headers.authorization !== `Bearer ${MCP_TOKEN}`) {
		res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: "unauthorized" }));
		return;
	}
	if (req.method !== "POST") {
		res.writeHead(405).end();
		return;
	}
	// Stateless: a fresh server and transport per request.
	const server = mcpServer();
	const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
	res.on("close", () => {
		void transport.close();
		void server.close();
	});
	await server.connect(transport);
	await transport.handleRequest(req, res, JSON.parse((await readBody(req)) || "null"));
});

export const items: { id: string; name: string }[] = [{ id: "a1", name: "Anvil" }];
export const SPEC = `openapi: 3.0.3
info: { title: Inventory, version: "1.0" }
servers:
  - url: /api
paths:
  /items:
    get:
      operationId: listItems
      summary: List items
      parameters:
        - { name: q, in: query, schema: { type: string } }
      responses: { "200": { description: ok } }
    post:
      operationId: createItem
      summary: Create an item
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: "#/components/schemas/NewItem" }
      responses: { "201": { description: created } }
  /items/{id}:
    parameters:
      - { name: id, in: path, required: true, schema: { type: string } }
    get:
      operationId: getItem
      responses: { "200": { description: ok } }
    delete:
      operationId: deleteItem
      responses: { "204": { description: gone } }
components:
  schemas:
    NewItem:
      type: object
      required: [name]
      properties:
        name: { type: string, description: The item's name }
`;
export const apiHits: string[] = [];
const api = createServer(async (req, res) => {
	const url = new URL(req.url!, "http://x");
	if (url.pathname === "/openapi.yaml") {
		res.writeHead(200, { "content-type": "application/yaml" }).end(SPEC);
		return;
	}
	if (req.headers["x-api-key"] !== API_KEY) {
		res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: "bad key" }));
		return;
	}
	apiHits.push(`${req.method} ${url.pathname}${url.search}`);
	const send = (status: number, body?: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(body === undefined ? "" : JSON.stringify(body));
	if (url.pathname === "/api/items" && req.method === "GET") return send(200, items.filter((i) => i.name.toLowerCase().includes((url.searchParams.get("q") ?? "").toLowerCase())));
	if (url.pathname === "/api/items" && req.method === "POST") {
		const body = JSON.parse(await readBody(req));
		const item = { id: `i${items.length + 1}`, name: body.name };
		items.push(item);
		return send(201, item);
	}
	const m = /^\/api\/items\/([^/]+)$/.exec(url.pathname);
	if (m && req.method === "GET") {
		const it = items.find((i) => i.id === decodeURIComponent(m[1]!));
		return it ? send(200, it) : send(404, { error: "no such item" });
	}
	if (m && req.method === "DELETE") return send(204);
	send(404, { error: "not found" });
});

const listen = (s: ReturnType<typeof createServer>) => new Promise<number>((r) => s.listen(0, "127.0.0.1", () => r((s.address() as any).port)));

/** Start both services on free loopback ports. */
export async function startServices() {
	const mcpUrl = `http://127.0.0.1:${await listen(mcpHttp)}/mcp`;
	const apiOrigin = `http://127.0.0.1:${await listen(api)}`;
	return {
		mcpUrl,
		apiOrigin,
		close: () => {
			mcpHttp.close();
			api.close();
		},
	};
}

