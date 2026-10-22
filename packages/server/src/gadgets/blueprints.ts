import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { blueprints } from "../kernel/system-db.ts";

const dir = fileURLToPath(new URL("../../blueprints", import.meta.url));

function walk(root: string, at = root): Record<string, string> {
	const files: Record<string, string> = {};
	for (const name of readdirSync(at)) {
		const full = join(at, name);
		if (statSync(full).isDirectory()) Object.assign(files, walk(root, full));
		else if (name !== "meta.json") files[relative(root, full).replaceAll("\\", "/")] = readFileSync(full, "utf8");
	}
	return files;
}

/** Built-in blueprints ship as folders under packages/server/blueprints and are upserted at startup. */
export function installBuiltinBlueprints() {
	if (!existsSync(dir)) return;
	for (const name of readdirSync(dir)) {
		const root = join(dir, name);
		if (!statSync(root).isDirectory()) continue;
		const meta = JSON.parse(readFileSync(join(root, "meta.json"), "utf8"));
		const intro = { headline: meta.headline, intro: meta.intro, suggestions: meta.suggestions };
		blueprints.upsert({ id: `bp_${name}`, name: meta.name, description: meta.description, icon: meta.icon ?? "◆", authorId: null, visibility: "public", files: walk(root), createdAt: 0, intro });
	}
}
