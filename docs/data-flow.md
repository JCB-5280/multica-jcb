# Data Flow: Full Task Lifecycle

This document traces the complete lifecycle of a task — from a user creating an issue, through assigning it to an agent, watching the agent execute, and the issue reaching completion — showing exactly how data moves between every layer of the system.

---

## Phase 1: Issue Creation

**What the user does:** Types a title and description, clicks "Create."

**What happens under the hood:**

```
Browser (React)
  │
  ├── useMutation (TanStack Query)
  │     calls POST /api/issues
  │     body: { title, description, workspace_id, assignee_type?, assignee_id? }
  │
Go Server (handler/issue.go → CreateIssue)
  │
  ├── Validates JWT/cookie auth → extracts user_id from X-User-ID header
  ├── Resolves workspace_id from X-Workspace-ID header or URL param
  ├── Checks user is a member of this workspace
  │
  ├── DB: INSERT INTO issue (workspace_id, title, description, creator_type='member',
  │         creator_id=user_id, status='backlog', priority='none')
  │         RETURNING *
  │
  ├── DB: INSERT INTO activity_log (action='issue.created', ...)
  │
  ├── events.Bus.Publish("issue:created", workspaceID, actorType, actorID, issuePayload)
  │
  └── Returns HTTP 201 with the new issue JSON

Events Bus (internal/events/bus.go)
  │
  └── Delivers to registered listeners:
        - ActivityListener: writes activity_log row (already done above)
        - SubscriberListener: adds creator as subscriber
        - NotificationListener: fans out inbox items to relevant parties

Realtime Hub (internal/realtime/hub.go)
  │
  ├── Hub.Broadcast(workspaceID, "issue:created", payload)
  │
  └── [if Redis] Writes event to Redis Stream → other nodes pick it up

Browser WebSocket client (packages/core/api/ws-client.ts)
  │
  └── Receives { type: "issue:created", payload: { issue: {...} } }
        → queryClient.invalidateQueries(["issues", wsId])
        → UI re-renders with the new issue in the list
```

**Important detail:** The HTTP response and the WebSocket push happen nearly simultaneously. The frontend typically receives the REST response first (it optimistically adds the issue), and then the WS event arrives and triggers a cache invalidation that confirms the server state. Mutations are optimistic by design.

---

## Phase 2: Assigning to an Agent

**What the user does:** Opens the issue, selects an agent from the assignee dropdown.

```
Browser
  │
  └── useMutation → PATCH /api/issues/{id}
        body: { assignee_type: "agent", assignee_id: "<uuid>" }

Go Server (handler/issue.go → UpdateIssue)
  │
  ├── Loads issue (loadIssueForUser) — supports "MUL-42" or UUID format
  ├── DB: UPDATE issue SET assignee_type='agent', assignee_id=..., status='todo'
  │
  ├── [Task creation] If the issue now has an agent assignee AND status is workable:
  │     calls TaskService.EnsureTaskQueued(ctx, issue)
  │     │
  │     └── DB: INSERT INTO agent_task_queue
  │               (agent_id, issue_id, runtime_id, status='queued', priority=...)
  │               ON CONFLICT DO NOTHING  ← prevents double-queueing
  │
  ├── events.Bus.Publish("issue:updated", ...)
  ├── events.Bus.Publish("task:queued", ...)  ← only if a task was created
  │
  └── Returns updated issue

Realtime Hub
  │
  ├── Broadcasts "issue:updated" to all workspace subscribers
  └── Broadcasts "task:queued" to workspace subscribers

[If daemon is connected via WebSocket]
DaemonHub (internal/daemonws/hub.go)
  │
  └── Sends TaskAvailable message to the daemon process running on the user's machine
        { type: "task:available", payload: { runtime_id: "...", task_id: "..." } }
```

---

## Phase 3: Daemon Claims and Dispatches the Task

**On the daemon side** (mato daemon running locally):

```
Daemon (server/internal/daemon/daemon.go)
  │
  ├── Receives task:available wakeup via WebSocket (or polls every N seconds)
  │
  └── POST /api/runtimes/{runtime_id}/tasks/claim
        (authenticated with mdt_... daemon token)

Go Server (handler/daemon.go → ClaimTask)
  │
  ├── Validates daemon token → gets workspace_id
  ├── Verifies runtime belongs to this workspace
  │
  ├── DB: UPDATE agent_task_queue
  │         SET status='dispatched', dispatched_at=now(), runtime_id=...
  │         WHERE runtime_id=? AND status='queued'
  │         ORDER BY priority DESC, created_at ASC
  │         LIMIT 1
  │         RETURNING *
  │
  ├── Fetches full task context:
  │     - Issue title, description, acceptance_criteria, context_refs
  │     - Agent instructions, model, custom_args, mcp_config
  │     - Agent skills (SKILL.md content for each attached skill)
  │     - Workspace repos (GitHub repos the agent is allowed to clone)
  │
  └── Returns TaskResponse { task_id, issue, agent, skills, repos, ... }

Daemon
  │
  ├── Calls POST /api/tasks/{task_id}/lifecycle/start
  │     → Server: UPDATE task status='running', started_at=now()
  │     → Server: UPDATE issue status='in_progress'
  │     → Server: Publishes task:dispatch + issue:updated events
  │
  ├── Materializes skill files into a temp working directory
  │     (each skill's `content` field written as SKILL.md)
  │
  ├── Checks out the relevant git repo (if configured)
  │     using repocache (git worktrees for isolation)
  │
  └── Spawns the agent CLI subprocess
        e.g.: claude --prompt "..." --model claude-opus-4-5 --max-turns 50
              or: codex --quiet "..."
```

