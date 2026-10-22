import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * pi-os reads exactly one configuration file: `pi-os.config.json` in the directory you started it
 * from, or the file named by `PI_OS_CONFIG`. Nothing is read from other tools' config (e.g. ~/.pi).
 *
 * Secret values may be literals or `$VAR` / `${VAR}` references to environment variables, so the
 * file itself can be committed without secrets. See pi-os.config.example.json.
 */
export type ProviderConfig = {
	/** API key: a literal, or "$ENV_VAR". */
	apiKey?: string;
	/** Provider-scoped settings passed with the credential, e.g. AZURE_OPENAI_BASE_URL. Values may use $VAR too. */
	env?: Record<string, string>;
	/** false hides the provider entirely. */
	enabled?: boolean;
};
export type PiOsConfigFile = {
	server?: { host?: string; port?: number };
	/** Relative paths resolve against the config file's directory. */
	dataDir?: string;
	models?: {
		/** "provider/modelId" for new chats, unless a workspace overrides it. */
		default?: string;
		/** Per-provider keys and settings, keyed by pi provider id (anthropic, openai, google, openrouter, …). */
		providers?: Record<string, ProviderConfig>;
		/** Let providers also pick up their standard env vars (ANTHROPIC_API_KEY, …). Default true. */
		ambientEnv?: boolean;
		/** Offer the offline scripted demo model. Default true. */
		demo?: boolean;
	};
	gatekeepers?: {
		github?: { token?: string };
	};
	files?: {
		/** Largest single upload, in MB. Default 100. */
		maxUploadMB?: number;
	};
};

const repoRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
// pnpm runs package scripts inside the package; INIT_CWD is where you actually ran the command.
const startDir = process.env.INIT_CWD ?? process.cwd();
const configPath = resolve(startDir, process.env.PI_OS_CONFIG ?? "pi-os.config.json");

class ConfigError extends Error {}

function readConfigFile(): { file: PiOsConfigFile; found: boolean } {
	if (!existsSync(configPath)) {
		if (process.env.PI_OS_CONFIG) throw new ConfigError(`PI_OS_CONFIG points to ${configPath}, which does not exist`);
		return { file: {}, found: false };
	}
	try {
		return { file: JSON.parse(readFileSync(configPath, "utf8")), found: true };
	} catch (error) {
		throw new ConfigError(`Cannot parse ${configPath}: ${(error as Error).message}`);
	}
}

/** "$VAR" / "${VAR}" → process.env.VAR; anything else is a literal. Missing vars resolve to undefined. */
export function resolveSecret(value: string | undefined): { value?: string; from: string } {
	if (value === undefined || value === "") return { from: "unset" };
	const ref = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/.exec(value.trim());
	if (ref) return { value: process.env[ref[1]!] || undefined, from: `$${ref[1]}` };
	return { value, from: "literal" };
}

const { file, found } = (() => {
	try {
		return readConfigFile();
	} catch (error) {
		console.error(`pi-os: ${(error as Error).message}`);
		process.exit(1);
	}
})();

const baseDir = found ? dirname(configPath) : startDir;
const dataDir = resolve(process.env.PI_OS_DATA ?? (file.dataDir ? (isAbsolute(file.dataDir) ? file.dataDir : join(baseDir, file.dataDir)) : join(baseDir, "data")));
mkdirSync(join(dataDir, "workspaces"), { recursive: true });

const defaultModel = (() => {
	const raw = file.models?.default;
	if (!raw) return undefined;
	const [provider, ...rest] = raw.split("/");
	if (!provider || !rest.length) {
		console.warn(`pi-os: models.default must be "provider/modelId", got "${raw}" — ignoring`);
		return undefined;
	}
	return { provider, modelId: rest.join("/") };
})();

/** The secret that signs frame tokens and encrypts stored credentials. PI_OS_SECRET (hex/base64, 32 bytes) wins over the generated file. */
const secretFile = join(dataDir, "secret.key");
const secret: Buffer = (() => {
	if (process.env.PI_OS_SECRET) {
		const s = process.env.PI_OS_SECRET;
		const buf = /^[0-9a-f]{64}$/i.test(s) ? Buffer.from(s, "hex") : Buffer.from(s, "base64");
		if (buf.length !== 32) throw new Error("PI_OS_SECRET must be 32 bytes (64 hex chars or base64)");
		return buf;
	}
	if (existsSync(secretFile)) return readFileSync(secretFile);
	const value = randomBytes(32);
	writeFileSync(secretFile, value, { mode: 0o600 });
	return value;
})();

export const config = {
	configPath,
	configFound: found,
	file,
	port: Number(process.env.PORT ?? file.server?.port ?? 8787),
	host: process.env.HOST ?? file.server?.host ?? "127.0.0.1",
	repoRoot,
	dataDir,
	systemDb: join(dataDir, "system.sqlite"),
	workspaceDir: join(dataDir, "workspaces"),
	/** Keys entered in Settings, AES-256-GCM encrypted with `secret`. */
	credentialsFile: join(dataDir, "credentials.enc.json"),
	webDist: join(repoRoot, "packages", "web", "dist"),
	defaultModel,
	providers: file.models?.providers ?? {},
	ambientEnv: file.models?.ambientEnv ?? true,
	demoModel: file.models?.demo ?? true,
	githubToken: () => resolveSecret(file.gatekeepers?.github?.token).value,
	maxUploadBytes: Math.round((file.files?.maxUploadMB ?? 100) * (1 << 20)),
	secret,
};
