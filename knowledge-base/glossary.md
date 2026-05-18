---
title: Glossary
aliases:
  - Terms
  - Definitions
  - Key Terms
  - Vocabulary
  - Multica Glossary
description: Plain-English definitions for every key term used across the Multica codebase and documentation — architecture concepts, patterns, infrastructure terms, and product-specific vocabulary.
tags:
  - glossary
  - reference
  - definitions
  - concepts
status: reference
author: documentation-library
created: 2026-05-17
modified: 2026-05-17
related:
  - "[[architecture-overview]]"
  - "[[data-flow]]"
  - "[[backend/03-agent-lifecycle]]"
  - "[[backend/05-authentication-access-control]]"
  - "[[database/schema]]"
  - "[[frontend/frontend-architecture]]"
complexity: low
layer: all
---

# Glossary

## A

### Activity Log
An append-only audit trail in the `activity_log` table recording who did what in a workspace. Tracks actor type (`member`, `agent`, `system`), action name, and a JSONB `details` payload. Not surfaced in the product UI yet — primarily for debugging and future compliance features.

### Agent
In Multica, "agent" has two distinct meanings that are easy to confuse:

1. **The agent record** (`agent` table) — a named configuration object: name, instructions, model, skills, and runtime settings. Think of this as the *job description*.
2. **The agent runtime** (`agent_runtime` table) — a concrete execution environment on a developer's machine, registered by the daemon when it detects an installed CLI. Think of this as the *employee showing up to work*.

An agent without an active runtime is configured but cannot receive tasks.

### Agent CLI
The actual AI coding tool installed on a developer's machine that the daemon spawns as a subprocess. Examples: `claude` (Claude Code), `codex` (OpenAI), `cursor`, `gemini`. Multica supports 11 providers. See [[integrations]].

### Agent_skill (junction table)
The many-to-many link between agents and skills. When a skill is attached to an agent via `POST /api/agents/{id}/skills/{skillId}`, a row is added here.

### Agent Task Queue
The `agent_task_queue` table — the primary work queue. Each row represents one attempt to execute a task. States: `queued → dispatched → running → completed/failed`. See [[backend/03-agent-lifecycle]].

### AppLink
A cross-platform navigation link component from the shared views package. Uses the `NavigationAdapter` abstraction so the same component works in both the Next.js web app and the Electron desktop app without importing framework-specific code.

### Attachment
A file uploaded to an issue or comment. The file itself is stored in external object storage; the `attachment` table records the URL, filename, MIME type, and size.

### Autopilot
A scheduled or triggered automation in `autopilot` + `autopilot_trigger` + `autopilot_run` tables. Can fire on a cron schedule, webhook call, or API call. When triggered, creates an issue and assigns it to an agent (or runs the agent directly without creating an issue, depending on `execution_mode`).

### `assignee_type`
A pattern on the `issue` table. Issues are polymorphic — they can be assigned to a `'member'`, an `'agent'`, or a `'squad'`. The `assignee_id` field stores the UUID of whichever entity type is assigned.

---

## B

### Backend (in agent context)
The Go interface `agent.Backend` — implemented by each of the 11 agent CLI providers. Not to be confused with "the Go backend" (the server).

### BatchedHeartbeatScheduler
A background goroutine in the Go server that accumulates runtime heartbeat updates in memory and flushes them to the database in batches (every few seconds). This prevents write amplification: without batching, every daemon's 30-second heartbeat would be an immediate `UPDATE`, becoming a hot spot with many active runtimes.

### Blocking Relationship
An `issue_dependency` row where `type = 'blocks'`. Issue A blocks issue B means B cannot proceed until A is done.

---

## C

### Chat Session
An ongoing conversation between a human user and an agent, outside the context of a specific issue. Stored in `chat_session` + `chat_message` tables. Chat tasks run through the same `agent_task_queue` mechanism as issue tasks, but with a null `issue_id`.

### CoreProvider
A React component in `packages/core/platform/` that initializes the API client, auth/workspace stores, WebSocket connection, and TanStack Query client. Both the web app and desktop app wrap their roots with `<CoreProvider>`.

### CSRF (Cross-Site Request Forgery)
An attack where a malicious website tricks a logged-in user's browser into making state-changing requests. Multica prevents it by requiring an `X-CSRF-Token` header (or `_csrf` form field) on all POST/PATCH/PUT/DELETE requests that use the cookie-based auth session. Bearer token requests are exempt (the token itself proves intent).

