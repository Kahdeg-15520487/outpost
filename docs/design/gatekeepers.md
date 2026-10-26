# Gatekeepers: connectors, capabilities and approvals

Status: generic connectors are built (see "Built" below); native connector packages, OAuth connect flows, expiry and limits, and action dependencies are still proposals.

Decided so far:
- Connections belong to the **workspace**: a shared service account per service, not each person's own account.
- Project teams get capabilities, per project, optionally limited to some roles (G6).

## Built

The generic route, on public libraries (`@modelcontextprotocol/sdk`, `@apidevtools/swagger-parser`, `yaml`), in `packages/server/src/gatekeepers/connectors/`:

- **Connections** (`ConnectionsDoc`, workspace-owned; owners manage them on the Connections page): `mcp` (streamable HTTP with SSE fallback; stdio for admin-declared ones) and `openapi` (document by URL or pasted). Auth: bearer, header, query, basic. Secrets in `data/connections.enc.json` (AES-256-GCM, instance secret), never returned or shown to agents, redacted from errors.
- **Admin-declared connections** (`connectors` in `pi-os.config.json`) are vetted: private hosts, local commands, auto-approval allowed. UI-added ones are byo: public hosts only (`net.ts` checks every address and redirect hop), never auto-approved.
- **Discovery** classifies methods: MCP `readOnlyHint: true` → read, else write, `destructiveHint: true` → always asks; OpenAPI GET/HEAD/OPTIONS → read, DELETE → always asks. Owners can mark writes as reads. The audit records who classified each read.
- **Capabilities**: grants on a connection carry `methods` (subset) and `policy` (ask / auto / deny per write). Holders: chats, gadgets, and project teams with optional `roles`.
- **Approvals**: writes on connections queue with `{status: "pending", actionId}`; `action_result` reads the outcome; revoking a grant or removing a connection rejects its queued actions.
- **Agents**: `<resources>` lists methods and how each runs (bounded to 40, then `gatekeeper_tools`); `request_access` takes a connection label and the methods needed. Project agents get the same tools and a live `resources` section.
- Tests: `test/connectors.ts` against a local MCP server (HTTP and stdio) and a local OpenAPI service; `test/ui.ts` covers the pages.

## Today (before connectors)

- Three Gatekeepers are compiled into the server (`src/gatekeepers/catalog.ts`): `web` (one origin), `github` (one repository) and `mailbox` (a local outbox).
- A **grant** gives one holder (a chat or a gadget) one resource of one Gatekeeper. It has a label and a single `autoApprove` switch.
- Reads run. Writes return a simulated result and queue an **action** for approval; `overlay` folds pending actions into later reads. Every call is written to the audit log.
- Agents see their grants in `<resources>` and call `gatekeeper_call`. With nothing granted they call `request_access`, and the user grants or denies.
- Credentials: one GitHub token in `pi-os.config.json`. There is no notion of whose account a call runs as.
- Project agents (Lead, Planner, developers) get no Gatekeepers.

What's missing for third-party services:

1. **Adding a service means editing pi-os.** There's no package format and no way to load one.
2. **No accounts.** One GitHub token for the whole instance. A workspace can't have its own account for a service.
3. **Approval is all or nothing per grant.** Auto-approving "add a comment" also auto-approves "delete the repository".
4. **No grant is narrower than a resource.** A grant can't say "these three methods only".
5. **Project teams can't use any of it.**

## Concepts

| Term | What it is | Who creates it |
| --- | --- | --- |
| **Connector** | A package that knows one service: its auth, resource types, methods, simulation. "Jira", "Slack", "any MCP server". | Installed by an instance admin |
| **Connection** | The workspace's authenticated account on a connector: "the ACME service account on acme.atlassian.net". Holds the credential. | A workspace owner |
| **Capability** (grant) | One holder may use one resource, through one connection, with a method subset and an approval policy. | A workspace member, from a connection they may use |
| **Action** | One queued side effect, with its simulated result, waiting for a decision. | The connector, when a holder calls a write method |
| **Observation** | One read, logged. | The connector, when a holder calls a read method |

The holder never sees the credential. It only ever holds the capability, and the capability is what pi-os checks on every call.

## Three ways to add a service

### 1. Native connectors (TypeScript)

These are for services that deserve real simulation and overlay, such as GitHub, Jira and Slack.

