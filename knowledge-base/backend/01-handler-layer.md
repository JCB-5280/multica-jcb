---
title: "Backend: Handler Layer"
aliases:
  - HTTP Handlers
  - REST API Layer
  - Go Handlers
description: The HTTP API surface of the entire application. Covers the Handler struct, every handler file's purpose, cross-cutting patterns (UUID parsing, event publishing, actor resolution), and what a developer must know before modifying handlers.
tags:
  - backend
  - go
  - rest-api
  - handlers
  - chi-router
  - authentication
  - authorization
status: reference
author: documentation-library
created: 2026-05-17
modified: 2026-05-17
related:
  - "[[architecture-overview]]"
  - "[[data-flow]]"
  - "[[backend/02-websocket-realtime]]"
  - "[[backend/03-agent-lifecycle]]"
  - "[[backend/04-workspace-multitenancy]]"
  - "[[backend/05-authentication-access-control]]"
  - "[[backend/06-skill-knowledge-system]]"
  - "[[database/schema]]"
source_path: server/internal/handler/
complexity: high
layer: backend
---

# Backend: Handler Layer

## What It Is

The handler layer (`server/internal/handler/`) is the HTTP API surface of the entire application. It receives HTTP requests, validates them, calls the database (via sqlc-generated queries), publishes events to the event bus, and returns JSON responses.

The router is Chi v5. All handlers are methods on a single `Handler` struct that holds shared dependencies.

---

## The Handler Struct

The `Handler` struct holds every dependency a handler might need:

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

---

## Handler Files Reference

### `handler.go` — Foundation

> [!IMPORTANT] Security-Critical Functions Here
> `resolveActor()` and `parseUUIDOrBadRequest()` are security-critical. Read this file before any handler modification.

Key functions:

