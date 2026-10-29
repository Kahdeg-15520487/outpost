/**
 * One command for moving an old pi-os instance to Outpost.
 *
 *   pnpm run migration /path/to/old/checkout          data + config, into this instance's data dir
 *   pnpm run migration /path/to/old/data --into ./out  pick the destination explicitly
 *   pnpm run migration /path/to/old/checkout --dry-run say what would happen, change nothing
 *
 * Where things go is decided the same way the app decides at boot: OUTPOST_DATA, then `dataDir` in
 * this project's `outpost.config.json` (relative to the config file), then `<project>/data`. The old
 * root can be the old checkout (its `outpost-data/` or `data/` is found) or the old data directory
 * itself. The old config (`pi-os.config.json` / `outpost.config.json` in the old root) is converted to
 * `<project>/outpost.config.json` unless that file already exists — nothing is ever overwritten, and
 * the original stays where it is for rollback.
 */

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { migrateConfig, migrateData } from "./migrate-outpost.ts";

const HELP = `Move an old pi-os instance to Outpost.

  pnpm run migration <old-root> [options]

  <old-root>        the old checkout (its outpost-data/ or data/ is used) or the old data directory
  --into <dir>      destination data directory (default: this project's config, else ./data)
  --config <file>   the old config to convert (default: <old-root>/pi-os.config.json or outpost.config.json)
  --data-only       convert the data, leave the config alone
  --config-only     convert the config, leave the data alone
  --dry-run         print the plan and change nothing
  --help            this text

Both steps refuse to overwrite anything that already exists. The old checkout is never modified, so it
stays available for rollback; stop the old server before you migrate.`;

type Options = { root?: string; into?: string; config?: string; dataOnly: boolean; configOnly: boolean; dryRun: boolean };

function parse(argv: string[]): Options {
	const opts: Options = { dataOnly: false, configOnly: false, dryRun: false };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]!;
		const take = () => {
			const value = argv[++i];
			if (!value || value.startsWith("--")) throw new Error(`${arg} needs a path`);
			return value;
		};
		if (arg === "--help" || arg === "-h") {
			console.log(HELP);
			process.exit(0);
		} else if (arg === "--into") opts.into = take();
		else if (arg === "--config") opts.config = take();
		else if (arg === "--data-only") opts.dataOnly = true;
		else if (arg === "--config-only") opts.configOnly = true;
		else if (arg === "--dry-run") opts.dryRun = true;
		else if (arg.startsWith("-")) throw new Error(`Unknown option ${arg}. Try --help.`);
		else if (!opts.root) opts.root = arg;
		else throw new Error(`Unexpected argument ${arg} — only one old root is expected. Try --help.`);
	}
	if (opts.dataOnly && opts.configOnly) throw new Error("--data-only and --config-only contradict each other");
	return opts;
}

/** This project, resolved the way the server resolves it: INIT_CWD (where pnpm was invoked), not the script's folder. */
function project(): { baseDir: string; configPath: string; config: Record<string, any>; found: boolean } {
	const startDir = process.env.INIT_CWD ?? process.cwd();
	const configPath = resolve(startDir, process.env.OUTPOST_CONFIG || "outpost.config.json");
	const found = existsSync(configPath);
	const config = found ? (JSON.parse(readFileSync(configPath, "utf8")) as Record<string, any>) : {};
	return { baseDir: found ? dirname(configPath) : startDir, configPath, config, found };
}

/** The old data directory: the root itself, or `outpost-data/`, or `data/` inside it. */
function findSource(root: string): string | undefined {
	const candidates = [root, join(root, "outpost-data"), join(root, "data")];
	return candidates.find((dir) => existsSync(join(dir, "system.sqlite")));
}

/** The old config: what was asked for, or the two names the old instance used. */
function findConfig(root: string, explicit?: string): string | undefined {
	if (explicit) {
		if (!existsSync(explicit)) throw new Error(`No config at ${resolve(explicit)}`);
		return resolve(explicit);
	}
	return [join(root, "pi-os.config.json"), join(root, "outpost.config.json")].find((path) => existsSync(path));
}