```ts
// gatekeepers/jira/index.ts
import { defineConnector, read, write } from "@pi-os/gatekeeper-kit";

export default defineConnector({
  id: "jira",
  version: "1.0.0",
  title: "Jira",
  icon: "🧩",
  auth: { kind: "oauth2", authorizeUrl: "…", tokenUrl: "…", scopes: ["read:jira-work", "write:jira-work"] },
  // or { kind: "apiKey", header: "authorization", format: "Bearer {key}" }, or { kind: "basic" }
  resources: {
    project: {
      title: "Jira project",
      hint: "ACME or https://acme.atlassian.net/browse/ACME",
      normalize: (input, conn) => /* "ACME" */,
      pick: async (conn) => /* list projects for a picker */,
    },
  },
  methods: {
    search: read({ resource: "project", params: { jql: "string" }, run: async ({ resource, args, http }) => … }),
    create_issue: write({
      resource: "project",
      kind: "jira.createIssue",
      params: { summary: "string", description: "string?" },
      describe: (a) => `Create issue “${a.summary}”`,
      simulate: (a, id) => ({ key: `pending:${id}`, summary: a.summary }),
      run: async ({ resource, args, http }) => …,
    }),
    delete_issue: write({ kind: "jira.deleteIssue", alwaysAsk: true, … }),
  },
  overlay: { search: (result, pending) => … },
});
```

- **Loading.** pi-os loads built-in connectors from `packages/server/gatekeepers/`, plus whatever packages `pi-os.config.json` lists: `"connectors": ["@acme/pios-jira", "./my-connectors/zendesk"]`. Connectors aren't installed from the UI, because a connector runs in the server process with network access.
- **`http`** is pi-os's fetch, not the global one. It adds the connection's credential, refreshes OAuth tokens, blocks private and metadata addresses, and enforces timeouts and size limits. Connectors don't touch raw credentials.
- **The kit** gives connectors the shared plumbing: OAuth (auth code with PKCE, device code), token refresh, an SSRF-safe fetch, pagination helpers, simulation with provisional ids, and a test harness. Cloudflare OS learned the hard way that each connector re-implementing these gets them wrong.
- The three current Gatekeepers move to this format unchanged in behaviour.

### 2. MCP servers

This covers most third-party services with no pi-os work. One connector, `mcp`, wraps any MCP server.

