# Glossary

Plain-English definitions of every key term, concept, and pattern used in the Multica codebase.

---

## A

### Activity Log
A write-once audit trail of all significant events in the system. Stored in the `activity_log` table. Every issue creation, status change, comment, and task completion creates an entry. Used for the issue timeline view and for compliance/debugging.

### Agent
A named AI entity that can be assigned work. An agent has a configuration (name, instructions, model, skills) and a runtime. Think of it as an AI team member with a job description. Agents can be assigned issues, post comments, create sub-issues, and change issue statuses — exactly like a human team member.

### Agent Runtime
The concrete execution environment where an agent actually runs. Separate from the agent configuration. One runtime can serve multiple agents. A runtime is registered by the daemon when it connects and is tracked as a row in `agent_runtime` with `status = 'online'` or `'offline'`. See also: **Daemon**, **Runtime**.

### Agent Task Queue
The work queue for AI agents. When an issue is assigned to an agent, a row is created in `agent_task_queue`. The daemon polls this queue to claim tasks. Each row tracks the full lifecycle from `queued` → `dispatched` → `running` → `completed` or `failed`.

### Autopilot
A scheduled or triggered automation that creates issues and assigns them to agents automatically. Defined by a cron schedule (or webhook/API trigger), a title template, a target agent, and a concurrency policy. Think of it as a recurring job definition that Multica executes on a schedule.

### Autopilot Run
A single execution of an autopilot. One run = one issue created (or one task executed in `run_only` mode). Tracked in `autopilot_run` with its own status lifecycle.

---

## B

### Backend (agent package)
The Go interface that each agent CLI adapter implements. `Backend.Execute(ctx, prompt, opts)` spawns the CLI subprocess, streams events back, and returns a final result. Each supported agent provider (Claude Code, Codex, Cursor, etc.) has its own `Backend` implementation.

### Broadcast Hub
The in-memory WebSocket connection manager (`internal/realtime/hub.go`). Holds all currently-connected WebSocket clients, organized by workspace. When an event fires, the hub delivers it to all clients subscribed to that workspace. With Redis, the hub receives events from other nodes via Redis Streams and broadcasts them locally.

### Bus (Event Bus)
An in-process publish/subscribe system (`internal/events/bus.go`). Handlers publish events (e.g., "issue:created"), and registered listeners receive them to perform side effects (write activity log, create inbox items, broadcast via WebSocket). Not durable — if the process crashes after a DB write but before publishing, the event is lost.

---

## C

### Chat Session
A persistent conversation between a user and an agent. Unlike issue-based tasks, chat sessions don't require an issue to exist. Each chat message that requires an AI response spawns a task in `agent_task_queue` (with `chat_session_id` set instead of `issue_id`).

### Chi Router
The Go HTTP router used by Multica (`github.com/go-chi/chi/v5`). Provides middleware composition, URL parameter parsing, and clean route grouping. All HTTP endpoints are registered in `server/cmd/server/router.go`.

### Concurrency Policy (Autopilot)
How an autopilot handles multiple scheduled runs overlapping in time. Three options:
- **skip** — if a run is already in progress, skip the new one
- **queue** — add the new run to the queue, execute after the current one finishes
- **replace** — cancel the running run and start a fresh one

### Context Refs
A JSONB field on issues that stores links to external context (URLs, document references, etc.). Agents can use these as additional reading material when working on an issue.

### CORS (Cross-Origin Resource Sharing)
A browser security mechanism that restricts which origins can make API calls. Configured via `ALLOWED_ORIGINS` or `FRONTEND_ORIGIN` env vars. The WebSocket hub has its own origin check separate from the HTTP CORS middleware.

### CSRF (Cross-Site Request Forgery)
An attack where a malicious site makes authenticated requests on behalf of a logged-in user. Multica protects against this by requiring a CSRF token for state-changing requests that use cookie auth. Bearer token auth bypasses CSRF (the token itself proves intent).

