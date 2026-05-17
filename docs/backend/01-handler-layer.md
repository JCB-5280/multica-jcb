# Backend: Handler Layer

## What It Is

The handler layer (`server/internal/handler/`) is the HTTP API surface of the entire application. It receives HTTP requests, validates them, calls the database (via sqlc-generated queries), publishes events to the event bus, and returns JSON responses.

The router is Chi v5. All handlers are methods on a single `Handler` struct that holds shared dependencies.

---

## The Handler Struct

```go
type Handler struct {
    Queries               *db.Queries          // sqlc query object — all DB access
    DB                    dbExecutor           // raw pgx executor for transactions
    TxStarter             txStarter            // starts pgx transactions
    Hub                   *realtime.Hub        // WebSocket broadcast hub
    DaemonHub             *daemonws.Hub        // Daemon-specific WebSocket hub
    Bus                   *events.Bus          // In-process event pub/sub
    TaskService           *service.TaskService // Complex task lifecycle logic
    AutopilotService      *service.AutopilotService
    EmailService          *service.EmailService
    UpdateStore           UpdateStore          // Redis/in-memory: CLI update manifest
    ModelListStore        ModelListStore       // Redis/in-memory: available AI models
    LocalSkillListStore   LocalSkillListStore  // Redis/in-memory: daemon-reported skills
    LocalSkillImportStore LocalSkillImportStore
    LivenessStore         LivenessStore        // Redis/in-memory: runtime heartbeat timestamps
    HeartbeatScheduler    HeartbeatScheduler   // Batches DB heartbeat writes
    Storage               storage.Storage      // S3 or local file storage
    CFSigner              *auth.CloudFrontSigner
    Analytics             analytics.Client
    PATCache              *auth.PATCache       // Cache for Personal Access Token lookups
    DaemonTokenCache      *auth.DaemonTokenCache
    cfg                   Config
}
```

Every handler file follows the same pattern: define response structs, implement handler functions, wire them into routes in `cmd/server/router.go`.

---

## Handler Files and What They Do

### `handler.go` — Foundation

The base file. Contains:

- `Handler` struct definition and `New()` constructor
- UUID parsing helpers (`parseUUIDOrBadRequest`, `parseUUID`)
- `publish()` / `publishTask()` / `publishChat()` — wrappers that post events to the bus
- `resolveActor()` — **critical security function** that determines whether a request is from a human (`member`) or an agent. An agent can only claim agent identity if it provides both `X-Agent-ID` AND `X-Task-ID`, and the task must actually belong to that agent. Without the task check, any workspace member could impersonate an agent.
- `loadIssueForUser()` — resolves an issue by UUID or by human-readable identifier ("MUL-42")
- `requireWorkspaceMember()` / `requireWorkspaceRole()` — the permission guards used by almost every handler

### `issue.go` — Issues

The largest and most complex handler. Key endpoints:

| Endpoint | What it does |
|----------|-------------|
| `GET /api/issues` | List issues with filters (status, assignee, label, search, grouped views) |
| `POST /api/issues` | Create an issue; if assigned to agent, enqueues a task |
| `GET /api/issues/{id}` | Get single issue (by UUID or "PREFIX-N" identifier) |
| `PATCH /api/issues/{id}` | Update issue; handles status transitions, reassignment, task queueing |
| `DELETE /api/issues/{id}` | Soft-delete (actually deletes) |

The issue list endpoint supports many filtering modes: by status, by assignee, by label, grouped by status, grouped by assignee, paginated, and searched (full-text via PostgreSQL). This is one of the most performance-sensitive endpoints.

**Watch out:** When an issue is assigned to an agent, `UpdateIssue` calls `TaskService.EnsureTaskQueued()`. This is a side effect of a PATCH call. If you add new logic to issue updates, be careful not to accidentally trigger duplicate task creation.

### `agent.go` — Agent CRUD

Manages the agent configuration. An agent is a named entity with:
- A name, avatar, description, instructions (system prompt)
- A runtime mode (`local` or `cloud`)
- A `runtime_id` pointing to an `agent_runtime` row
- Skills attached via `agent_skill` junction table
- Concurrency settings, model preference, custom CLI args, MCP config

