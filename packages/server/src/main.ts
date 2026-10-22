import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { config } from "./config.ts";
import { createApi } from "./http/api.ts";
import { sendJson } from "./http/util.ts";
import { attachSockets } from "./collab/socket.ts";
import { installBuiltinBlueprints } from "./gadgets/blueprints.ts";
import { Workspace } from "./kernel/workspace.ts";
import { workspaces } from "./kernel/system-db.ts";

process.removeAllListeners("warning");
process.on("warning", (w) => w.name !== "ExperimentalWarning" && console.warn(w));

installBuiltinBlueprints();
const api = createApi();

const MIME: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".ico": "image/x-icon",
	".woff2": "font/woff2",
	".json": "application/json",
};

const server = createServer(async (req, res) => {
	try {
		if (await api.handle(req, res)) return;
		if (req.url?.startsWith("/api/")) return sendJson(res, 404, { error: "Not found" });
		// Static web app (production build). In development, Vite serves it and proxies here.
		const path = normalize(decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname)).replace(/^([/\\])+/, "");
		let file = join(config.webDist, path);
		if (!file.startsWith(config.webDist) || !existsSync(file) || statSync(file).isDirectory()) file = join(config.webDist, "index.html");
		if (!existsSync(file)) {
			res.writeHead(200, { "content-type": "text/plain" });
			return res.end("pi-os API is running. Build the web app (pnpm build) or run `pnpm dev` and open http://localhost:5173");
		}
		res.writeHead(200, {
			"content-type": MIME[extname(file)] ?? "application/octet-stream",
			"cache-control": file.includes(`${join("assets", "")}`) ? "public, max-age=31536000, immutable" : "no-cache",
			"x-frame-options": "DENY",
		});
		createReadStream(file).pipe(res);
	} catch (error) {
		console.error(error);
		if (!res.headersSent) sendJson(res, 500, { error: "Internal error" });
	}
});
attachSockets(server);

server.listen(config.port, config.host, () => {
	console.log(`pi-os listening on http://${config.host}:${config.port}`);
	console.log(`  config: ${config.configFound ? config.configPath : `(none — defaults; create ${config.configPath}, see pi-os.config.example.json)`}`);
	console.log(`  data:   ${config.dataDir}`);
});

// Reopen every workspace so runs interrupted by the last shutdown continue without waiting for a visitor.
setTimeout(async () => {
	for (const id of workspaces.allIds()) await Workspace.get(id).catch((e) => console.error(`[ws ${id}] failed to open`, e));
}, 0);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.on(signal, async () => {
		console.log("shutting down…");
		server.close();
		await Workspace.closeAll();
		process.exit(0);
	});
}