---

## D

### Daemon
The local process that runs on a developer's machine. It:
1. Detects installed agent CLIs (claude, codex, etc.)
2. Registers them with the server as `agent_runtime` rows
3. Polls for tasks
4. Spawns agent CLI subprocesses to execute tasks
5. Streams progress back to the server
6. Reports completion or failure

### Daemon Hub
The WebSocket connection from the daemon to the server (`/api/daemon/ws`). Separate from the Realtime Hub that browsers connect to. Used for task wakeup notifications — when a new task is queued, the server pushes a message to the daemon's WebSocket rather than relying on polling.

### Daemon Token
A short-lived, workspace-scoped authentication token (`mdt_` prefix) issued to the daemon process. All daemon API calls use this token. It scopes every request to one workspace — the daemon cannot accidentally access any other workspace's data. Stored as SHA-256 hash only; plaintext never persisted.

### DashboardGuard
A shared React component in `packages/views/layout/` that checks auth state and workspace membership before rendering workspace content. Used in both the web and desktop apps. Redirects to login if unauthenticated, or to the workspace picker if authenticated but not a workspace member.

---

## E

### Electron
The framework used to build the Multica desktop app (`apps/desktop/`). Combines a Chromium renderer with a Node.js main process. The desktop app shares UI code with the web app via the shared packages (`packages/core/`, `packages/views/`, `packages/ui/`).

### Events Bus
An in-process Go channel-based event system (not the WebSocket). Handlers publish events like `task:completed` or `issue:updated` internally; the WebSocket hub subscribes and broadcasts them to connected clients.

---

## F

### `FOR UPDATE SKIP LOCKED`
A PostgreSQL query hint used in the task claim query. When two daemon nodes try to claim a task simultaneously, `SKIP LOCKED` ensures they each get a different task — one skips rows the other has locked. This prevents double-claiming without blocking.

### `force_fresh_session`
A boolean on `agent_task_queue` that overrides crash resume. Normally, if a task has a pinned `session_id`, retries resume from that session. Setting `force_fresh_session = true` ignores the pinned session and starts from scratch.

---

## G

### GitHub App
A GitHub integration that Multica uses to receive pull request events and mirror PR state into the `github_pull_request` table. Linked to a workspace via `github_installation`. PRs are auto-linked to issues when the PR title contains the workspace's issue prefix.

### Glossary File (conventions)
The naming and translation glossary for the project (Chinese voice guide, i18n terms, file naming rules) lives in `apps/docs/content/docs/developers/conventions.mdx`. The old `packages/views/locales/glossary.md` is now a stub. Always use the docs site version.

---

## H

### Handler Layer
The HTTP handler code in `server/internal/handler/`. Each file handles one domain area (issues, agents, skills, etc.). Handlers are thin: they parse requests, call service or query functions, and serialize responses. See [[backend/01-handler-layer]].

### Heartbeat
A `POST /api/runtimes/{id}/heartbeat` call the daemon makes every ~30 seconds to tell the server "I'm still alive." The server updates `agent_runtime.last_seen_at`. The runtime sweeper marks runtimes offline if `last_seen_at` is more than 75 seconds old.

---

## I

### Inbox Item
A notification in `inbox_item`. Recipients can be members or agents. Severity levels: `action_required`, `attention`, `info`. Users can mark items read or archived. Inbox items are created when tasks complete, fail, or when an agent mentions a user.

### Internal Packages Pattern
The architecture decision that shared packages (`packages/core/`, `packages/views/`, `packages/ui/`) export raw TypeScript/TSX files without pre-compilation. The consuming app's bundler (Next.js, Vite) compiles them directly. Benefits: zero-config HMR, instant go-to-definition, no stale build artifacts.

### Issue Number
Issues have both a UUID (`id`) and a human-readable number (`PREFIX-N` format, e.g., `MUL-42`). The `issue.number` is auto-incremented per workspace. The `loadIssueForUser()` helper accepts either format.

### Issue Prefix
A workspace-level setting (e.g., `"MUL"`) that prefixes issue numbers. Generated from the workspace name if not explicitly set. Used in the PR auto-linking logic.

---

## J

### JWT (JSON Web Token)
A signed, self-contained authentication token. Multica signs JWTs with `JWT_SECRET` and stores them in an HttpOnly cookie (`mato_auth`). The cookie is automatically sent on every request to the same origin. JWT validation checks the signature and expiry time.