---

## D

### Daemon
A Go binary (`multica daemon`) that runs on a developer's local machine or CI server. It acts as the bridge between the Multica server and the actual agent CLI processes. The daemon:
1. Detects installed agent CLIs
2. Registers them as runtimes with the server
3. Polls for tasks
4. Spawns agent CLI subprocesses
5. Streams progress back to the server

### Daemon Hub
A separate WebSocket hub specifically for daemon connections (`internal/daemonws/`). Different from the Realtime Hub (which serves browsers). The daemon connects here to receive task wakeup notifications.

### Daemon Token
A short-lived authentication token (`mdt_...` prefix) used by the daemon to authenticate with the server. Scoped to a specific workspace. The server stores only the SHA-256 hash.

### DaemonWS / Daemon WebSocket
The WebSocket endpoint at `/api/daemon/ws` that daemon processes connect to. Used for wakeup notifications (server → daemon) and heartbeat acknowledgment.

---

## E

### Events Package
`server/internal/events/` — the in-process pub/sub event bus. All domain events (issue created, task completed, etc.) flow through this bus. Listeners registered at startup receive and process events.

### Exec Options
The configuration passed to an agent CLI when executing a task: working directory, model, system prompt, max turns, timeout, custom args, MCP config, and optional resume session ID.

---

## F

### Fan-Out
The process of delivering a single event to multiple recipients. In Multica's notification system, when a task completes, the fan-out creates an `inbox_item` for every subscriber of that issue.

---

## G

### gorilla/websocket
The Go library used for WebSocket connections (`github.com/gorilla/websocket`). Used for both the browser-facing realtime hub and the daemon-facing daemon hub.

---

## H

### Handler
A Go function that handles a specific HTTP endpoint. In Multica, all handlers are methods on the `Handler` struct and live in `server/internal/handler/`. The pattern is: validate → read DB → write DB → publish event → return JSON.

### Heartbeat
A periodic signal from the daemon to the server confirming that a runtime is still alive. Stored as `last_seen_at` on `agent_runtime`. The Runtime Sweeper marks runtimes as offline if heartbeats stop for more than 75 seconds.

### Heartbeat Scheduler (Batched)
An optimization that batches heartbeat write operations. Instead of writing to PostgreSQL on every heartbeat (every ~30 seconds per runtime), the scheduler accumulates timestamps in memory and flushes them in a batch. This prevents write amplification at scale.

---

## I

### Inbox
The in-app notification center. Each user (and each agent) has an inbox. Inbox items are created for events like: task completed on an issue you're subscribed to, someone commented on your issue, an agent needs attention.

### Inbox Item
A single notification in the inbox. Has a severity level (action_required, attention, info), a title, a body, and read/archived flags.

### Internal Packages Pattern
Multica's approach to building shared frontend packages. All shared packages (`core/`, `views/`, `ui/`) export raw TypeScript/TSX files and are compiled by the consuming app's bundler. No pre-compilation step. This gives instant HMR (hot module replacement) and zero-config go-to-definition in IDEs.

### Issue
The primary work item, analogous to a ticket in Jira or Linear. Issues can be created by humans, agents, or autopilots. They have a status (`backlog` → `todo` → `in_progress` → `in_review` → `done`), a priority, and an optional assignee (human or agent or squad). Issues can have parent-child relationships.

### Issue Guard
`server/internal/issueguard/` — validation logic for issue state transitions. Ensures that certain status changes (e.g., cannot go from `done` back to `backlog`) are enforced.

### Issue Prefix
A short string attached to a workspace used to create human-readable issue IDs. If the prefix is "MUL", issues are numbered MUL-1, MUL-2, etc. The prefix is unique per workspace and the combination (prefix + number) must resolve uniquely.

---

## J

### JSONB
PostgreSQL's binary JSON column type. Used extensively in Multica for schemaless data: agent configuration, skill metadata, task results, workspace settings, etc. JSONB supports efficient indexing and querying via PostgreSQL's JSON operators.