function emptyDir(path: string): boolean {
	return existsSync(path) && statSync(path).isDirectory() && readdirSync(path).length === 0;
}

async function main() {
	const opts = parse(process.argv.slice(2));
	if (!opts.root) {
		console.log(HELP);
		throw new Error("Which instance should I migrate? Pass the old checkout or data directory.");
	}
	const root = resolve(opts.root);
	if (!existsSync(root)) throw new Error(`No such directory: ${root}`);

	const { baseDir, configPath, config, found } = project();
	const wantsData = !opts.configOnly;
	const wantsConfig = !opts.dataOnly;

	const source = findSource(root);
	const destination = resolve(opts.into || process.env.OUTPOST_DATA || (config.dataDir ? resolve(baseDir, config.dataDir) : join(baseDir, "data")));
	const oldConfig = wantsConfig ? findConfig(opts.config ? resolve(opts.config) : root, opts.config) : undefined;
	const newConfigPath = join(baseDir, "outpost.config.json");

	console.log(`old root      ${root}`);
	if (wantsData) {
		console.log(`old data      ${source ?? "(not found)"}`);
		console.log(`destination   ${destination}${opts.into ? " (--into)" : process.env.OUTPOST_DATA ? " (OUTPOST_DATA)" : config.dataDir ? ` (${found ? relative(process.cwd(), configPath) : "config"}: dataDir)` : " (default)"}`);
	}
	if (wantsConfig) console.log(`old config    ${oldConfig ?? "(none — defaults will be used)"}`);
	console.log(`new config    ${existsSync(newConfigPath) ? `${newConfigPath} already exists — will be left alone` : newConfigPath}`);

	if (wantsData && !source) {
		throw new Error(`No data to migrate: ${root} has no system.sqlite, and neither outpost-data/ nor data/ inside it does. Pass the old data directory itself.`);
	}
	if (wantsData) {
		if (existsSync(destination) && !emptyDir(destination)) {
			throw new Error(`${destination} already exists and is not empty. Choose a new path with --into, or move it away first. Nothing was changed.`);
		}
	}
	if (opts.dryRun) {
		console.log("\nDry run: nothing was changed.");
		return;
	}

	if (wantsData) {
		if (existsSync(destination)) rmSync(destination, { recursive: true }); // empty, checked above
		const result = await migrateData(source!, destination);
		console.log(`\ndata       migrated ${result.databases} database(s), ${result.missions} mission repo(s) → ${destination}`);
	}

	if (wantsConfig) {
		if (existsSync(newConfigPath)) {
			console.log(`config     ${newConfigPath} exists — left alone. Convert the old one by hand if it has settings you need.`);
		} else {
			const converted = migrateConfig(oldConfig ? JSON.parse(readFileSync(oldConfig, "utf8")) : {}) as Record<string, any>;
			// Point the new config at the data we just wrote, so starting Outpost finds it without env vars.
			const rel = relative(baseDir, destination);
			converted.dataDir = !rel.startsWith("..") && !isAbsolute(rel) ? rel || "." : destination;
			mkdirSync(dirname(newConfigPath), { recursive: true });
			writeFileSync(newConfigPath, `${JSON.stringify(converted, null, 2)}\n`, { mode: 0o600, flag: "wx" });
			console.log(`config     written → ${newConfigPath} (dataDir: ${converted.dataDir})${oldConfig ? "" : " — defaults, no old config found"}`);
		}
	}

	console.log(`\nDone. Start it with: pnpm start`);
	console.log(`  · keep the old checkout and its config until you are happy — nothing there was modified`);
	console.log(`  · the secret key was copied with the data, so existing provider credentials still decrypt`);
	console.log(`  · if you set OUTPOST_CONFIG/OUTPOST_DATA in a service definition, point them at the files above`);
}

await main();
