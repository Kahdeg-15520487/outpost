# Moving blueprints and modules between instances

Export to a single `.outpost.json` file and import it on another Outpost:
- **One module:** ⋯ → *Export* (code only) or *Export with data* (also what it has stored).
- **One blueprint:** *Export* on its card, built-ins included.
- **In bulk:** *Blueprints → Export…* exports your blueprints and the current workspace's modules, optionally with their data.
- **Import:** *Blueprints → Import…* previews the file first. Blueprints go to your library, private unless you choose to share them. Modules go into the current workspace, owned by you.

Code and data travel. Shares, share links, Airlock grants, logs, and workspace files a module's data points to stay on the old instance; grant access again after importing.

**Version and capability checks.** Exports record the Outpost version and module runtime that produced them, and what each item needs: the server features (`ctx.storage`, `ctx.files`, …), page features (`module.api`, `module.onPresence`, …) and Airlocks (with methods) it uses. Import re-detects these from the code (a file can't skip the check by declaring less; legacy formats and runtimes require migration) and rates every item before anything is created:
- ⛔ **can't run here**: it needs a newer module runtime, or a feature this Outpost doesn't provide. It isn't imported.
- ⚠ **partly works**: it calls a Airlock or method this Outpost doesn't have (those calls fail), or the file comes from a newer outpost.
- ✓ **runs here** (with a note on which Airlock access to grant again).

The Import dialog shows the check before importing, and the import skips blocked items and reports why. `GET /api/capabilities` describes an instance; `POST /api/w/:ws/import/check` checks a file without importing it. The agent that builds modules gets the same rules: its guide's *Compatibility* section is generated from `compat.ts` (runtime version, the `ctx`/`module` members, this instance's Airlocks), and `module_write` / `module_edit` return a `compat` problem as soon as code uses something outside them. When a change to the module API breaks existing modules, bump `MODULE_RUNTIME` in `packages/server/src/modules/compat.ts`; new features are checked by name and need no bump. Add a new feature to `SERVER_FEATURES` / `CLIENT_FEATURES` and document it in the guide (a test fails if the guide misses one). Imported code runs in the same sandbox as any module. The importer checks the format, version, file paths, sizes and counts, and rejects anything else.