### JWT (JSON Web Token)
The primary session token format. After email verification, the server issues a JWT signed with `JWT_SECRET`. The JWT is stored in an HttpOnly cookie and/or the response body. It contains the user's ID and email as claims.

---

## L

### Label
A colored tag that can be applied to issues. Labels are workspace-scoped and managed in `issue_label`. The many-to-many link is `issue_to_label`.

### Leader Task
When a squad is assigned an issue, the squad's leader agent runs first. This leader task is flagged with `is_leader_task = true` in `agent_task_queue`. The leader agent's job is to assess the issue and coordinate work among squad members.

### Local Skill
A skill document that exists on the developer's local machine but hasn't been imported into the Multica workspace yet. The daemon scans for local skills and reports them to the server. Users can then import them into the workspace with one click.

---

## M

### MCP (Model Context Protocol)
Anthropic's open standard for giving AI models access to external tools and data sources. An MCP server exposes tools that the AI can call (e.g., fetch a web page, query a database, read a file). Agents in Multica can be configured with an `mcp_config` that the daemon passes to the agent CLI when spawning it.

### Member
A human user's membership in a workspace. The `member` table joins users to workspaces with a role (owner, admin, member). The word "member" in the codebase often refers to the `db.Member` struct, not a general person.

### Mention
The `@username` or `@agent-name` feature in comments and issue descriptions. The `server/internal/mention/` package handles parsing mentions and converting them to structured references. Mentions trigger inbox notifications.

### Migration
A SQL file that modifies the database schema. Multica has 92 migration files (numbered 001–092+) in `server/migrations/`. Each migration has an `.up.sql` (apply the change) and `.down.sql` (revert it). Migrations are run by `server/cmd/migrate/`.

---

## N

### Navigation Adapter
A platform-specific implementation of the `NavigationAdapter` interface from `packages/core/navigation/`. The web app's adapter uses `next/navigation`; the desktop app's adapter uses `react-router-dom`. Shared components call `useNavigation().push(path)` and never import framework routing APIs directly.

### No-Duplication Rule
A core architectural principle: if the same logic exists in both the web app and the desktop app, it must be extracted to a shared package. No copy-pasting between apps is allowed.

---

## O

### Onboarding
A guided setup flow new users go through after their first login. Tracks completion state in `user.onboarded_at` and stores survey answers in `user.onboarding_questionnaire` (JSONB). The `onboarding/` module in `packages/core/` manages the step-by-step state.

### Orphan Recovery
A process where the daemon, upon restart, discovers tasks that the previous daemon process left in `running` or `dispatched` state (because the daemon crashed mid-task). It reports these to the server, which fails them and potentially retries them. This prevents tasks from getting permanently stuck.

---

## P

### PAT (Personal Access Token)
A long-lived API token (`mul_...` prefix) for programmatic access to the Multica API. Used by the CLI and by external integrations. Stored as a SHA-256 hash in the database. The plaintext token is shown once at creation.

### pgcrypto
A PostgreSQL extension that provides cryptographic functions. Used in Multica for `gen_random_uuid()` — the function that generates UUID primary keys.

### pg_cron
A PostgreSQL extension that runs scheduled jobs inside the database. Used in Multica for the token usage rollup jobs that aggregate `task_usage` into `task_usage_daily` and `task_usage_dashboard_daily`.

### pgvector
A PostgreSQL extension for storing and querying vector embeddings. Installed but not currently used for semantic search in Multica. The `skill` table has no vector column; skill retrieval is by name or full list scan.

### Pin
A workspace item that a user has pinned for quick access. Stored in `pinned_item`. Can be an issue or project. Ordered by a `position` float.

### Platform Bridge
`packages/core/platform/` — the module that initializes shared state (API client, auth store, WebSocket connection, QueryClient) for each app. Each app wraps its root with `<CoreProvider>` and provides its own `NavigationAdapter`.