---

## K

### `keep-alive` (WebSocket)
The server sends a `ping` frame over the WebSocket every ~30 seconds. If the client doesn't respond within the timeout window, the connection is considered dead and closed. The client-side `ws-client.ts` handles reconnection automatically.

---

## L

### Logical Multi-Tenancy
The isolation strategy where all tenants (workspaces) share one database, with isolation enforced by `workspace_id` column filters in every query. This is how Linear, Notion, and most SaaS products work. The alternative is physical multi-tenancy (one database per tenant), which offers stronger isolation but much higher operational complexity.

### Lease (task)
`agent_task_queue.lease_expires_at` — a timestamp that prevents tasks stuck in `dispatched` state from blocking the queue. If a daemon claims a task but never calls the start endpoint, the lease expires and the task becomes reclaimable. Added in migration 055.

---

## M

### Magic Link (Email Login)
Multica's authentication mechanism. The user enters their email; the server sends a 6-digit code; the user enters the code. No passwords. The code is hashed (SHA-256) and stored in `verification_code`; only the hash is checked, never the plaintext.

### `max_concurrent_tasks`
An `agent` table column controlling how many tasks one agent runs simultaneously. Default is 1. The task claim query enforces this by counting running tasks before claiming another.

### MCP (Model Context Protocol)
A protocol for extending AI agents with additional tools (database queries, API calls, file operations). In Multica, each agent can have an `mcp_config` JSONB blob that defines MCP servers. At task execution, the daemon writes this to a temp file and passes it to the agent CLI via `--mcp-config`.

### Member
A human user who belongs to a workspace. Stored in the `member` table as a `(workspace_id, user_id, role)` triple. Roles: `owner` > `admin` > `member`.

### Migration
A numbered SQL file in `server/migrations/` that alters the database schema. Applied sequentially with `make migrate-up`. The Go server embeds these files and applies them on startup (or they can be applied manually).

---

## N

### NavigationAdapter
An interface in `packages/core/navigation/` with `push()`, `replace()`, and `back()` methods. The web app implements it with `next/navigation`; the desktop app implements it with `react-router-dom`. Shared components use `useNavigation()` — never framework APIs directly.

### No-Duplication Rule
The architectural constraint that shared logic must live in a shared package. If the same code exists in both `apps/web/` and `apps/desktop/`, it must be extracted to `packages/core/` or `packages/views/`. Copy-pasting between apps is an architectural violation.

---

## O

### Onboarding State
`user.onboarding_state` — a JSONB column tracking the user's progress through the post-signup wizard. `user.onboarded_at` records when they completed it. `user.starter_content_state` tracks whether starter content (demo workspace, sample agent) was auto-created for them.

### Optimistic Update
A TanStack Query pattern where the UI reflects a mutation immediately (before the server responds). If the server returns an error, the update is rolled back to the previous state. The user experience: no waiting spinner for interactive actions.

### Orphan Recovery
The process at daemon startup where the daemon calls `POST /api/runtimes/{id}/recover` to immediately fail tasks that were `dispatched` or `running` when the daemon previously crashed. This prevents issues getting stuck in `in_progress` indefinitely.

---

## P

### PAT (Personal Access Token)
A long-lived API token for programmatic access (`mul_` prefix, 40 hex chars). Stored as SHA-256 hash only. Can be workspace-scoped or global. Used by the CLI and API integrations.

### `parseWithFallback`
A utility in `packages/core/api/schema.ts` that validates an API response against a Zod schema and returns a fallback value (never throws) on validation failure. Used everywhere API responses are consumed to protect against desktop app version drift.

### `pg_cron`
A PostgreSQL extension that runs scheduled SQL jobs inside the database engine. Multica uses it to run `rollup_task_usage_daily()` every 5 minutes. The extension is installed by migration 076 but the cron job itself must be scheduled manually (post-deployment operator task).

### `pgvector`
A PostgreSQL extension for storing and querying vector embeddings. It's installed (part of the Docker image) but no table in the current schema has a vector column. The primary use case would be semantic skill retrieval — finding the most relevant skills for a task rather than injecting all attached skills.

### Pinned Item
A user's personal quick-access shortcut in the sidebar. Stored in `pinned_item`. Can pin issues or projects. Ordered by `position` float for drag-to-reorder.

