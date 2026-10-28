/**
 * Runs every test suite, each in its own process (own temp data dir, own server), and prints a summary.
 *   pnpm test                 build + typecheck + all suites (from the repo root)
 *   pnpm --filter @outpost/server test -- build ui    just those suites
 * Suites that need a browser skip themselves when none is installed.
 */
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SUITES: { name: string; file: string; what: string }[] = [
	{ name: "migration", file: "migration.ts", what: "offline Outpost conversion: SQLite history, capabilities, code, git worktrees, preserved user data" },
	{ name: "teams", file: "teams.ts", what: "backlog, approval, model controls, agent sandbox" },
	{ name: "build", file: "build.ts", what: "M4 scheduler + M5 preview" },
	{ name: "preview", file: "preview.ts", what: "preview.ports: the published range that reaches an app on loopback" },
	{ name: "conflicts", file: "conflicts.ts", what: "generated files, line endings, repo identity, overlapping areas" },
	{ name: "connectors", file: "connectors.ts", what: "MCP servers and OpenAPI REST APIs as Airlocks: discovery, secrets, capabilities, approvals" },
	{ name: "azure-devops", file: "azure-devops.ts", what: "the Azure DevOps connector against a stand-in for dev.azure.com" },
	{ name: "github", file: "github.ts", what: "the GitHub repository connector against a stand-in for api.github.com" },
	{ name: "gates", file: "gates.ts", what: "blocking questions + readiness, feedback → pending items → approval" },
	{ name: "quality", file: "quality.ts", what: "M2 gates, story briefs, tests before review/merge, definition of done, retrospective, restart" },
	{ name: "transfer", file: "transfer.ts", what: "export/import of blueprints and modules between two instances" },
	{ name: "home", file: "home.ts", what: "workspace homepage: away digest, seen boundary, summaries" },
	{ name: "smoke", file: "smoke.ts", what: "HTTP/WS end to end: chat, modules, sharing, airlocks, files, blueprints" },
	{ name: "render", file: "render-check.ts", what: "module_screenshot (browser)" },
	{ name: "ui", file: "ui.ts", what: "web app in a browser: home page, chat, menus, picker, mission page" },
	{ name: "offline", file: "offline.ts", what: "backend disconnect: banner, toast, failed actions, recovery" },
	{ name: "module-chat", file: "module-chat.ts", what: "durable chat/module links, legacy recovery, sidebar highlighting and Open module navigation" },
	{ name: "artifacts", file: "artifacts.ts", what: "artifacts in chat: embed markers, table typing and sorting, chart series, jq-lite queries, Markdown write-back" },
	{ name: "parse", file: "parse.ts", what: "ingestion: docx, xlsx, pptx, pdf and archives parsed with libraries, design kept, conversions, caches" },
];

const here = dirname(fileURLToPath(import.meta.url));
const tsx = join(here, "..", "node_modules", "tsx", "dist", "cli.mjs");
const wanted = process.argv.slice(2).filter((a) => a !== "--");
const run = wanted.length ? SUITES.filter((s) => wanted.includes(s.name)) : SUITES;
if (wanted.length && run.length !== wanted.length) {
	console.error(`Unknown suite(s): ${wanted.filter((w) => !SUITES.some((s) => s.name === w)).join(", ")}. Known: ${SUITES.map((s) => s.name).join(", ")}`);
	process.exit(2);
}

const results: { name: string; ok: boolean; ms: number; summary: string }[] = [];
for (const s of run) {
	console.log(`\n━━ ${s.name} — ${s.what}`);
	const t = Date.now();
	const { code, last, dir } = await new Promise<{ code: number | null; last: string; dir?: string }>((resolve) => {
		let last = "";
		let dir: string | undefined;
		const child = spawn(process.execPath, [tsx, join(here, s.file)], { cwd: join(here, ".."), stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, FORCE_COLOR: "0" } });
		const timer = setTimeout(() => child.kill(), 10 * 60_000);
		const pipe = (out: NodeJS.WriteStream) => (d: Buffer) => {
			const text = d.toString();
			dir ??= /\[harness\] dir (.+)/.exec(text)?.[1]?.trim();
			out.write(text);
			const lines = text.split("\n").filter((l) => /ALL GOOD|failed|skipped/.test(l));
			if (lines.length) last = lines.at(-1)!.trim();
		};
		child.stdout.on("data", pipe(process.stdout));
		child.stderr.on("data", pipe(process.stderr));
		child.on("close", (code) => (clearTimeout(timer), resolve({ code, last, dir })));
	});
	// Best effort: on Windows a process the suite started can still hold a file for a moment; a leftover temp dir is harmless.
	if (dir) {
		try {
			rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
		} catch (e) {
			console.warn(`  (couldn't remove ${dir}: ${(e as Error).message.split("\n")[0]})`);
		}
	}
	results.push({ name: s.name, ok: code === 0, ms: Date.now() - t, summary: last || (code === 0 ? "ok" : `exit ${code}`) });
}

console.log("\n━━ summary");
const width = Math.max(...results.map((r) => r.name.length));
for (const r of results) console.log(`  ${r.ok ? "✓" : "✗"} ${r.name.padEnd(width)} ${(r.ms / 1000).toFixed(1).padStart(6)}s  ${r.summary}`);
const bad = results.filter((r) => !r.ok);
console.log(bad.length ? `\n${bad.length} suite(s) failed: ${bad.map((r) => r.name).join(", ")}` : "\nAll suites passed.");
process.exit(bad.length ? 1 : 0);
