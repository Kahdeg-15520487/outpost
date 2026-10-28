# Known limits

- Module servers are QuickJS VMs in the main process, not separate worker isolates. They have no outbound network and no timers or alarms.
- Airlocks run in-process and use shared service-account keys (a token in `outpost.config.json`, or a connection's key) rather than per-user OAuth sign-in.
- Realtime collaboration is method calls plus broadcasts, not CRDT/OT text editing.
- Single process: storage has one owner, so there's no horizontal scaling.
