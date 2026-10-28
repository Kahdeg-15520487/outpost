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
