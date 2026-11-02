# Known limits

- Module servers are QuickJS VMs in the main process, not separate worker isolates. They have no outbound network and no timers or alarms.
- Airlocks run in-process and use shared service-account keys (a token in `outpost.config.json`, or a connection's key) rather than per-user OAuth sign-in.
- Realtime collaboration is method calls plus broadcasts, not CRDT/OT text editing.
- Single process: storage has one owner, so there's no horizontal scaling.
- Live previews are agent-written code. As an iframe on a published port, or on `<slug>.<preview.baseDomain>`, they are checked against workspace membership — but the dev server itself has whatever the container has, and a framework's own dev-only endpoints are reachable to whoever passes that check.
