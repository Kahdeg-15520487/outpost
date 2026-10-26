// A minimal MCP server over stdio, for the connectors test (an admin-declared local command).
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new Server({ name: "fixture-stdio", version: "1.0.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
	tools: [
		{ name: "whoami", description: "Which process answers, and the env it got", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } },
		{ name: "echo", description: "Echo a message back (a write: no annotations)", inputSchema: { type: "object", properties: { message: { type: "string" } }, required: ["message"] } },
	],
}));
server.setRequestHandler(CallToolRequestSchema, async (req) => {
	if (req.params.name === "whoami") return { content: [{ type: "text", text: JSON.stringify({ pid: process.pid, secret: process.env.FIXTURE_SECRET ?? null }) }] };
	if (req.params.name === "echo") return { content: [{ type: "text", text: JSON.stringify({ echoed: req.params.arguments?.message }) }] };
	return { isError: true, content: [{ type: "text", text: `no tool ${req.params.name}` }] };
});
await server.connect(new StdioServerTransport());
