# Blueprints

A blueprint is an app template: files (`index.html`, `server.js`, assets) that become a private
module when somebody uses it. What it is *not* is a single frozen snapshot — a blueprint has an
identity and a series of versions, so improving one moves it forward instead of spawning a
near-identically named copy.

## Identity, versions, changes

```
Blueprint  bp_9fba…            the identity: name, description, visibility, author
Version    1, 2, 3 …           the code at one point, with a one-line changelog
Module     built from v2       knows where it came from, and can see there is a v3
```

- **Publishing from a module built on a blueprint appends a version.** The name stays; the changelog
  says what changed; modules on older versions are told there is a newer one.
- **A built-in blueprint forks instead.** Built-ins are re-seeded from `packages/server/blueprints` at
  every boot, so a version published on top of one would be overwritten. Publishing from a module
  made from a built-in creates a blueprint of your own, recording which version it came from.
- **`fork: true` starts a new identity on purpose** when you want a separate product rather than the
  next version of the same one.
- **The changelog is a field, not prose.** One line per version ("cover image field + keyboard nav").
  `description` stays a catalogue blurb — it is no longer where the diff goes.

## Reading a blueprint

The inspector opens from the Blueprints page: nothing is created, nothing runs, no clone is made.

| Tab | What it shows |
|---|---|
| Overview | current changelog, description, compat report, file list with sizes, and the modules sitting on it |
| Code | the source of each file, with a copy button |
| API | the server methods the blueprint declares, and which are read-only |
| Used by | every module built from it, at which version |
| History | every version with its changelog and date, and the file-level diff against the previous one (or any chosen version) |

`Compare` (in History, and the `blueprint_diff` tool) reports per-path additions, removals and size
changes plus which API methods appeared or disappeared — the answer to "what's the difference
between these two?" without 22 KB of HTML diffing by hand. A comparison is between two *specific*
versions, so it takes version ids, not a root.

**Which version you get.** Any id a caller holds resolves to the version they mean: a root id (`bp_…`
naming the blueprint) gives the current version, a version id gives that version, and `version: 1`
asks explicitly. Because a first version's id *is* its root, an id can be both — that case reads as
the root, which is what "read the blueprint" means. The answer says which version it answered with
(`requested`) and which one is current (`current`), and the inspector warns when you are looking at
an older version, because publishing from a stale copy would move the blueprint backwards.

The same information is available to the agent as `blueprint_read` and `blueprint_diff`, so questions
like "does this template have a title image?" cost a read, not a module.

## Drafts

`module_draft` (or **Edit a draft** in the inspector) creates a working copy from a blueprint:

- it is reachable by id — read, edit, call, screenshot — exactly like a module;
- it is **absent from every list**: the sidebar, the home page, agent tool results;
- it is badged as a draft where it appears;
- `module_delete` throws it away.

That is the shape the old loop was missing. An agent that wants to change a template no longer leaves
a permanent module named after its investigation.

## Updating a module

A module remembers the version it was built from. **Module → Blueprint** shows:

- which blueprint and version it came from, with a link to the inspector;
- which files differ from the blueprint's current version;
- **Update to vN** — takes the blueprint's files. Local edits are replaced; the confirm lists the
  files that will be lost. This is the direction people ask for: fix the cover on your deck, move the
  module onto the new template.
- **Publish these changes as vN+1** — the other direction, with the changelog field right there.

## Rolling out

Published a version and want everyone on it? The inspector's Overview tab offers **Move them to vN**
for every module on the blueprint; `blueprint_update_modules` does the same from a chat, with an
optional list of module ids. Each module comes back with a status — `updated` (with `from` and `to`),
`adopted`, `skipped` (with the reason) or `missing` — and the response reports the version it actually
applied. A list you asked for explicitly that cannot be satisfied is an error naming why, not an
empty success.

Drafts are working copies, not the user's modules: they are counted separately, they are not in
"used by", and a rollout leaves them alone unless `includeDrafts` asks for them.

