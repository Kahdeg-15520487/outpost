import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, type Message, type MutableModels } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { config } from "../config.ts";
import { FileCredentialStore } from "./credentials.ts";

export const credentials = new FileCredentialStore(config.authFile);

export const DEMO_MODEL = { provider: "pi-os-demo", modelId: "demo" } as const;

/**
 * A scripted model so the OS is fully usable without any API key. It recognizes a few
 * intents ("make a todo list", "make slides", "list my gadgets") and drives the real tools.
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
			const id = /"?id"?\s*[:=]\s*"?(g_[a-z0-9]+)/i.exec(text)?.[1];
			return fauxAssistantMessage([
				fauxText(
					id
						? `Done — I created the gadget \`${id}\`. It is open in the panel on the right. Ask me to change anything about it, or share it with a teammate.`
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
			return fauxAssistantMessage([fauxText(`Creating a ${name} gadget from the built-in blueprint…`), fauxToolCall("gadget_create", { name, blueprint })], {
				stopReason: "toolUse",
			});
		}
		if (/\b(list|show)\b.*\bgadgets?\b/.test(p)) {
			return fauxAssistantMessage([fauxToolCall("codemode", { code: "const r = await tools.gadget_list({}); console.log(JSON.stringify(r, null, 2));" })], {
				stopReason: "toolUse",
			});
		}
		return fauxAssistantMessage([
			fauxText(
				"I'm the **offline demo model** — I can only follow a few scripts:\n\n" +
					"- *make a todo list* / *make slides* / *make a whiteboard* / *make a tic tac toe game* / *make notes*\n" +
					"- *list my gadgets*\n\n" +
					"Pick a real model in the model menu (any provider pi supports: Anthropic, OpenAI, Google, Copilot, OpenRouter, Groq, …). " +
					"Keys come from your environment or from `" +
					config.authFile.replaceAll("\\", "/") +
					"`, and you can add one under **Settings → Providers**.",
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

export function createOsModels(): MutableModels {
	const models = createModels({ credentials, identity: { attribution: { name: "pi-os", url: "https://github.com/earendil-works/pi" } } });
	for (const provider of builtinProviders()) models.setProvider(provider);
	models.setProvider(demoProvider());
	return models;
}

export const models = createOsModels();

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
	const providers = models.getProviders();
	const result = [];
	for (const p of providers) {
		if (p.id === DEMO_MODEL.provider) continue;
		const check = await models.checkAuth(p.id).catch(() => undefined);
		result.push({ id: p.id, name: (p as any).name ?? p.id, configured: !!check && (check as any).ok !== false, models: models.getModels(p.id).length });
	}
	return result;
}

export async function defaultModel(preferred?: { provider: string; modelId: string }) {
	const available = await models.getAvailable().catch(() => []);
	const has = (r?: { provider: string; modelId: string }) => r && available.some((m) => m.provider === r.provider && m.id === r.modelId);
	if (has(preferred)) return preferred!;
	if (has(config.piDefaultModel)) return config.piDefaultModel!;
	const real = available.find((m) => m.provider !== DEMO_MODEL.provider);
	return real ? { provider: real.provider, modelId: real.id } : { ...DEMO_MODEL };
}
