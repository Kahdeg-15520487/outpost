# How Outpost maps onto pi-durable

## How it maps onto pi-durable

| Concept | pi-durable primitive |
|---|---|
| Workspace | one `Harness` over `openNodeSqliteStorage(data/workspaces/<id>.sqlite)` |
| Chat | an ownerless `Conversation`. Messages are submitted with an `outpost.user` entry carrying the author. Steering and follow-ups use `whenBusy` |
| Live transcript | `watchEvents()` streamed over WebSocket to every member watching |
| Agent tools | one `outpost` extension (module, blueprint, Airlock and subagent tools, plus prompt sections), along with `createCodemodeExtension` |
| Subagents | a task-owned child conversation (`ownership: { kind: "task" }`), `replay: "safe"` |
| Module code / storage / logs | session document families `outpost.module.source` / `.state` / `.logs` |
| Grants, access requests, approvals, audit | session documents `outpost.grants`, `outpost.approvals`, `outpost.audit` |
| Telling the agent that something happened (grant, approval) | a `write` submission whose entry carries a model-visible message, placed at the next turn boundary |
| Crash recovery | `harness.resume()` on start. Every workspace is reopened at boot |

## What goes over the wire

The web app is one bundle (about 560 kB of JavaScript, 100 kB of CSS) plus lazily loaded chunks; the
Mermaid renderer (`pele`, 694 kB) is its own chunk, fetched the first time a diagram appears and never
if nobody writes one.

Text responses are compressed: brotli when the client offers it, gzip otherwise, cached per file by
mtime — assets are content-hashed and immutable, so each one is compressed once per process (brotli
takes the entry bundle from 563 kB to 159 kB). Already-compressed formats (woff2, png, zip) are not
re-compressed. JSON responses over 1 kB are compressed too, which matters for a module's files or a
blueprint's source. Static assets under `/assets/` are served with `cache-control: immutable`, so a
reload costs nothing; everything else is `no-cache` and revalidated.

Vite's "chunk is larger than 500 kB" warning is about raw size before compression and fires for both
the entry and the lazy `pele` chunk. It is a nudge, not a problem: first load is ~159 kB compressed,
and the largest chunk is not on the critical path.