- **Endpoint.** Either an HTTP endpoint (streamable HTTP, with MCP's OAuth discovery) or a local command (stdio) that an admin declares in config.
- **Tools become methods.** Each tool's `inputSchema` becomes its parameters and its description is the method's description.
- **Reads and writes.** A tool annotated `readOnlyHint: true` is a read. Anything else, including unannotated tools, is a write and queues for approval.
- **Trust tier**, a property of the connection:
  - **vetted:** an admin added the server in config. Its writes may be auto-approved.
  - **byo:** a user pasted the URL. Its writes are never auto-approved, and every call taken on the server's word is marked so in the audit.
- **No simulation.** A queued MCP write returns `{ status: "pending", actionId }` instead of a fake result, because pi-os can't know what the tool would have returned. The agent calls `action_result(actionId)` later, or continues without it.
- **Scope.** A capability can name the server ("all tools, including ones added later") or a list of tools.

### 3. Declarative HTTP connectors (no code)

For an internal REST API with an OpenAPI spec, or a handful of endpoints.

```json
{
  "id": "acme-inventory",
  "title": "ACME inventory",
  "baseUrl": "https://inventory.acme.internal/api",
  "auth": { "kind": "apiKey", "header": "x-api-key" },
  "openapi": "https://inventory.acme.internal/openapi.json",
  "operations": { "include": ["getItem", "listItems", "reserveItem"] }
}
```

- GET and HEAD are reads; everything else is a write that queues for approval, with a generic simulation (`{ status: 202, simulated: true }`).
- **Resource.** Either the base URL, or a path prefix such as `/warehouses/{id}`.
- **Where it lives.** It's data, not code, so a workspace owner can add one from the UI. An admin can still restrict who may add them, and to which hosts.
- `web` (one origin) becomes the degenerate case: no spec, any path.

## Capabilities

```ts
type Capability = {
  id: string;
  label: string;                 // what the agent calls it: "acme-jira"
  connector: string;             // "jira"
  connection: string;            // whose account
  resource: { type: string; id: string };   // { type: "project", id: "ACME" }
  methods?: string[];            // subset; absent = all the connector's methods for that resource type
  policy: Record<string, "ask" | "auto" | "deny">;  // by action kind; default "ask" for writes
  holder: Holder;
  expiresAt?: number;
  limits?: { callsPerHour?: number; writesPerDay?: number };
  createdBy: string;
  createdAt: number;
};
type Holder =
  | { kind: "conversation"; id: string }
  | { kind: "gadget"; id: string }
  | { kind: "project"; id: string; roles?: string[] };   // new: a whole team, or some roles
```

- **Narrow on purpose.** The resource is one project, repository, channel or origin. Methods can be a subset. A capability never widens: granting a gadget access from a chat's capability yields something equal or narrower.
- **Approval by kind.** Each write has a stable kind (`jira.createIssue`). The user may set kinds to `auto` per capability. A connector marks dangerous kinds `alwaysAsk` (deletes, merges, payments, sending to external recipients), and those can't be set to `auto`. Auto needs a trusted connector, meaning native, declarative from an admin, or vetted MCP.
- **Expiry and limits** are optional. A capability with `expiresAt` disappears from the agent's `<resources>` when it lapses. Hitting a limit makes calls fail with a clear message rather than queue.
- **Revoking** a capability rejects its pending actions.

## Who may do what

| Action | Who |
| --- | --- |
| Install a native connector, add a vetted MCP server | Instance admin (config file) |
| Add a declarative connector or a byo MCP server | Workspace owner (admins can turn this off, or restrict hosts) |
| Create, update or remove a connection | Workspace owner. pi-os acts as that service account for everyone in the workspace. |
| Grant a capability | A workspace member (not a viewer), using one of the workspace's connections, to a holder in that workspace |
| Decide an action | The capability's creator, or a workspace owner. Viewers can't. |
| Request access | Agents (`request_access`) and gadgets (`gadget.requestAccess`). This only creates a request. |

Agents never grant. `request_access` takes a connector, an optional resource and a reason. The user answers by picking a connection, confirming or narrowing the resource and methods, and setting the policy. The agent is told what it got.

Sharing a gadget doesn't share its capabilities' connections. Viewers use the gadget under the owner's capabilities, which is how it works today, and those calls are audited as "via gadget G, by viewer V".

Exports keep the current rule: capabilities and connections don't travel. The bundle's `requires` already lists the Gatekeepers and methods an item calls, so after the move it lists connectors instead.

## Approvals

The current asynchronous model stays. Writes simulate, the agent keeps working, and the user decides later, one by one or in bulk. Additions:

- **Approval text comes from the connector** (`describe`) and shows exactly what will be sent: the issue body, the email recipients, the HTTP body. Truncated parts are marked as truncated.
- **Dependencies.** An action that refers to a provisional id from another pending action (comment on `pending:42`) is applied after it, and is rejected if it is rejected.
- **Apply-time checks.** On approval, pi-os re-checks that the capability still exists and the connection still works, then applies. Failures are recorded on the action and reported to the holder.
- **The agent finds out.** Decisions are delivered to the holder's conversation at its next boundary (this already works for grants), with the real result replacing the simulated one.
- **Projects.** A team's writes go to the project's approval queue, shown in the project view and gated like a blocking question if the connector says so.

## The agent's view

- `<resources>` lists each capability. It shows the label, connector, resource, every method with its parameters, and whether it reads, queues for approval, or is auto-approved. For connectors with many methods (MCP), it shows a bounded catalog plus `gatekeeper_tools(label, search)` to look up the rest.
- `gatekeeper_call(label, method, args)` stays the single entry point, so the checks, audit and queue live in one place.
- New: `action_result(actionId)` for writes without a simulation.
- Data returned from third parties is marked as untrusted in tool results. Instructions inside an issue body are content, not commands.
- Gadgets: `ctx.gatekeepers.<label>.<method>()` stays. Gadget calls go through the same checks.

## Security notes

- Credentials are stored encrypted in the system database (key from config or environment), never in workspace docs, never sent to the browser after entry, never passed to connector code except through `http`.
- `http` refuses private, loopback, link-local and metadata addresses unless an admin allows a host. It doesn't follow redirects to another host, caps response size and time, and strips credentials from errors.
- Native connectors are trusted code, so the admin is the gate. Declarative connectors and MCP servers are untrusted, so they get no auto-approval unless an admin vets them.
- The audit records holder, capability, connection, method, kind, and who classified the call as a read (connector or server).
- With a shared service account, the service sees one identity for everyone in the workspace. The audit, not the service's own logs, is what says which person, chat, gadget or agent made a call, so actions record who approved them too.

## Milestones

| | Scope |
| --- | --- |
| G1 | Connector format and loader. Move web, github and mailbox to it. `http` with SSRF guard. No behaviour change. |
| G2 | Workspace connections: API key and OAuth (auth code + PKCE, device code), encrypted storage, refresh, a Connections page for owners. GitHub moves from the config token to a connection. |
| G3 | Capabilities: method subsets, approval policy per kind with `alwaysAsk`, expiry, limits, the richer access-request dialog. |
| G4 | MCP connector: HTTP and stdio, tool discovery, `readOnlyHint`, vetted and byo tiers, `action_result`. |
| G5 | Declarative HTTP and OpenAPI connectors, added from the UI. |
| G6 | Project holders: capabilities for a whole team or some roles, the project approval queue, briefs that mention them. |

## Open questions

1. MCP over stdio runs a local process. Should that be admin-only, or allowed for workspace owners on a single-user instance?
2. Should app code built by a project ever call third-party APIs at runtime with real credentials? That's a different problem (secrets in a dev server) and isn't covered here.
