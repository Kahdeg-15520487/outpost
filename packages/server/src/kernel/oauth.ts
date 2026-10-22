import type { AuthEvent, AuthPrompt } from "@earendil-works/pi-ai";
import { HttpError } from "./system-db.ts";
import { credentials, models } from "./models.ts";

/**
 * Browser-driven OAuth sign-in for model providers, on top of pi-ai's provider-owned
 * login flows (`models.login`). The flow runs on the server; the Settings page polls
 * this session for what to show (a prompt, a device code, progress) and posts answers.
 *
 * Only device-code flows are offered: they need nothing but outbound HTTPS from the
 * server, so they work the same whether the browser is on this machine or not.
 */
export const OAUTH_PROVIDERS: Record<string, { button: string }> = {
	"github-copilot": { button: "Sign in with GitHub" },
};

type PendingPrompt = { id: number; prompt: Omit<AuthPrompt, "signal">; resolve: (v: string) => void; reject: (e: Error) => void };

export type LoginView = {
	provider: string;
	status: "running" | "done" | "error" | "cancelled";
	prompt?: { id: number } & Omit<AuthPrompt, "signal">;
	deviceCode?: { userCode: string; verificationUri: string; expiresAt?: number };
	authUrl?: { url: string; instructions?: string };
	progress?: string;
	error?: string;
	startedBy: string;
};

class LoginSession {
	readonly abort = new AbortController();
	status: LoginView["status"] = "running";
	pending?: PendingPrompt;
	deviceCode?: LoginView["deviceCode"];
	authUrl?: LoginView["authUrl"];
	progress?: string;
	error?: string;
	finishedAt?: number;
	#nextPrompt = 1;

	constructor(
		readonly provider: string,
		readonly startedBy: string,
	) {}

	run() {
		const timeout = setTimeout(() => this.abort.abort(new Error("Sign-in timed out")), 15 * 60_000);
		models
			.login(this.provider, "oauth", {
				signal: this.abort.signal,
				prompt: (p) => this.#ask(p),
				notify: (e) => this.#notify(e),
			})
			.then(
				() => this.#finish("done"),
				(err: unknown) => {
					const reason = this.abort.signal.aborted ? this.abort.signal.reason : err;
					this.#finish("error", reason instanceof Error ? reason.message : String(reason));
				},
			)
			.finally(() => clearTimeout(timeout));
	}

	answer(promptId: number, value: string) {
		if (!this.pending || this.pending.id !== promptId) throw new HttpError(409, "That prompt is no longer pending");
		const p = this.pending;
		this.pending = undefined;
		p.resolve(value);
	}

	cancel() {
		if (this.status !== "running") return;
		this.status = "cancelled";
		this.pending?.reject(new Error("Sign-in cancelled"));
		this.pending = undefined;
		this.abort.abort(new Error("Sign-in cancelled"));
	}

	view(): LoginView {
		return {
			provider: this.provider,
			status: this.status,
			prompt: this.pending && { id: this.pending.id, ...this.pending.prompt },
			deviceCode: this.deviceCode,
			authUrl: this.authUrl,
			progress: this.progress,
			error: this.error,
			startedBy: this.startedBy,
		};
	}

	#ask({ signal, ...prompt }: AuthPrompt): Promise<string> {
		return new Promise((resolve, reject) => {
			const id = this.#nextPrompt++;
			this.pending = { id, prompt, resolve, reject };
			signal?.addEventListener("abort", () => {
				if (this.pending?.id === id) this.pending = undefined;
				reject(new Error("Prompt cancelled"));
			});
		});
	}

	#notify(e: AuthEvent) {
		if (e.type === "device_code") {
			this.deviceCode = { userCode: e.userCode, verificationUri: e.verificationUri, expiresAt: e.expiresInSeconds ? Date.now() + e.expiresInSeconds * 1000 : undefined };
			this.progress = "Waiting for you to approve on GitHub…";
		} else if (e.type === "auth_url") this.authUrl = { url: e.url, instructions: e.instructions };
		else this.progress = e.message;
	}

	#finish(status: "done" | "error", error?: string) {
		// A user cancel already set "cancelled"; the rejection that follows it is not an error.
		if (this.status === "running") {
			this.status = status;
			this.error = error;
		}
		this.pending = undefined;
		this.finishedAt = Date.now();
	}
}

/** At most one sign-in per provider at a time: credentials are instance-wide. */
const sessions = new Map<string, LoginSession>();

/** "@octocat" for a signed-in Copilot credential, looked up once per GitHub token. */
const accounts = new Map<string, Promise<string | undefined>>();
function githubAccount(token: string, enterpriseUrl?: string): Promise<string | undefined> {
	let p = accounts.get(token);
	if (!p) {
		const api = enterpriseUrl ? `https://api.${enterpriseUrl}` : "https://api.github.com";
		p = fetch(`${api}/user`, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json", "User-Agent": "pi-os" }, signal: AbortSignal.timeout(5000) })
			.then((r) => (r.ok ? r.json() : undefined))
			.then((u: any) => (typeof u?.login === "string" ? `@${u.login}${enterpriseUrl ? ` (${enterpriseUrl})` : ""}` : undefined))
			.catch(() => undefined);
		p.then((v) => v === undefined && accounts.delete(token));
		accounts.set(token, p);
	}
	return p;
}

function checkProvider(id: string) {
	if (!models.getProvider(id)?.auth.oauth || !OAUTH_PROVIDERS[id]) throw new HttpError(404, `No sign-in flow for ${id}`);
	const managed = credentials.managedByConfig(id);
	if (managed) throw new HttpError(409, `The ${id} key is set in ${managed}; remove it there to sign in instead.`);
}

export const oauthLogins = {
	/** What Settings shows for a provider's sign-in option; undefined if it has none. */
	async describe(provider: string) {
		const option = OAUTH_PROVIDERS[provider];
		if (!option || !models.getProvider(provider)?.auth.oauth) return undefined;
		const cred = credentials.oauth(provider);
		const account = cred && provider === "github-copilot" ? await githubAccount(cred.refresh, typeof cred.enterpriseUrl === "string" ? cred.enterpriseUrl : undefined) : undefined;
		return { button: option.button, signedIn: !!cred, account, login: oauthLogins.get(provider) };
	},
	start(provider: string, user: string): LoginView {
		checkProvider(provider);
		const current = sessions.get(provider);
		if (current?.status === "running") return current.view();
		const s = new LoginSession(provider, user);
		sessions.set(provider, s);
		s.run();
		return s.view();
	},
	get(provider: string): LoginView | undefined {
		const s = sessions.get(provider);
		// Finished sessions linger briefly so the page can show the outcome, then go.
		if (s?.finishedAt && Date.now() - s.finishedAt > 5 * 60_000) sessions.delete(provider);
		return sessions.get(provider)?.view();
	},
	answer(provider: string, promptId: number, value: string) {
		const s = sessions.get(provider);
		if (!s || s.status !== "running") throw new HttpError(409, "No sign-in in progress");
		s.answer(promptId, value);
		return s.view();
	},
	cancel(provider: string) {
		sessions.get(provider)?.cancel();
		return sessions.get(provider)?.view();
	},
	async signOut(provider: string) {
		checkProvider(provider);
		sessions.get(provider)?.cancel();
		sessions.delete(provider);
		await models.logout(provider);
	},
};