### Position (Float Ordering)
Multica uses floating-point numbers (not integers) for ordering items within a list. This allows inserting an item between two others without renumbering: if item A is at position 1.0 and item B is at position 2.0, a new item between them gets position 1.5. This avoids bulk UPDATE statements on reorder.

### Private Agent
An agent with `visibility = 'private'`. Only the agent's `owner_id` and workspace admins can assign issues to this agent or start chat sessions with it. Workspace members cannot see or use private agents.

### Protocol Package
`server/pkg/protocol/` — defines the message types exchanged over the daemon WebSocket (`messages.go`) and the server-side event types (`events.go`). This is the "contract" between the server and the daemon.

---

## Q

### Query Client
The TanStack Query `QueryClient` instance that manages the server-state cache on the frontend. Initialized by `CoreProvider`. All query results and mutations go through this client.

---

## R

### Realtime Hub
The in-memory WebSocket connection hub for browser clients (`internal/realtime/hub.go`). Organizes connections by workspace and broadcasts events to all connected clients in a workspace when data changes.

### Realtime Relay
An optional Redis-backed relay that allows multiple server nodes to share events. Without it, only clients connected to the node that processed a request receive the event. Three modes: `sharded` (default), `legacy`, `dual`.

### Redis Streams
The Redis data structure used by the sharded realtime relay. Each workspace's events are written to a shard of Redis Streams. All server nodes read from all shards and deliver events to their local connected clients.

### Reserved Slug
A workspace slug that cannot be used because it conflicts with a system route (e.g., "login", "api", "settings"). The definitive list is in `server/internal/handler/reserved_slugs.json`. A TypeScript mirror is auto-generated for frontend validation.

### Role-Based Access Control (RBAC)
Multica's permission system within a workspace. Three roles: `owner`, `admin`, `member`. Owners can do everything including deleting the workspace. Admins can invite/remove members. Members can only do workspace-scoped work. Checked in handlers via `requireWorkspaceRole()`.

### Runtime (see Agent Runtime)

### Runtime Sweeper
A background goroutine that periodically checks for agent runtimes that have stopped sending heartbeats. After 75 seconds of silence, a runtime is marked `offline` and any tasks running on it are failed (with retry logic applied).

---

## S

### Scope Authorization
A mechanism for authorizing WebSocket subscriptions to specific resources (tasks, chat sessions) beyond the workspace level. The `ScopeAuthorizer` interface verifies that a resource belongs to the user's workspace before allowing a subscription.

### Semantic Inactivity Timeout
A configurable timeout that stops an agent if it hasn't made progress in a certain amount of time (as opposed to a hard timeout that stops it regardless of activity). Used to catch agents that are "thinking" but not producing meaningful output.

### Session ID (Agent)
The agent CLI's internal identifier for a conversation/session. The daemon saves this early (via `PinTaskSession`) so that if the daemon crashes mid-task, the next retry can resume the agent's conversation from where it left off, rather than starting over.

### Skill
A named markdown document (SKILL.md) that can be attached to an agent and injected into the agent's working directory during task execution. Skills represent domain knowledge, coding conventions, or reference material. Multiple skills can be attached to one agent; the same skill can be attached to multiple agents.

### Skill File
A supporting file for a skill (beyond the main SKILL.md). Stored in `skill_file` at a specific path relative to the skill directory. Materialized into the agent's working directory alongside the SKILL.md.

### sqlc
A code generation tool that takes SQL query files and generates type-safe Go code. Multica uses sqlc to generate all database access code in `server/pkg/db/generated/`. The SQL queries live in `server/pkg/db/queries/`. Developers write SQL; sqlc generates Go.

### Squad
A named group of agents (and optionally human members) that can be assigned issues as a unit. Squads have a leader agent that receives the initial briefing and coordinates work among squad members. Issues can be assigned to a squad just like they can be assigned to an individual agent.

