/**
 * Runs every test suite, each in its own process (own temp data dir, own server), and prints a summary.
 *   pnpm test                 build + typecheck + all suites (from the repo root)
 *   pnpm --filter @pi-os/server test -- build ui    just those suites
 * Suites that need a browser skip themselves when none is installed.
 */
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SUITES: { name: string; file: string; what: string }[] = [
	{ name: "teams", file: "teams.ts", what: "backlog, approval, model controls, agent sandbox" },
	{ name: "build", file: "build.ts", what: "M4 scheduler + M5 preview" },
	{ name: "preview", file: "preview.ts", what: "preview.ports: the published range that reaches an app on loopback" },
	{ name: "gates", file: "gates.ts", what: "blocking questions + readiness, feedback → pending items → approval" },
	{ name: "quality", file: "quality.ts", what: "M2 gates, story briefs, tests before review/merge, definition of done, retrospective, restart" },
	{ name: "transfer", file: "transfer.ts", what: "export/import of blueprints and gadgets between two instances" },
	{ name: "home", file: "home.ts", what: "workspace homepage: away digest, seen boundary, summaries" },
	{ name: "smoke", file: "smoke.ts", what: "HTTP/WS end to end: chat, gadgets, sharing, gatekeepers, files, blueprints" },
	{ name: "render", file: "render-check.ts", what: "gadget_screenshot (browser)" },
	{ name: "ui", file: "ui.ts", what: "web app in a browser: home page, chat, menus, picker, project page" },
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
	if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
	results.push({ name: s.name, ok: code === 0, ms: Date.now() - t, summary: last || (code === 0 ? "ok" : `exit ${code}`) });
}

console.log("\n━━ summary");
for (const r of results) console.log(`  ${r.ok ? "✓" : "✗"} ${r.name.padEnd(8)} ${(r.ms / 1000).toFixed(1).padStart(6)}s  ${r.summary}`);
const bad = results.filter((r) => !r.ok);
console.log(bad.length ? `\n${bad.length} suite(s) failed: ${bad.map((r) => r.name).join(", ")}` : "\nAll suites passed.");
process.exit(bad.length ? 1 : 0);
