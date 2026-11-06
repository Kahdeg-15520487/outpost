/**
 * Which model providers this instance offers — `models.only`.
 *
 * A self-hosted Outpost should be able to be "the key you have" rather than a directory of every provider
 * pi-ai supports: the list in Settings and the models in the picker should both be what the config allows.
 * The rule is checked directly, then end to end against a real server started with a narrowed config, so a
 * config option that was never wired up can't pass.
 *
 * Run: pnpm --filter @outpost/server test -- providers
 */
import { check, finish, freePort, until } from "./lib/harness.ts";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const { offeredProviders } = await import("../src/kernel/models.ts");

// ------------------------------------------------------------------ the rule
const builtins = [{ id: "anthropic" }, { id: "openai" }, { id: "google" }, { id: "openrouter" }, { id: "demo" }];
const ids = (r: { offered: { id: string }[] }) => r.offered.map((p) => p.id);

const all = offeredProviders(builtins, { only: [], providers: {} });
check("with no allowlist every provider is offered", ids(all).length === 5 && !all.unknownOnly.length && !all.ignored.length, ids(all));

const narrowed = offeredProviders(builtins, { only: ["openai"], providers: {} });
check("models.only offers just what it names", ids(narrowed).join() === "openai", ids(narrowed));
check("and the order follows pi's own, not the config's", offeredProviders(builtins, { only: ["google", "anthropic"], providers: {} }).offered.map((p) => p.id).join() === "anthropic,google");

check("enabled: false still hides one provider", ids(offeredProviders(builtins, { only: [], providers: { openai: { enabled: false } } })).join() === "anthropic,google,openrouter,demo");
check("the narrower rule wins over enabled: true", ids(offeredProviders(builtins, { only: ["anthropic"], providers: { openai: { enabled: true } } })).join() === "anthropic");
check("an allowlist plus enabled: false can leave nothing", ids(offeredProviders(builtins, { only: ["openai"], providers: { openai: { enabled: false } } })).length === 0);

const typo = offeredProviders(builtins, { only: ["opneai", "google"], providers: {} });
check("an id that isn't a provider is reported, not silently dropped", typo.unknownOnly.join() === "opneai" && ids(typo).join() === "google", typo.unknownOnly);
const dead = offeredProviders(builtins, { only: ["google"], providers: { openai: { apiKey: "sk-x" }, google: { apiKey: "g" }, groq: { apiKey: "q" } } });
check("a key for a provider the allowlist doesn't offer is reported", dead.ignored.join() === "openai", dead.ignored);
check("a provider configured but switched off isn't reported as ignored", !offeredProviders(builtins, { only: ["google"], providers: { openai: { enabled: false } } }).ignored.length);

// ------------------------------------------------------------------ a server that offers one provider
const dir = join(tmpdir(), `outpost-providers-${process.pid}-${Date.now()}`);
mkdirSync(dir, { recursive: true });
const port = await freePort();
writeFileSync(
	join(dir, "outpost.config.json"),
	JSON.stringify({
		dataDir: join(dir, "data"),
		models: {
			// Two providers named, one of them with a key the allowlist leaves out, so the warning path is real.
			only: ["anthropic", "google"],
			demo: true,
			ambientEnv: false,
			providers: { anthropic: { enabled: false }, openai: { apiKey: "sk-not-used" } },
		},
	}),
);
let log = "";
const child: ChildProcess = spawn(process.execPath, [join(import.meta.dirname, "..", "node_modules", "tsx", "dist", "cli.mjs"), join(import.meta.dirname, "..", "src", "main.ts")], {
	env: { ...process.env, PORT: String(port), OUTPOST_CONFIG: join(dir, "outpost.config.json"), INIT_CWD: dir },
	stdio: ["ignore", "pipe", "pipe"],
});
child.stdout!.on("data", (d) => (log += d));
child.stderr!.on("data", (d) => (log += d));
const base = `http://127.0.0.1:${port}`;
try {
	const up = await until("the narrowed server", () => fetch(`${base}/api/me`).then(() => true), 60000);
	if (!up) throw new Error(`server didn't start:\n${log}`);

	const login = await fetch(`${base}/api/auth/signup`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "narrower", password: "password123" }) });
	const cookie = login.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
	check("an account can be made on a narrowed instance", login.ok, login.status);

	const providers = await (await fetch(`${base}/api/providers`, { headers: { cookie } })).json();
	const offered = (providers.providers as { id: string }[]).map((p) => p.id).sort();
	check("Settings lists only the providers the config offers", offered.join() === "google", offered);
	check("the reply says narrowing is on, so the page can explain the short list", providers.only.join() === "anthropic,google", providers.only);
	check("a provider switched off in the config is absent even though it's allowed", !offered.includes("anthropic"), offered);

	const picker = await (await fetch(`${base}/api/models`, { headers: { cookie } })).json();
	const modelProviders = [...new Set((picker.models as { provider: string }[]).map((m) => m.provider))].sort();
	check("the picker has no models from a hidden provider", modelProviders.every((p) => p === "google" || p === "outpost-demo"), modelProviders);
	check("the demo model is still offered (it isn't a provider in the allowlist's terms)", modelProviders.includes("outpost-demo"), modelProviders);

	const key = await fetch(`${base}/api/providers/openai/key`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ key: "sk-x" }) });
	check("a hidden provider can't be given a key over the API either", key.status === 404, key.status);

	check("the server warns about the key it will ignore", /models\.providers\.openai configured, but models\.only doesn't offer it — ignored/.test(log), log.split("\n").filter((l) => /models\./.test(l)));
} finally {
	child.kill("SIGKILL");
	await new Promise((r) => child.on("exit", r));
}

await finish();