### Structured Skills (migration 008)
The migration that introduced the current skill data model (separate `skill` and `skill_file` tables, with `agent_skill` junction). Before this migration, skills were a text column on the agent row.

### Subscriber
A user or agent watching an issue for updates. When they're subscribed, they receive inbox notifications for events on that issue. The issue creator and assignee are automatically subscribed.

---

## T

### TanStack Query (React Query)
The server-state caching library used in the frontend. Manages fetch deduplication, caching, background refetching, and optimistic updates. The cache key pattern always includes `wsId` (workspace ID) so that workspace switching automatically shows the correct data.

### Task
A unit of work assigned to an agent. Represented as a row in `agent_task_queue`. One issue assignment = one task. One chat message requiring a response = one task. Tasks have a full lifecycle: queued → dispatched → running → completed/failed.

### Task Lease
A mechanism preventing two daemon nodes from claiming the same task simultaneously. The `ClaimTask` query uses a `SELECT ... FOR UPDATE SKIP LOCKED` pattern, which atomically marks a task as dispatched and returns it only if it was successfully locked.

### Task Message
A single event emitted during agent execution: a tool call, tool result, text reasoning, status update, or error. Stored in `task_message` and streamed to the browser via WebSocket in real time.

### Task Session
See **Session ID (Agent)**.

### Token Usage
The count of tokens consumed by an agent during a task. Tracked in `task_usage` per task, per provider, per model. Rolled up to daily aggregates for the usage dashboard. This is the billing data.

### Trigger Comment
The comment that triggered a task, if applicable (e.g., a user @mentions an agent in a comment). Stored as `trigger_comment_id` on the task queue row. The `trigger_summary` column stores a truncated version of the comment for display.

### Turborepo
The monorepo build orchestration tool. Manages build dependencies, caching, and parallel execution across all packages and apps. `pnpm turbo run build` builds everything in the correct order.

---

## U

### UpdateStore
An in-memory (or Redis-backed) store that holds the latest CLI update manifest. The daemon polls this to check if a newer version of the `multica` CLI is available. Populated by the server reading from a known URL.

---

## V

### Verification Code
A 6-digit numeric code sent to a user's email for authentication. Valid for a short time. Stored as a hash (not plaintext) in the `verification_code` table. The magic-link auth flow.

### Visibility (Agent/Runtime)
The access control flag for agents and runtimes:
- **workspace** — any member of the workspace can use this
- **private** — only the owner and admins can use this

For runtimes specifically, `public` allows any workspace member to bind their agents to that runtime.

---

## W

### WebSocket Hub
See **Realtime Hub** (for browsers) and **Daemon Hub** (for daemons).

### WindowOverlay (Desktop)
A desktop-app concept for pre-workspace flows (create workspace, accept invite). On the desktop, these flows are displayed as overlays on top of the current window, not as routes. When the navigation adapter receives a push to `/workspaces/new`, it opens a `WindowOverlay` instead of navigating.

### Worktree (Git)
The daemon uses Git worktrees to provide task isolation. When a task runs against a repository, the daemon creates a worktree (a separate working directory checked out from the same repository) so concurrent tasks don't interfere with each other's changes.

### Workspace
The top-level multi-tenancy boundary. All users, agents, issues, skills, and settings belong to a workspace. A user can be a member of multiple workspaces. Each workspace has a unique slug used in URLs.

### Workspace Context
The middleware layer that resolves the workspace for each API request (from `X-Workspace-ID` header, `X-Workspace-Slug` header, or URL parameter) and verifies the requesting user is a member. Stored in the request context for downstream handlers to access via `ctxWorkspaceID()` and `ctxMember()`.

---

## Z

### Zustand
The lightweight state management library used for client-side state in the frontend (`packages/core/*/store.ts`). Stores handle UI state (filters, selections, drafts) and never contain data that came from the server (that stays in TanStack Query).
