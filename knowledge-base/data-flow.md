---
title: Data Flow — Full Task Lifecycle
aliases:
  - Task Lifecycle
  - How Data Moves
  - Issue Execution Flow
description: Traces the complete lifecycle of a task — creation, agent assignment, execution, progress streaming, and completion — showing exactly how data moves between frontend, backend, and database at every step.
tags:
  - data-flow
  - task-lifecycle
  - architecture
  - agents
  - websocket
  - postgresql
status: reference
author: documentation-library
created: 2026-05-17
modified: 2026-05-17
related:
  - "[[architecture-overview]]"
  - "[[backend/01-handler-layer]]"
  - "[[backend/02-websocket-realtime]]"
  - "[[backend/03-agent-lifecycle]]"
  - "[[database/schema]]"
  - "[[glossary]]"
complexity: high
layer: system
---

# Data Flow: Full Task Lifecycle

This document traces the complete lifecycle of a task — from a user creating an issue, through assigning it to an agent, watching the agent execute, and the issue reaching completion — showing exactly how data moves between every layer of the system.

---

## Phase 1: Issue Creation

**What the user does:** Types a title and description, clicks "Create."

```mermaid
sequenceDiagram
    participant B as Browser (React)
    participant S as Go Server
    participant DB as PostgreSQL
    participant WS as WebSocket Hub

    B->>S: POST /api/issues {title, description, workspace_id}
    S->>S: Validate JWT → extract user_id
    S->>S: Check workspace membership
    S->>DB: INSERT INTO issue (creator_type='member', status='backlog')
    S->>DB: INSERT INTO activity_log (action='issue.created')
    S->>S: events.Bus.Publish("issue:created")
    S-->>B: HTTP 201 + new issue JSON
    S->>WS: Hub.Broadcast(workspaceID, "issue:created", payload)
    WS-->>B: WebSocket push → queryClient.invalidateQueries
```

> [!NOTE] Optimistic UI
> The HTTP response and WebSocket push happen nearly simultaneously. The frontend optimistically adds the issue on REST response, then the WS event confirms server state and triggers a cache refresh.

**Important detail:** The event bus delivers to multiple listeners simultaneously:
- `ActivityListener` — writes `activity_log` row
- `SubscriberListener` — adds creator as subscriber to the issue
- `NotificationListener` — fans out `inbox_item` rows

---

## Phase 2: Assigning to an Agent

**What the user does:** Opens the issue, selects an agent from the assignee dropdown.

```mermaid
sequenceDiagram
    participant B as Browser
    participant S as Go Server
    participant DB as PostgreSQL
    participant DH as Daemon Hub
    participant WS as WebSocket Hub

    B->>S: PATCH /api/issues/{id} {assignee_type:"agent", assignee_id:"..."}
    S->>DB: UPDATE issue SET assignee_type='agent', assignee_id=...
    S->>S: TaskService.EnsureTaskQueued()
    S->>DB: INSERT INTO agent_task_queue (status='queued', priority=...) ON CONFLICT DO NOTHING
    S->>S: Bus.Publish("issue:updated") + Bus.Publish("task:queued")
    S-->>B: HTTP 200 + updated issue
    WS-->>B: Push issue:updated
    DH-->>D: Push task:available {runtime_id, task_id}
```

> [!WARNING] Side Effect of PATCH
> When an issue is assigned to an agent, `UpdateIssue` calls `TaskService.EnsureTaskQueued()`. This is a side effect of a PATCH call. If you add new logic to issue updates, be careful not to accidentally trigger duplicate task creation. The `ON CONFLICT DO NOTHING` guards against it but the call still happens.

---

## Phase 3: Daemon Claims and Dispatches

**On the daemon side** (multica daemon running locally):

```mermaid
sequenceDiagram
    participant D as Daemon
    participant S as Go Server
    participant DB as PostgreSQL
    participant WS as WebSocket Hub

    D->>S: POST /api/runtimes/{id}/tasks/claim (mdt_ token auth)
    S->>S: Validate daemon token → get workspace_id
    S->>DB: UPDATE agent_task_queue SET status='dispatched' WHERE status='queued' ... FOR UPDATE SKIP LOCKED
    S->>DB: Fetch task context (issue, agent, skills, repos)
    S-->>D: TaskResponse {task_id, issue, agent, skills, repos, model, custom_args}

    D->>S: POST /api/tasks/{id}/lifecycle/start
    S->>DB: UPDATE task status='running', started_at=now()
    S->>DB: UPDATE issue status='in_progress'
    S->>WS: Publish task:dispatch + issue:updated
    WS-->>B: Push both events

    D->>D: Materialize skill files to temp dir
    D->>D: Checkout git repo (worktree)
    D->>A: Spawn agent CLI subprocess
```

**Task context includes:**
- Issue title, description, acceptance criteria, context_refs
- Agent instructions (system prompt), model preference
- Attached skills — full SKILL.md content + supporting files
- Workspace repos (GitHub repos the agent may clone)
- Custom env vars, custom CLI args, MCP config

---

## Phase 4: Agent Execution and Progress Streaming

