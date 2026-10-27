/** One-time config conversion. Never overwrites either input or an existing destination. */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { migrateConfig } from "./migrate-outpost.ts";
const [from, to] = process.argv.slice(2);
if (!from || !to) throw new Error("Usage: migrate-config.ts <old-config> <outpost.config.json>");
if (resolve(from) === resolve(to) || existsSync(to)) throw new Error("Choose a new destination; the original config must remain available for rollback");
const config = migrateConfig(JSON.parse(readFileSync(from, "utf8")));
writeFileSync(to, JSON.stringify(config, null, 2) + "\n", { mode: 0o600, flag: "wx" });
console.log(`Config converted to ${resolve(to)} (no secret values logged). Update OUTPOST_CONFIG/OUTPOST_* in your service environment.`);