| Function | Purpose |
|----------|---------|
| `resolveActor()` | Determines if request is from a human or agent. Requires BOTH `X-Agent-ID` AND `X-Task-ID` for agent identity — `X-Agent-ID` alone is rejected (PR #2359 security fix) |
| `loadIssueForUser()` | Resolves an issue by UUID or human-readable identifier ("MUL-42") |
| `loadAgentForUser()` | Resolves an agent by UUID with workspace verification |
| `requireWorkspaceMember()` | Checks user is a member of the workspace |
| `requireWorkspaceRole()` | Checks user has sufficient role (owner/admin/member) |
| `publish()` / `publishTask()` / `publishChat()` | Post events to the event bus |
| `parseUUIDOrBadRequest()` | Validates user-supplied UUID — returns 400 on failure |
| `parseUUID()` | Panics on invalid UUID (for trusted DB round-trips — panics become 500s) |

### `issue.go` — Issues (Largest Handler)

The most complex handler. Supports UUID and human-readable identifier lookup for every endpoint.

| Endpoint | Notes |
|----------|-------|
| `GET /api/issues` | Filtering by status, assignee, label, search; grouped views; paginated |
| `POST /api/issues` | If assigned to agent, calls `TaskService.EnsureTaskQueued()` |
| `PATCH /api/issues/{id}` | Status transitions, reassignment, task queueing side effects |
| `DELETE /api/issues/{id}` | Hard delete with cascade |
| `POST /api/issues/batch` | Bulk update/delete |

> [!WARNING] Task Creation Side Effect
> When an issue is assigned to an agent, `UpdateIssue` calls `TaskService.EnsureTaskQueued()`. This is a side effect of a PATCH call. If you add new logic to issue updates, be careful not to accidentally trigger duplicate task creation.

### `agent.go` — Agent CRUD

Manages agent configuration: name, avatar, description, instructions, runtime link, skills, concurrency, model, custom CLI args, MCP config, visibility, archive/restore.

### `daemon.go` — Daemon REST API

All HTTP endpoints the local daemon binary calls. Requires daemon token auth.

| Endpoint | What it does |
|----------|-------------|
| `POST /api/runtimes/{id}/tasks/claim` | Daemon claims the next queued task |
| `POST /api/tasks/{id}/lifecycle/start` | Task status → running, issue → in_progress |
| `POST /api/tasks/{id}/messages` | Stream execution messages |
| `POST /api/tasks/{id}/usage` | Report token consumption |
| `POST /api/tasks/{id}/complete` | Task done, optional PR URL |
| `POST /api/tasks/{id}/fail` | Task failed, triggers retry logic |
| `POST /api/runtimes/{id}/recover` | Orphan recovery at daemon startup |
| `POST /api/runtimes/{id}/heartbeat` | Keep runtime marked 'online' |

### `daemon_ws.go` — Daemon WebSocket

The `/api/daemon/ws` endpoint. Daemons connect here (not the regular user WebSocket). Handles daemon registration, task-available wakeup pushes, and heartbeat acknowledgment.

### `runtime.go` — Agent Runtimes

An `agent_runtime` represents a concrete execution environment. Key features:
- Runtime registration by daemon
- Heartbeat tracking via `LivenessStore` (Redis-backed when available)
- Token usage reports and rollup
- Runtime visibility control (`private` vs `public`)

> [!NOTE] Two-Path Read System for Usage
> The runtime usage dashboard has a safe default path (raw `task_usage` table) and an optimized path (`task_usage_daily` rollup). The rollup path requires `pg_cron` running and must be manually enabled via `UseDailyRollupForRuntimeUsage` config flag after migrations 072-076 are applied and backfilled.

### `skill.go` / `skill_create.go` — Skills

> [!WARNING] Content Size Problem
> The `content` field in skills can be 50-200KB. The list endpoint deliberately uses `ListSkillSummariesByWorkspace` which omits `content`. This fixed a real 15-second CLI timeout issue (#2174). Never return `content` in list endpoints.

Skills have main content (SKILL.md), supporting files (`skill_file`), and a config JSONB. Skills are named and unique per workspace.

### `workspace.go` — Workspace Management

| Endpoint | Notes |
|----------|-------|
| `GET /api/workspaces` | List user's workspaces |
| `POST /api/workspaces` | Create with slug reservation check |
| `PATCH /api/workspaces/{slug}` | Update workspace |
| `GET /api/workspaces/{slug}/members` | List members |
| Member invite/remove/role-change | Owner protection: can't remove last owner |

### `auth.go` — Authentication

Email magic-link flow + JWT issuance. Signup controlled by `Config.AllowSignup`, `AllowedEmails`, `AllowedEmailDomains`.

| Endpoint | What it does |
|----------|-------------|
| `POST /api/auth/login` | Sends verification code via email |
| `POST /api/auth/verify` | Validates code, returns JWT cookie |
| `GET /api/me` | Returns current user |
| `POST /api/auth/logout` | Clears cookie |

### `task_lifecycle.go` — Orphan Recovery and Session Pinning

- `RecoverOrphanedTasks` — called at daemon startup; faster than waiting for the sweeper
- `PinTaskSession` — saves agent session ID + work_dir early for crash recovery

### `heartbeat_scheduler.go` — Batched Heartbeat Writes

Accumulates heartbeat timestamps in memory and flushes to DB in batches. Prevents write amplification (N runtimes × every 30s = many writes).

### `autopilot.go` — Scheduled Automations

Autopilots = recurring job definitions with schedule/webhook/API triggers, title templates, concurrency policies.

### `squad.go` / `squad_briefing.go` — Squads

Named groups of agents+members. When a squad is assigned an issue, the leader agent receives a briefing. Squad assignment uses the same `assignee_type` field on `issue` (value: `'squad'`).

### `chat.go` — Agent Chat

Persistent user-agent conversations without requiring an issue. Each agent response spawns a task in `agent_task_queue` (with `chat_session_id` instead of `issue_id`).

### `github.go` — GitHub Integration

GitHub App installation webhooks + PR sync. Stores installations in `github_installation`, PRs in `github_pull_request`, and links in `issue_pull_request`.

---

## Cross-Cutting Patterns

### UUID Parsing Convention

> [!CAUTION] Bug History
> This convention exists because `util.ParseUUID` used to silently return a zero UUID on invalid input, causing #1661 — a `DELETE` returning 204 success while the SQL `DELETE` matched zero rows.

| Function | When to use |
|----------|------------|
| `parseUUIDOrBadRequest(w, s, field)` | **User input** from URL params or request body. Returns 400 on failure. |
| `parseUUID(s)` | **sqlc round-trip values** or test fixtures. Panics on failure (intentional). |
| `util.ParseUUID(s)` | **Outside handler package**. Returns error for caller to handle. |

**Never feed raw URL params into `parseUUID()`.** The panic → 500 is the correct signal for a missed validation.

### Event Publishing Pattern

Every state-changing handler ends with:

```go
h.publish("issue:updated", workspaceID, actorType, actorID, issuePayload)
// or for task-scoped events:
h.publishTask("task:message", workspaceID, actorType, actorID, taskID, payload)
```

> [!TIP] If you forget to publish, the UI won't update in real time. The next page load will fetch fresh data, but live updates won't work.

### Actor Resolution

```go
actorType, actorID := h.resolveActor(r, userID, workspaceID)
```

Called after authentication but before writing audit records. Distinguishes human requests from agent requests. Requires both `X-Agent-ID` AND `X-Task-ID` — `X-Agent-ID` alone is rejected.

---

## Before Modifying Handlers — Checklist

- [ ] Use `parseUUIDOrBadRequest` for user-supplied identifiers going into write queries
- [ ] Always publish an event after writing to DB
- [ ] Use `resolveActor()` if the handler is callable by both humans and agents
- [ ] Use summary variant queries if returning skills or other large-content entities
- [ ] Test that task queue rows aren't duplicated when modifying issue assignment logic
- [ ] Use `requireDaemonRuntimeAccess()` for daemon endpoints, not `requireWorkspaceMember()`

---

## Related Documents

- [[architecture-overview]] — System overview
- [[data-flow]] — How data moves through the system
- [[backend/02-websocket-realtime]] — Event publishing and WebSocket
- [[backend/03-agent-lifecycle]] — Task service and agent execution
- [[backend/05-authentication-access-control]] — Auth middleware details
- [[backend/06-skill-knowledge-system]] — Skill handler specifics
- [[database/schema]] — Database tables
