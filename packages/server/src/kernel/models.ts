import { createModels, defaultProviderAuthContext, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, type Message, type MutableModels } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { config } from "../config.ts";
import { OutpostCredentialStore } from "./credentials.ts";

export const credentials = new OutpostCredentialStore();

export const DEMO_MODEL = { provider: "outpost-demo", modelId: "demo" } as const;

/**
 * A scripted model so the OS is fully usable without any API key. It recognizes a few
 * intents ("make a todo list", "make slides", "list my modules") and drives the real tools.
 */
function demoProvider() {
	const faux = fauxProvider({
		provider: DEMO_MODEL.provider,
		models: [{ id: DEMO_MODEL.modelId, name: "Demo (offline, scripted)", contextWindow: 128_000, maxTokens: 8192 }],
		tokensPerSecond: 400,
	});
	const respond = (messages: readonly Message[]) => {
		const last = messages.at(-1);
		if (last?.role === "toolResult") {
			const text = last.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
			const id = /"?id"?\s*[:=]\s*"?(mod_[a-z0-9]+)/i.exec(text)?.[1];
			return fauxAssistantMessage([
				fauxText(
					id
						? `Done — I created the module \`${id}\`. It is open in the panel on the right. Ask me to change anything about it, or share it with a teammate.`
						: `Here is what I found:\n\n${text.slice(0, 1500)}`,
				),
			]);
		}
		const user = [...messages].reverse().find((m) => m.role === "user");
		const prompt = (typeof user?.content === "string" ? user.content : user?.content.map((c) => (c.type === "text" ? c.text : "")).join(" ")) ?? "";
		const p = prompt.toLowerCase();
		const blueprint = p.includes("slide")
			? "bp_slides"
			: p.includes("whiteboard") || p.includes("draw")
				? "bp_whiteboard"
				: p.includes("todo") || p.includes("task")
					? "bp_todo"
					: p.includes("tic") || p.includes("game")
						? "bp_tictactoe"
						: p.includes("note")
							? "bp_notes"
							: undefined;
		if (/\b(make|create|build|new)\b/.test(p) && blueprint) {
			const name = blueprint.replace("bp_", "").replace(/^./, (c) => c.toUpperCase());
			return fauxAssistantMessage([fauxText(`Creating a ${name} module from the built-in blueprint…`), fauxToolCall("module_create", { name, blueprint })], {
				stopReason: "toolUse",
			});
		}
		if (/\b(list|show)\b.*\bmodules?\b/.test(p)) {
			return fauxAssistantMessage([fauxToolCall("codemode", { code: "const r = await tools.module_list({}); console.log(JSON.stringify(r, null, 2));" })], {
				stopReason: "toolUse",
			});
		}
		return fauxAssistantMessage([
			fauxText(
				"I'm the **offline demo model** — I can only follow a few scripts:\n\n" +
					"- *make a todo list* / *make slides* / *make a whiteboard* / *make a tic tac toe game* / *make notes*\n" +
					"- *list my modules*\n\n" +
					"Pick a real model in the model menu (any provider pi supports: Anthropic, OpenAI, Google, OpenRouter, Groq, …). " +
					"Configure keys in `outpost.config.json` (`models.providers`), under **Settings → Model providers**, or with the provider's standard env var.",
			),
		]);
	};
	// Every response is computed from the transcript, so keep the queue topped up.
	const step = (context: { messages: Message[] }) => {
		faux.appendResponses([step as never]);
		return respond(context.messages);
	};
	faux.setResponses([step as never]);
	return faux.provider;
}

/** With `models.ambientEnv: false`, providers see no env vars or ambient files (AWS profiles, gcloud ADC): only outpost credentials. */
const isolatedAuthContext = { env: async () => undefined, fileExists: async () => false };

export function createOutpostModels(): MutableModels {
	const models = createModels({
		credentials,
		authContext: config.ambientEnv ? defaultProviderAuthContext() : isolatedAuthContext,
		identity: { attribution: { name: "Outpost", url: "https://github.com/Kahdeg-15520487/outpost" } },
	});
	const builtins = builtinProviders();
	for (const provider of builtins) if (config.providers[provider.id]?.enabled !== false) models.setProvider(provider);
	if (config.demoModel) models.setProvider(demoProvider());
	const unknown = Object.keys(config.providers).filter((id) => !builtins.some((p) => p.id === id));
	if (unknown.length) console.warn(`outpost: unknown provider id(s) in config: ${unknown.join(", ")}. Known: ${builtins.map((p) => p.id).join(", ")}`);
	for (const [id, entry] of Object.entries(config.providers)) {
		const ref = /^\$\{?(\w+)\}?$/.exec(entry.apiKey ?? "")?.[1];
		if (ref && !process.env[ref]) console.warn(`outpost: models.providers.${id}.apiKey references $${ref}, which is not set`);
	}
	return models;
}

export const models = createOutpostModels();

export async function listModels() {
	const available = await models.getAvailable().catch(() => [] as const);
	return available.map((m) => ({
		provider: m.provider,
		id: m.id,
		name: m.name,
		reasoning: m.reasoning,
		contextWindow: m.contextWindow,
		vision: m.input.includes("image"),
	}));
}

export async function listProviders() {
	const result = [];
	for (const p of models.getProviders()) {
		if (p.id === DEMO_MODEL.provider) continue;
		const managed = credentials.managedByConfig(p.id);
		const check = await models.checkAuth(p.id).catch(() => undefined);
		const source = managed ?? (credentials.oauth(p.id) ? "OAuth sign-in (encrypted store)" : credentials.stored(p.id) ? "Settings (encrypted store)" : check?.source ? `environment (${check.source})` : check ? "environment" : undefined);
		result.push({
			id: p.id,
			name: p.name ?? p.id,
			configured: !!check,
			source,
			/** Keys set in the config file can't be changed or removed from the UI. */
			editable: !managed,
			stored: credentials.stored(p.id),
			oauthOnly: !p.auth.apiKey,
			models: models.getModels(p.id).length,
		});
	}
	return result;
}

type Ref = { provider: string; modelId: string };

/** Whether a user's model picker (provider → shown model ids; unlisted providers show all) includes this model. */
export const pickerShows = (picker: Record<string, string[]> | undefined, r: Ref) => !picker?.[r.provider] || picker[r.provider]!.includes(r.modelId);

/**
 * The model a new chat gets. Prefers models in the user's picker, so the default is never
 * one they hid: workspace default → config default → first shown model; only then hidden ones.
 */
export async function defaultModel(preferred?: Ref, picker?: Record<string, string[]>): Promise<Ref> {
	const available = (await models.getAvailable().catch(() => [])).map((m) => ({ provider: m.provider, modelId: m.id }));
	const has = (r?: Ref): r is Ref => !!r && available.some((m) => m.provider === r.provider && m.modelId === r.modelId);
	const shown = (r: Ref) => pickerShows(picker, r);
	const real = available.filter((m) => m.provider !== DEMO_MODEL.provider);
	for (const r of [preferred, config.defaultModel]) if (has(r) && shown(r)) return r;
	const firstShown = real.find(shown);
	if (firstShown) return firstShown;
	if (shown(DEMO_MODEL) && !real.length) return { ...DEMO_MODEL };
	for (const r of [preferred, config.defaultModel]) if (has(r)) return r;
	return real[0] ?? { ...DEMO_MODEL };
}
