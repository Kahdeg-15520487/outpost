# Connections: any MCP server or REST API

A **connection** turns a third-party service into a Airlock with no service-specific code (`server/src/airlocks/connectors/`, built on the official MCP SDK and `@apidevtools/swagger-parser`):

- **MCP server** (streamable HTTP, falling back to SSE): its tools become methods. Tools the server marks `readOnlyHint: true` are reads; everything else is a write; `destructiveHint: true` always asks.
- **REST API** with an OpenAPI 3 or Swagger 2 document (by URL, or pasted): its operations become methods. GET/HEAD are reads; POST/PUT/PATCH are writes; DELETE always asks. **Fixed parameters** (`organization=contoso`) are sent with every call and hidden from agents, so a connection can be pinned to one organization or project.

- **GitHub**, hand-written (`connectors/github.ts`): one repository per connection, set as `owner/repo` or its github.com address, with a fine-grained personal access token. Six methods: `repo_info`, `list_issues`, `get_issue`, `read_file` (files or a directory listing, at an optional ref) and, with approval, `create_issue` and `comment`. The repository is fixed by the connection, so an agent can't point it elsewhere. It is a separate connector from the built-in `github` Airlock, which uses one shared token from the config file. **Test connection** checks the token and the repository's access without changing anything.
- **Azure DevOps**, hand-written (`connectors/azure-devops.ts`; Microsoft no longer publishes OpenAPI documents, and its hosted MCP server needs Entra sign-in): about 30 methods over the REST API (7.1) for boards (WIQL queries, work items, comments, links, iterations), repos and pull requests (files, branches, create, comment, vote, complete), pipelines and builds (run, failures, logs) and wiki. One organization per connection, optionally one project (then agents can't name another). Personal access token. Deleting work items, voting and completing pull requests always ask. A work item or pull request waiting for approval shows up in queries with a `pending:` id, and a later action can use that id: approving it first runs the one it depends on.

A connection is the workspace's account on the service (a shared service account): workspace owners add them on the **Connections** page (auth: bearer token, API key in a header or the URL, or basic; basic's username may be empty, as for Azure DevOps personal access tokens). Secrets are encrypted with the instance secret (`data/connections.enc.json`) and never sent back to the browser or shown to agents. A connection gives nobody access by itself: you introduce it to a chat, module or mission (🔑 Resources), choosing the methods and, per write, ask / auto / refuse. An owner can mark a write as a read ("treat as read").

**Always ask / Always allow, per method.** On the Connections page each method has an Ask / Allow control, set by workspace owners for the whole workspace. Without a setting, reads run and writes ask. **Allow** runs a method without asking, including on connections added in the UI and for destructive methods (those need a confirmation first); **Ask** queues even a read for approval. A capability (a chat, module or mission) can still narrow an allowed method back to ask or refuse it, but can never widen one. Changes are audited with who made them, and each call an Allow lets through is audited too. Resetting a method (↺) returns it to the default, and removing a connection forgets its settings.

Trust:

- **Added in the UI** ("byo"): public hosts only (private, loopback, link-local and metadata addresses are refused, redirects can't leave the host), and writes are never auto-approved.
- **Declared by an admin** in `outpost.config.json` (`connectors`): vetted. May reach private hosts, may run a local MCP command (stdio), and writes may be auto-approved (except always-ask ones). They appear in every workspace, or only those listed.

```json
"connectors": [
  { "id": "linear", "kind": "mcp", "url": "https://mcp.linear.app/mcp", "auth": { "kind": "bearer", "token": "$LINEAR_TOKEN" } },
  { "id": "files", "kind": "mcp", "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/srv/shared"] },
  { "id": "inventory", "kind": "openapi", "spec": "https://inventory.internal/openapi.json", "auth": { "kind": "header", "name": "x-api-key", "value": "$INVENTORY_KEY" }, "reads": ["searchItems"] }
]
```

**Agents can propose connections.** Ask in a chat ("connect us to Linear") and the agent finds the endpoint and drafts it with `propose_connection`: the MCP URL or OpenAPI document, how it authenticates, why, and how to get the key, but never the key itself (the tool has no field for one, and agents are told never to ask for keys in chat). The draft waits under Connections (with a sidebar badge, and in Approvals & access). An owner reviews it in a pre-filled form, types the key and connects it, or declines; the agent is told either way and then asks for access with `request_access`.

Agents see their capabilities in `<resources>` (methods, and whether each reads, asks, runs or is refused), look methods up with `airlock_tools`, call them with `airlock_call`, and ask for a connection by its label with `request_access`. A write on a connection queues and returns `{status: "pending", actionId}`: a generic connector can't fake what the service would return. Modules call connections the same way: `ctx.airlocks["<label>"].<method>(args)`.