Key endpoints include CRUD plus `GET /api/agents/{id}/skills` and `POST/DELETE /api/agents/{id}/skills/{skillId}` for managing skill attachments.

### `daemon.go` — Daemon REST API

This file handles all the HTTP endpoints that the local daemon binary calls. Separate from the regular user API — all routes here require daemon token auth.

Key endpoints:

| Endpoint | What it does |
|----------|-------------|
| `POST /api/runtimes/{id}/tasks/claim` | Daemon claims the next queued task |
| `POST /api/tasks/{id}/lifecycle/start` | Task status → running, issue → in_progress |
| `POST /api/tasks/{id}/messages` | Stream execution messages (tool calls, text) |
| `POST /api/tasks/{id}/usage` | Report token consumption |
| `POST /api/tasks/{id}/complete` | Task done, optional PR URL |
| `POST /api/tasks/{id}/fail` | Task failed, triggers retry logic |
| `POST /api/runtimes/{id}/recover` | Orphan recovery at daemon startup |
| `POST /api/runtimes/{id}/heartbeat` | Keep runtime marked 'online' |
| `GET /api/runtimes/{id}/local-skills` | Daemon polls for skill import requests |
| `PUT /api/runtimes/{id}/local-skills/{requestId}` | Daemon fulfills a skill import |
| `GET /api/runtimes/{id}/models` | Daemon-reported list of available models |

### `daemon_ws.go` — Daemon WebSocket Handler

The `/api/daemon/ws` endpoint. Daemons connect here (not the regular user WebSocket). Handles the protocol-level daemon registration (`DaemonRegisterPayload`), task-available wakeup pushes, and heartbeat acknowledgment messages.

### `runtime.go` — Agent Runtimes

An `agent_runtime` represents a concrete execution environment — e.g., "Claude Code on Aaron's laptop" or "Codex in CI." Runtimes are separate from agents: one runtime can serve multiple agents.

Key features:
- Runtime registration by daemon
- Runtime heartbeat tracking (via `LivenessStore` backed by Redis when available)
- Token usage reports and rollup
- Runtime visibility (`private` vs `public` — controls who can bind agents to this runtime)

**Performance flag:** The runtime usage dashboard has a two-path read system. By default it reads from the raw `task_usage` table (always accurate, but slow at scale). Once `UseDailyRollupForRuntimeUsage` is enabled and pg_cron is running, it reads from `task_usage_daily`. This is explicitly a manual operator switch — the code even documents which migrations and backfill steps must complete before flipping it.

### `skill.go` / `skill_create.go` — Skills

Skills are named knowledge documents that agents can reference during execution. Each skill has:
- A `content` field: the main SKILL.md document (can be large — 50–200KB)
- A `skill_file` table for supporting files at specific paths
- A `config` JSONB field for metadata

