# Upgrading to Outpost

Outpost 0.8 is a **breaking rename**, not an alias layer. Module runtime v2 uses `module` in the browser and `ctx.airlocks` on the server. Agent tools use `module_*`, `airlock_*` and `file_share_with_module`. Agent-team projects are now missions.

## New names

| Surface | Outpost name |
| --- | --- |
| Packages | `outpost`, `@outpost/server`, `@outpost/web` |
| Configuration | `outpost.config.json`, `outpost.config.example.json` |
| Environment | `OUTPOST_CONFIG`, `OUTPOST_DATA`, `OUTPOST_SECRET`, `OUTPOST_CHROME`, `OUTPOST_PREVIEW_BIND`, `OUTPOST_PREVIEW_PORTS` |
| Built-in access config | `airlocks.github.token` |
| REST | `/api/modules`, `/api/w/:ws/modules`, `/api/w/:ws/missions`, `/api/airlocks` |
| Browser links | `#/w/:ws/modules/:id`, `#/w/:ws/missions/:id`, `#/modules/:id`; chat selection uses `?module=:id` |
| Agent extension IDs | `outpost`, `outpost-mission` |
| Durable document namespace | `outpost.*` |
| Repository run configuration | `.outpost/mission.json` |
| Export files | `*.outpost.json`, format `outpost/bundle`, bundle v2, runtime v2 |
| Session cookie | `outpost_session` |
| Browser preferences | `outpost.*` |

Old routes, tool names, config keys and exports are not accepted by the new runtime. Users sign in again after deployment; local browser layout preferences reset. Stable data IDs and share-link tokens do not change. Generate new links from the UI. Re-export modules from the migrated instance to obtain new-format exports.

`pi-durable`, `pi-ai`, their `pi.*` storage records, third-party licenses and APIs retain their names. Azure DevOps and Jira still have **projects**. User-written chat text, uploaded files, module data, names and goals are historical/user content, not branding labels to rewrite.

## Offline migration

1. **Stop the old server and its agent processes.** Do not run both versions against one data directory. Keep the old checkout and config for rollback.
2. Install this version's dependencies with `pnpm install --frozen-lockfile`.
3. Run the migration into a **new destination outside the original data directory**. Use absolute paths; pnpm executes this command from `packages/server`:

   ```sh
   pnpm --filter @outpost/server exec tsx scripts/migrate-outpost.ts /absolute/old-data /absolute/new-data
   pnpm --filter @outpost/server exec tsx scripts/migrate-config.ts /absolute/old-config.json /absolute/outpost.config.json
   ```

   An optional third data argument specifies the final deployed data path if the copy will be moved again. Leave it out when running directly from the destination. If you move a prepared copy, call the migration utility's `relocateRepositories(newLocation, previousLocation)` before starting it so git worktree pointers reach their new repositories.

4. Set `OUTPOST_DATA` (or `dataDir` in the new config) to the converted directory. Replace old environment-variable names in the service definition. Preserve the **same secret key**, including the value of an environment-supplied secret, or existing encrypted credentials cannot be read.
5. Start with `pnpm start`. Sign in, open existing chats and modules, inspect missions and permissions, and verify that configured providers remain available. **Keep the original data and config** until you accept the migration.

The utility copies data before changing it, uses SQLite's backup API to include WAL contents, and refuses an existing destination. It converts the system schema, preserves document revision sequence numbers, materializes delta histories before converting them, and checks SQLite integrity. Module source conversion edits JavaScript API references rather than replacing words in app data or strings. Built-in blueprints refresh at startup; saved blueprints retain their code with API references converted.

Mission repositories move into `missions/`. The utility repairs both ends of linked-worktree paths and commits only the run-manifest rename in each checkout and branch. Unrelated staged and unstaged work stays out of that commit. Your configured git identity is used for these migration commits; set `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`, `GIT_COMMITTER_NAME` and `GIT_COMMITTER_EMAIL` explicitly if needed. Historical commits remain intact. Revisiting a pre-migration commit may require migrating its run manifest before running it.

The copy omits reinstallable `node_modules` directories and clears install stamps. Other files, secrets, uploads, repository history and application data are copied. Agent environments may need their package dependencies installed again; previews and checks with an install command do this on next use. After a successful conversion, `outpost-migration.json` records its source, final location and time. A failed run leaves a partial destination for inspection; do not deploy it.

### Docker

The compose project, service, image and named volume are now `outpost`, `outpost:0.8.0` and `outpost-data`. Renaming a compose volume does **not** copy its contents. Stop the old deployment, migrate a copy of the old volume's files using the procedure above, and restore the converted files into the new volume (uid 10001) before starting Outpost. Keep the old volume for rollback.

## Rollback

Stop Outpost. Restore the old checkout, config, environment names and **original data directory together**. Never point the old application at migrated data, or Outpost at the old data. Outpost refuses an unmigrated system database rather than silently creating an empty module index.