```mermaid
sequenceDiagram
    participant A as Agent CLI
    participant D as Daemon
    participant S as Go Server
    participant DB as PostgreSQL
    participant WS as WebSocket Hub
    participant B as Browser

    loop Agent working
        A->>D: JSON event on stdout (tool_use, tool_result, text, status)
        D->>S: POST /api/tasks/{id}/messages {seq, type, tool, content}
        S->>DB: INSERT INTO task_message
        S->>WS: Publish task:message
        WS->>B: Push → live transcript view updates
    end

    Note over D,S: Token usage reported periodically
    D->>S: POST /api/tasks/{id}/usage {input_tokens, output_tokens, ...}
    S->>DB: UPSERT task_usage
```

**Session pinning (crash recovery):**

```mermaid
sequenceDiagram
    participant D as Daemon
    participant S as Go Server
    participant DB as PostgreSQL

    Note over A,D: Agent emits first status message with session_id
    D->>S: POST /api/tasks/{id}/pin-session {session_id, work_dir}
    S->>DB: UPDATE agent_task_queue SET session_id=..., work_dir=...
    Note over S: If daemon crashes after this, next retry can resume agent session
```

---

## Phase 5: Task Completion

```mermaid
sequenceDiagram
    participant A as Agent CLI
    participant D as Daemon
    participant S as Go Server
    participant DB as PostgreSQL
    participant WS as WebSocket Hub
    participant B as Browser

    A->>D: Exit with result
    D->>S: POST /api/tasks/{id}/complete {output, pr_url}
    S->>DB: UPDATE task status='completed', completed_at=now()
    S->>DB: UPDATE issue status='in_review'
    S->>DB: INSERT activity_log
    alt PR URL present
        S->>DB: UPSERT github_pull_request
        S->>DB: INSERT issue_pull_request
    end
    S->>WS: Publish task:completed + issue:updated
    WS->>B: Push → completion banner + issue card moves

    Note over S: NotificationListener fans out
    S->>DB: INSERT inbox_item for each issue subscriber
```

---

## Phase 6: Task Failure and Retry

```mermaid
flowchart TD
    A["Agent exits with error\nor daemon detects timeout"] --> B["POST /api/tasks/id/fail\n{error, reason}"]
    B --> C["DB: UPDATE task status='failed'"]
    C --> D{"attempt < max_attempts?"}
    D -- yes --> E["INSERT new agent_task_queue\n(status='queued', attempt+1)"]
    D -- no --> F["UPDATE issue status='blocked'"]
    E --> G["Publish task:failed + issue:updated"]
    F --> G
    G --> H["WebSocket → Browser shows failure"]
    
    I["Runtime Sweeper (every ~30s)"] --> J{"runtime last_seen_at > 75s?"}
    J -- yes --> K["Mark runtime 'offline'"]
    K --> L["HandleFailedTasks for running tasks on this runtime"]
    L --> D
```

> [!CAUTION] Sweeper Latency
> The Runtime Sweeper can take up to 75 seconds to notice a crashed daemon. For faster recovery, the daemon calls `POST /api/runtimes/{id}/recover` at startup, which immediately fails any orphaned tasks.

---

## The Event Bus Pattern

Every mutation in the system follows this pattern:

```
Handler writes to DB
  → Handler publishes event to Bus
    → Listeners fire side effects (activity log, notifications, subscribers)
    → Realtime listener broadcasts to WebSocket hub
      → Hub delivers to all connected clients in workspace
        → (optionally) Redis Streams relay to other nodes
```

| Listener | What it does |
|----------|-------------|
| Realtime broadcaster | Converts bus events into WebSocket broadcasts |
| Activity listener | Writes to `activity_log` table |
| Subscriber listener | Updates `issue_subscriber` table |
| Notification listener | Creates `inbox_item` rows |
| Autopilot listener | Triggers autopilot runs when issues close |

> [!WARNING] The Bus Is Not Durable
> The event bus is in-process only. If a listener throws or the process crashes after a DB write but before publishing, the event is lost. For SaaS billing or audit events, consider a durable queue (Postgres-backed events table or a message broker).

---

## Data Movement Summary

| From | To | Mechanism | Typical Latency |
|------|----|-----------|---------|
| Browser | Go Server | HTTPS REST | ~50ms |
| Go Server | Browser | WebSocket push | ~5ms after REST |
| Go Server | Daemon | WebSocket wakeup | ~5ms |
| Daemon | Go Server | HTTPS REST | ~50ms |
| Agent CLI | Daemon | stdout streaming | real-time |
| Daemon | Go Server (progress) | HTTPS REST (per message) | ~50ms each |
| Go Server | PostgreSQL | pgx connection pool | ~1-5ms |
| Go Server nodes | Each other | Redis Streams | ~5-20ms |

---

## Related Documents

- [[architecture-overview]] — System overview with component diagram
- [[backend/01-handler-layer]] — Handler implementation details
- [[backend/02-websocket-realtime]] — WebSocket system internals
- [[backend/03-agent-lifecycle]] — Agent lifecycle in depth
- [[database/schema]] — Full database schema