### Polymorphic
A pattern in the Multica schema where a relationship can point to different entity types. Implemented as `{entity}_type TEXT + {entity}_id UUID` column pairs (e.g., `assignee_type + assignee_id`, `author_type + author_id`). No foreign key constraint is possible because PostgreSQL FK must point to a specific table.

### Priority
A field on issues (`urgent`, `high`, `medium`, `low`, `none`) and autopilots. Also an INT column on `agent_task_queue` — higher values are claimed first during task dispatch.

### Project
A grouping container for issues. Issues have an optional `project_id`. Projects have a `lead` (member or agent), a `status` (`planned`, `in_progress`, `paused`, `completed`, `cancelled`), and can have linked resources.

---

## Q

### QueryClient (TanStack Query)
The central cache for all server state in the frontend. Lives in memory for the lifetime of the browser session. Workspace-scoped query keys ensure switching workspaces automatically shows the correct cached data without manual invalidation.

### Query Key
The identifier for a TanStack Query cache entry. Must include `wsId` (workspace ID) for workspace-scoped data: `["issues", wsId]`, `["agents", wsId]`, etc. Missing `wsId` is the most common cause of workspace-switching showing stale data.

---

## R

### Realtime Hub
The WebSocket server for browser clients (`/api/ws`). Broadcasts workspace events to all connected members of that workspace. Separate from the Daemon Hub. See [[backend/02-websocket-realtime]].

### Redis Streams Relay
When `REDIS_URL` is set, WebSocket events are relayed through Redis Streams so multiple server nodes can broadcast to all connected clients regardless of which node they're connected to. Three modes: `sharded` (default), `legacy`, `dual` (migration tool).

### Reserved Slug
A workspace URL slug that is blocked from registration because it collides with a system route (e.g., `login`, `api`, `admin`, `settings`). The canonical list lives in `server/internal/handler/reserved_slugs.json`. The TypeScript mirror at `packages/core/paths/reserved-slugs.ts` is auto-generated — never edit it directly.

### Role (RBAC)
The membership permission level: `owner` > `admin` > `member`. Controls who can invite members, create daemon tokens, delete the workspace, etc. At least one owner must always exist (orphan protection).

### Runtime Sweeper
A background goroutine in the Go server that checks for stale runtimes every ~30 seconds. If `last_seen_at` is more than 75 seconds old, the runtime is marked `offline` and any `running` tasks on it are failed (and retried if attempts remain).

---

## S

### `sanitizeNullBytes`
A function in `server/internal/handler/skill.go` that removes embedded NUL bytes (0x00) and invalid UTF-8 sequences from skill content before writing to PostgreSQL. Added after real failures: Windows machines with Windows-1252 encoded files produced PostgreSQL SQLSTATE 22021 errors on import.

### Session ID (agent)
An opaque identifier returned by some agent CLI providers in their status messages. Used for crash recovery: if the daemon crashes after receiving this ID, the next retry can pass `--resume <session_id>` to the CLI and continue from where it left off rather than starting from scratch.

### Session Pinning
The act of storing the `session_id` and `work_dir` on the `agent_task_queue` row when the agent first emits them. This is what makes crash recovery possible. Providers that don't emit a session ID cannot be resumed.

### Skill
A named markdown document (`skill.content`) that can be attached to agents. When a task runs, the daemon writes the skill content to the task's working directory as `SKILL.md`. Think of skills as giving an agent a reference handbook before sending it to do a job. See [[backend/06-skill-knowledge-system]].

### Skill File
An additional file attached to a skill (stored in `skill_file`). Written alongside `SKILL.md` during task execution. Examples: code examples, config templates, data files.

### `sqlc`
A Go code generator that reads `.sql` query files and generates type-safe Go functions. Located in `server/pkg/db/queries/`. Run `make sqlc` to regenerate after editing SQL files.

### Squad
A named group of agents (and optionally human members) with a designated leader agent. When a squad is assigned an issue, the leader agent receives a "briefing" task, decides how to distribute the work, and creates sub-issues for squad members.

### Squad Leader
The `agent` designated as `squad.leader_id`. Receives `is_leader_task = true` tasks when the squad is assigned an issue. Responsible for breaking work into sub-tasks.

---

## T