## Adopting: rescuing a module whose blueprint is gone

Deleting a blueprint used to strand its modules: they kept running, and nothing could ever update
them again. Now deleting a blueprint that modules use is refused (the error names them) unless it is
forced, and stranded modules can be rescued in place:

- **In the module's Blueprint card**, an orphan says so and offers a blueprint to adopt.
- **`module_set_blueprint(module, blueprint)`** takes the blueprint's code and keeps the module's own
  storage, its file shares, its links and its id — so shares and open tabs survive, which is exactly
  what "create a new module and copy the data across" destroys.
- **`blueprint_update_modules({blueprint, modules, adopt: true})`** does the same for a list.
- `GET /api/w/:ws/modules/orphans` lists the modules whose blueprint no longer exists.

## Tools the agent uses

| Tool | What it does |
|---|---|
| `blueprint_list` | current version of each blueprint, with `version`, `changelog`, `updatedAt`, `visibility`, `modulesUsing` |
| `blueprint_read` | files, sizes, source (with `path`), declared API, versions, users — no module created; any id resolves, `version:` asks explicitly |
| `blueprint_diff` | file-level and API-level comparison of two versions |
| `blueprint_publish` | appends the next version (or forks), requires a `changelog`, returns a compat report |
| `blueprint_update_modules` | moves modules onto the current version, per-module status, `adopt` for a different or deleted origin |
| `blueprint_delete` | removes a blueprint, or one version of it |
| `module_draft` | a working copy that is not one of the user's modules |
| `module_delete` | deletes a module, its data and its shares |
| `module_set_blueprint` | re-homes a module onto a blueprint, keeping its data and shares |

`OUTPOST_GUIDE` teaches this loop in the system prompt: look before you touch, improve in a draft,
publish with a changelog, then roll out.

## Vendored files

A module may ship somebody else's library — PptxGenJS, a charting bundle, a UMD shim. Those files are
full of legitimate Node-isms (`module.exports` behind a UMD guard) that say nothing about how the
module uses *our* API, and scanning them turned every edit of a deck into a blocking "won't run"
warning that contradicted publish-time.

Feature detection now skips a file when any of these hold: it carries a `/* outpost:vendor */` banner,
its name looks minified (`.bundle.js`, `.min.js`, `.vendor.js`, or it lives under `vendor/`,
`third-party/`, `lib/`), it is larger than 120 KB, or its first line is longer than 5,000 characters.
Skipped files are named in the compat notes ("shipped as-is, not scanned"), so the exemption is
visible rather than silent. Writing a file and publishing a blueprint now run the *same* assessment,
so they cannot disagree about the same code.

## Big files

`module_read` returns a file whole when it is small; for anything larger it returns the slice you asked
for (`offset`, `length`, up to 200 KB) along with `bytes`, `truncated` and `nextOffset`. Silently
returning the first 49 characters of a 460 KB bundle made the file look like a one-line stub.

## Limits

- **Versions are immutable.** Publishing always appends; nothing rewrites history. Editing an old
  version means publishing a new one from a module on it.
- **No live preview of a blueprint.** The inspector shows code, not a running app: running it means a
  module, so the honest path is a draft (hidden) or **Use** (a real module).
- **Local edits are replaced on update.** There is no three-way merge; the confirm lists the files.
- **Adoption replaces code, not data.** Storage, shares and links survive; module *source* files are
  the blueprint's afterwards, so a file you added to the module goes away.
- **`file_write` does not overwrite by name.** A second write with the same name adds a file and warns
  with the id of the existing one; pass `replace: true` to update it in place instead.
- **Rollout is all-or-per-module.** There is no "update modules that have not diverged" filter.
- **Built-ins cannot be deleted or written over** — they are files on disk, re-seeded at boot.
- **Visibility is per blueprint identity**, set at publish time; changing it means publishing again.
