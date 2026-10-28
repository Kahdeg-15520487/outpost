# Airlocks

Capabilities instead of ambient access. For the design rationale and the threat model, see
[design/airlocks.md](design/airlocks.md).

Every Airlock exposes a typed API scoped to one resource. Each method is either `read` or `write`.

- Grants are held by a **chat**, a **module**, or a **mission team** (optionally only some roles, e.g. its developers). Nothing is ambient: a module can't use its chat's grants, and vice versa.
- **Reads** run right away. Pending writes are **overlaid** on later reads, so a queued "create issue" appears in `list_issues`.
- **Writes** return a simulated result immediately and add an action to the approval queue. Approving runs the real call. The outcome is reported back to the chat that asked, and `action_result` reads it. Grants can opt into auto-approve, or set it per method: ask, auto, or refuse.
- Every call is written to the audit log.

Built in:

- `web`: one HTTP origin.
- `github`: one repository: issues, files, comments.
- `mailbox`: a local outbox for trying approvals with no external account.

To add a built-in one, put a definition in `server/src/airlocks/catalog.ts`. Most services don't need one: add them as connections.