### TanStack Query
The library that manages all server state in the frontend (React Query). Provides caching, background refetching, optimistic updates, and cache invalidation. All API data lives here — never duplicated into Zustand. See [[frontend/frontend-architecture]].

### Task
A row in `agent_task_queue`. Represents one attempt by an agent to work on an issue. Multiple tasks can exist for one issue (retries). A task goes through: `queued → dispatched → running → completed/failed`.

### Task Message
A streaming event from the agent CLI, stored in `task_message`. Types: `text`, `tool_use`, `tool_result`, `status`, `error`, `thinking`. Powers the live transcript UI.

### Task Usage
Token consumption data in `task_usage`. One row per (task, provider, model). Rolled up into `task_usage_daily` for dashboard display.

### Trigger (Autopilot)
How an autopilot fires. Types:
- `schedule` — cron expression (e.g., `"0 9 * * 1"` = every Monday 9am)
- `webhook` — a POST to a generated URL
- `api` — a direct API call

### Turborepo
The build orchestration tool for the pnpm monorepo. Manages task dependencies between packages (`build`, `typecheck`, `test`). Run via `pnpm` commands from the project root.

---

## U

### UUID Parsing Convention
The three-tier system for handling UUIDs in Go handlers:
1. `parseUUIDOrBadRequest` — validates user input; writes 400 on failure
2. `parseUUID` — panics on invalid input (for trusted DB-returned UUIDs only)
3. `util.ParseUUID` — returns error; use outside handlers

The convention was hardened after bug #1661 where `util.ParseUUID` silently returned zero UUID, causing `DELETE` queries to match zero rows while returning 204 success.

---

## V

### Verification Code
A 6-digit numeric code sent to a user's email for magic-link authentication. Stored as SHA-256 hash in `verification_code`. Short-lived, deleted on successful verification. Attempt counter limits brute force.

### Visibility
An `agent` field (`'workspace'` or `'private'`) and `agent_runtime` field. Private agents are only usable by their `owner_id` and workspace admins.

---

## W

### Watermark
`task_usage_rollup_state.watermark_at` — the high-water mark for the usage rollup. The `rollup_task_usage_daily()` function advances this forward by processing new `task_usage` rows. Prevents reprocessing already-rolled-up data.

### WebSocket
A persistent bidirectional connection used for real-time updates. Two WebSocket channels:
1. **Realtime Hub** — browsers connect to `/api/ws`; receive workspace events
2. **Daemon Hub** — daemons connect to `/api/daemon/ws`; receive task wakeup notifications

### Workspace
The top-level tenant unit. A team's isolated environment containing all their agents, issues, skills, members, and settings. Each workspace has a unique URL slug. Users can belong to multiple workspaces.

### Workspace Slug
The URL-safe identifier for a workspace (e.g., `my-team` in `/my-team/issues`). Must be globally unique, lowercase alphanumeric with hyphens, and not on the reserved slug list.

---

## X

### `X-Agent-ID` + `X-Task-ID` Headers
Two headers required together for agent identity verification. Sending only `X-Agent-ID` is rejected — any workspace member could observe an agent UUID and impersonate it. Requiring `X-Task-ID` means the caller must know the task UUID, which is only distributed to the daemon that legitimately claimed the task. Hardened in PR #2359.

### `X-Workspace-ID` / `X-Workspace-Slug`
Headers that identify which workspace an API request targets. The desktop app and CLI send `X-Workspace-ID` (UUID). The web app sends `X-Workspace-Slug`. Middleware resolves slug → UUID transparently.

---

## Z

### Zustand
The client state management library. In Multica, Zustand stores live in `packages/core/` and hold UI state: filters, selections, view modes, modal open/close, tab layout (desktop), etc. Server data (issues, agents, etc.) never goes into Zustand — it stays in the TanStack Query cache.

### Zustand Selector Stability
A common Zustand footgun: returning a freshly constructed object or array from a selector causes infinite re-renders because React sees a new reference on every render. Fix: either select primitive values separately (`s => s.a`, `s => s.b`) or use the `shallow` comparison from `zustand/shallow`.

---

## Related Documents

- [[architecture-overview]] — How all the pieces fit together
- [[data-flow]] — End-to-end task lifecycle trace
- [[backend/03-agent-lifecycle]] — Agent execution in depth
- [[backend/05-authentication-access-control]] — Auth system detail
- [[database/schema]] — Full table reference
- [[frontend/frontend-architecture]] — UI and state management