**Performance issue already documented in the code:** The list endpoint (`ListSkillSummariesByWorkspace`) deliberately omits the `content` field because shipping full SKILL.md bodies in list responses caused 15-second CLI timeouts on high-latency connections (referenced: issue #2174).

### `workspace.go` — Workspace Management

Handles workspace creation, updates, member management, and slug management. Includes:
- `GET /api/workspaces` — list user's workspaces
- `POST /api/workspaces` — create workspace (with slug reservation check)
- `PATCH /api/workspaces/{slug}` — update workspace
- `GET /api/workspaces/{slug}/members` — list members
- `PATCH /api/workspaces/{slug}/members/{memberId}` — change role
- `DELETE /api/workspaces/{slug}/members/{memberId}` — remove member

`workspace_reserved_slugs.go` contains the slug reservation check logic. Reserved slugs come from `reserved_slugs.json` (also used on the frontend).

### `auth.go` — Authentication

Handles the email magic-link flow:
1. `POST /api/auth/login` — sends a 6-digit verification code via email
2. `POST /api/auth/verify` — validates the code, returns a JWT cookie
3. `GET /api/me` — returns the current user
4. `POST /api/auth/logout` — clears the cookie

The JWT is stored in an HttpOnly cookie (`multica_auth`). State-changing requests using cookie auth require a CSRF token. The PAT path (`mul_...` prefix tokens) bypasses CSRF but requires the Bearer header.

**Signup restriction:** The server can be configured with `AllowSignup: false`, `AllowedEmails`, and `AllowedEmailDomains` to restrict who can create accounts. This is the primary self-hosting access control mechanism and will need to be replaced with a proper registration flow for SaaS.

### `task_lifecycle.go` — Orphan Recovery and Session Pinning

Two specialized daemon endpoints:
- `RecoverOrphanedTasks` — called at daemon startup; fails any tasks the previous daemon process left running, triggering the retry pipeline
- `PinTaskSession` — lets the daemon save the agent's session ID and working directory early, so a crash mid-task doesn't lose the resume pointer

### `heartbeat_scheduler.go` — Batched Heartbeat Writes

Rather than writing a heartbeat row to PostgreSQL on every daemon ping (which could be every 10 seconds × N runtimes), the `BatchedHeartbeatScheduler` accumulates heartbeat timestamps in memory and flushes them to the DB in batches. This prevents database write amplification at scale.

### `autopilot.go` — Scheduled Automations

Autopilots are scheduled triggers that automatically create issues and assign them to agents on a cron schedule (or via webhook/API). Each autopilot has:
- An agent assignee
- A title template for generated issues
- One or more triggers (schedule with cron expression, webhook, or API call)
- A concurrency policy (skip, queue, or replace in-flight runs)

### `squad.go` / `squad_briefing.go` — Squads

Squads are groups of agents (and optionally human members) that can be @mentioned or assigned to issues. When a squad is assigned an issue, the squad's leader agent decides how to distribute work among members. The `squad_briefing.go` file handles the "briefing" — the leader agent's response after receiving an assignment.

### `chat.go` — Agent Chat

A persistent chat interface between a user and an agent. Chat sessions are separate from issue tasks — they don't require an issue to exist. The agent runs as a task under the hood (with `chat_session_id` set on the task queue row instead of `issue_id`).

### `github.go` — GitHub Integration

Handles the GitHub App installation webhook and pull request sync. When a GitHub App is installed in a workspace, PR events flow in via webhook and are stored in `github_pull_request`. Issues can be linked to PRs via `issue_pull_request`.

### `activity.go`, `comment.go`, `inbox.go`, `label.go`, `pin.go` — Standard CRUD

Standard CRUD handlers for their respective entities. Nothing architecturally surprising, but they all follow the same event-publish pattern after writes.

---

## Cross-Cutting Patterns

### UUID Parsing Convention

The codebase has a strict three-tier UUID parsing system, documented as a guard against a specific historical bug (#1661 — silent zero UUID causing DELETE to match zero rows):

| Function | When to use |
|----------|------------|
| `parseUUIDOrBadRequest(w, s, field)` | User input from URL params or request body. Returns 400 on failure. |
| `parseUUID(s)` | sqlc round-trip values or test fixtures. Panics on failure (intentional — surfaced as 500). |
| `util.ParseUUID(s)` | Outside the handler package. Returns error for caller to handle. |

**Never feed raw URL params into `parseUUID()`.**

### Event Publishing Pattern

Every state-changing handler ends with something like:

```go
h.publish("issue:updated", workspaceID, actorType, actorID, issuePayload)
```

This sends the event to the bus, which delivers it to listeners that broadcast over WebSocket and write side-effect records (activity log, notifications).

### Actor Resolution

```go
actorType, actorID := h.resolveActor(r, userID, workspaceID)
```

This is called after authentication but before writing any audit records. It distinguishes human requests from agent requests. The check requires both `X-Agent-ID` and `X-Task-ID` to be present and valid — `X-Agent-ID` alone is rejected (closed impersonation path, PR #2359).

---

## What a Developer Must Know Before Modifying Handlers

1. **Check the UUID parsing rules** — never skip `parseUUIDOrBadRequest` for user-supplied identifiers going into write queries.
2. **Always publish an event** after writing to the DB. If you forget, the UI won't update in real time.
3. **Actor resolution matters** — if your handler is callable by both humans and agents, use `resolveActor()` to set the correct audit trail.
4. **The skill content is big** — never include it in list responses. Use the summary variant queries.
5. **Task creation is a side effect of issue assignment** — if you modify issue update logic, test that task queue rows aren't duplicated.
6. **Daemon endpoints have their own auth** — they use `requireDaemonRuntimeAccess()` / `requireDaemonTaskAccess()`, not the regular `requireWorkspaceMember()`.
