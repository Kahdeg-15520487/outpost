import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const piAgentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");

const dataDir = resolve(process.env.PI_OS_DATA ?? join(repoRoot, "data"));
mkdirSync(join(dataDir, "workspaces"), { recursive: true });

/** Share pi's auth.json when present so every provider you logged into with pi works here too. */
function defaultAuthFile(): string {
	const piAuth = join(piAgentDir, "auth.json");
	return existsSync(piAuth) ? piAuth : join(dataDir, "auth.json");
}

function piDefaultModel(): { provider: string; modelId: string } | undefined {
	try {
		const settings = JSON.parse(readFileSync(join(piAgentDir, "settings.json"), "utf8"));
		if (typeof settings.defaultProvider === "string" && typeof settings.defaultModel === "string") {
			return { provider: settings.defaultProvider, modelId: settings.defaultModel };
		}
	} catch {}
	return undefined;
}

export const config = {
	port: Number(process.env.PORT ?? 8787),
	host: process.env.HOST ?? "127.0.0.1",
	repoRoot,
	dataDir,
	systemDb: join(dataDir, "system.sqlite"),
	workspaceDir: join(dataDir, "workspaces"),
	authFile: resolve(process.env.PI_OS_AUTH_FILE ?? defaultAuthFile()),
	webDist: join(repoRoot, "packages", "web", "dist"),
	piDefaultModel: piDefaultModel(),
	/** Secret used to sign gadget frame tokens. Persisted on first start. */
	secretFile: join(dataDir, "secret.key"),
	githubToken: process.env.GITHUB_TOKEN,
};