---

## Phase 4: Agent Execution and Progress Streaming

**While the agent works:**

```
Agent CLI (subprocess)
  │
  └── Emits JSON events on stdout/stderr:
        - tool_use (reading files, running commands, editing code)
        - tool_result (output of those tools)
        - text (agent's reasoning)
        - status (starting, thinking, etc.)

Daemon (pkg/agent/claude.go or codex.go etc.)
  │
  ├── Reads stdout line by line
  ├── Parses events into agent.Message structs
  │
  └── For each meaningful event:
        POST /api/tasks/{task_id}/messages
        body: { seq, type, tool, content, input, output }

Go Server (handler/daemon.go → CreateTaskMessage)
  │
  ├── DB: INSERT INTO task_message (task_id, seq, type, ...)
  │
  └── events.Bus.Publish("task:message", workspaceID, "agent", agentID, taskID, payload)
          ↓
      Realtime Hub → WebSocket → Browser

Browser (packages/views/common/task-transcript/)
  │
  └── Receives task:message events
        → Appends to live transcript view
        → Shows tool calls, text, tool results in real time
```

**Token tracking:** The daemon accumulates token usage from the agent and periodically reports it:

```
Daemon → POST /api/tasks/{task_id}/usage
  body: { provider, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens }

Server → DB: UPSERT task_usage (...)
           Later rolled up by pg_cron into task_usage_daily for dashboard charts
```

---

## Phase 5: Task Completion

**When the agent finishes:**

```
Agent CLI exits with a result

Daemon
  │
  ├── Reads final result from agent.Session.Result channel
  │
  └── POST /api/tasks/{task_id}/complete
        body: { output: "...", pr_url: "..." }

Go Server (handler/daemon.go → CompleteTask, then service/task.go)
  │
  ├── DB: UPDATE agent_task_queue SET status='completed', completed_at=now(), result={...}
  ├── DB: UPDATE issue SET status='in_review' (or 'done' depending on agent config)
  ├── DB: INSERT activity_log (action='task.completed')
  │
  ├── If PR URL present:
  │     Finds or creates github_pull_request row
  │     Creates issue_pull_request link
  │
  ├── events.Bus.Publish("task:completed", ...)
  ├── events.Bus.Publish("issue:updated", ...)
  │
  └── Returns 200 OK

Realtime Hub
  │
  ├── Broadcasts "task:completed" → Browser shows completion banner
  └── Broadcasts "issue:updated"  → Issue card moves to "In Review" column

NotificationListener
  │
  └── Creates inbox_item for each subscriber of the issue
        with type="task.completed" and severity="info"
```

---

## Phase 6: Task Failure and Retry

**If the agent fails or times out:**

```
Daemon detects failure (exit code, timeout, or server-side sweeper)
  │
  └── POST /api/tasks/{task_id}/fail
        body: { error: "...", reason: "agent_error" | "timeout" | etc. }

Go Server (TaskService.HandleFailedTasks)
  │
  ├── DB: UPDATE task status='failed', error=...
  │
  ├── MaybeRetryFailedTask:
  │     - Checks retry_count < max_attempts (default: 2 retries)
  │     - If retryable: INSERT new agent_task_queue row (status='queued')
  │                     UPDATE issue status back to 'todo'
  │     - If exhausted: UPDATE issue status='blocked'
  │
  └── Publishes task:failed + issue:updated events

Runtime Sweeper (background goroutine in main.go)
  │
  └── Every ~30s: Finds runtimes with last_seen_at > 75s ago
        → Marks them 'offline'
        → Calls HandleFailedTasks for any running tasks
```

---

## The Event Bus Pattern

Every mutation in the system follows this pattern:

```
Handler writes to DB → Handler publishes event → Listeners fire side effects → Hub broadcasts to WebSocket
```

The event bus (`internal/events/bus.go`) is a simple in-process pub/sub. Registered listeners include:

| Listener | What it does |
|----------|-------------|
| `registerListeners` | Routes events to the WebSocket hub for broadcast |
| `registerSubscriberListeners` | Adds/removes issue subscribers when membership changes |
| `registerActivityListeners` | Writes activity_log rows for audit trail |
| `registerNotificationListeners` | Fans out inbox_item rows to relevant recipients |
| `registerAutopilotListeners` | Triggers autopilot run creation when an issue is closed |

**Why this matters for you:** If you add a new mutation (e.g., a billing event), you can hook into this bus without touching any existing handler. The pattern scales well. The weakness is that it's in-process only — listeners that fail don't retry, and there's no durable message queue behind this bus. For SaaS, you'd want to consider a durable queue (e.g., Postgres-backed) for critical side effects like billing.

---

## Data Movement Summary Table

| From | To | Mechanism | Latency |
|------|----|-----------|---------|
| Browser | Go Server | HTTPS REST | ~50ms |
| Go Server | Browser | WebSocket push | ~5ms after REST |
| Go Server | Daemon | WebSocket push (task:available) | ~5ms |
| Daemon | Go Server | HTTPS REST | ~50ms |
| Agent CLI | Daemon | stdout streaming | real-time |
| Daemon | Go Server (progress) | HTTPS REST (per message) | ~50ms each |
| Go Server | PostgreSQL | pgx connection pool | ~1-5ms |
| Go Server nodes | Each other | Redis Streams | ~5-20ms |
