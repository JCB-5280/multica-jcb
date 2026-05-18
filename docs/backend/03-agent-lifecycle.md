# Backend: Agent Lifecycle Management

## Overview

In MATO, "agent" has two related but distinct meanings:

1. **The agent record** — a named configuration stored in the database (name, instructions, model, skills, etc.). Think of it as a job description or employee profile.
2. **The agent runtime** — a concrete execution environment running on some machine (the local daemon). Think of it as the actual employee showing up to work.

An agent without a runtime is configured but idle. An agent with an active runtime can receive and execute tasks.

---

## The Full Agent Lifecycle

```
┌──────────────────────────────────────────────────────────────────────┐
│  CONFIGURATION PHASE                                                 │
│                                                                      │
│  User creates agent (via UI or CLI)                                  │
│    → POST /api/agents                                                │
│    → agent row: name, instructions, model, visibility, etc.          │
│    → agent_runtime row: mode=local or cloud                          │
│                                                                      │
│  User attaches skills to agent                                       │
│    → POST /api/agents/{id}/skills/{skillId}                          │
│    → agent_skill junction rows                                       │
└─────────────────────────────────────────────────────────────────────┘
                              ↓
┌──────────────────────────────────────────────────────────────────────┐
│  RUNTIME REGISTRATION PHASE (daemon running on user's machine)       │
│                                                                      │
│  mato daemon starts on developer's laptop                         │
│    → detects installed agent CLIs (claude, codex, cursor, etc.)     │
│    → POST /api/workspaces/{slug}/daemon/register                     │
│    → receives daemon_token (mdt_...) scoped to this workspace        │
│                                                                      │
│  Daemon registers each detected runtime                              │
│    → POST /api/runtimes (one per provider)                           │
│    → agent_runtime rows: status=online, daemon_id, device_info       │
│                                                                      │
│  Daemon begins heartbeat loop                                        │
│    → POST /api/runtimes/{id}/heartbeat every ~30s                    │
│    → Updates last_seen_at in DB                                      │
└─────────────────────────────────────────────────────────────────────┘
                              ↓
┌──────────────────────────────────────────────────────────────────────┐
│  TASK QUEUING PHASE                                                  │
│                                                                      │
│  User (or autopilot, or agent) assigns issue to agent                │
│    → PATCH /api/issues/{id} { assignee_type: "agent", ... }          │
│    → TaskService.EnsureTaskQueued() called                           │
│    → agent_task_queue row: status=queued, priority, runtime_id       │
│    → task:queued event published                                     │
│    → DaemonHub.NotifyTaskAvailable() called (wakeup)                 │
└─────────────────────────────────────────────────────────────────────┘
                              ↓
┌──────────────────────────────────────────────────────────────────────┐
│  TASK EXECUTION PHASE                                                │
│                                                                      │
│  Daemon receives wakeup (or next poll fires)                         │
│    → POST /api/runtimes/{id}/tasks/claim                             │
│    → task status: queued → dispatched                                │
│    → Daemon receives full task context:                               │
│        - issue title, description, acceptance criteria               │
│        - agent instructions (system prompt)                          │
│        - agent model preference                                      │
│        - attached skills (SKILL.md content + supporting files)       │
│        - workspace repos (GitHub repos allowed for this agent)       │
│        - custom env vars, custom args, MCP config                    │
│                                                                      │
│  Daemon calls POST /api/tasks/{id}/lifecycle/start                   │
│    → task status: dispatched → running                               │
│    → issue status: todo → in_progress                                │
│    → task:dispatch event published                                   │
│                                                                      │
│  Daemon materializes execution environment:                          │
│    - Writes each skill's content to temp files (SKILL.md, etc.)      │
│    - Checks out relevant git repo (if configured)                    │
│    - Sets environment variables from agent.custom_env                │
│                                                                      │
│  Daemon spawns agent CLI subprocess:                                 │
│    e.g.: claude --prompt "..." --model claude-opus-4-5               │
│           --max-turns 50 --system-prompt "..."                       │
│           [optional: --resume <session_id>]                          │
│                                                                      │
│  Agent CLI works autonomously:                                       │
│    - Reads files, writes code, runs shell commands                   │
│    - Calls tools (bash, read_file, write_file, etc.)                │
│    - Emits JSON events on stdout                                     │
│                                                                      │
│  Daemon streams execution messages to server:                        │
│    → POST /api/tasks/{id}/messages (one per agent event)             │
│    → task_message rows (seq, type, tool, content, input, output)     │
│    → task:message events → WebSocket → browser live transcript       │
│                                                                      │
│  Daemon pins session early (for crash recovery):                     │
│    → POST /api/tasks/{id}/pin-session                                │
│    → Saves agent's session_id + work_dir                             │
│    → Enables resume if daemon crashes mid-task                       │
└─────────────────────────────────────────────────────────────────────┘
                              ↓
┌──────────────────────────────────────────────────────────────────────┐
│  COMPLETION PHASE                                                    │
│                                                                      │
│  Agent CLI exits                                                     │
│                                                                      │
│  Success path:                                                       │
│    Daemon calls POST /api/tasks/{id}/complete                        │
│      { output: "...", pr_url: "https://github.com/..." }             │
│    → task status: running → completed                                │
│    → issue status: in_progress → in_review                          │
│    → If PR URL: creates github_pull_request + issue_pull_request     │
│    → task:completed event → WebSocket broadcast                      │
│    → inbox_item created for each issue subscriber                    │
│                                                                      │
│  Failure path:                                                       │
│    Daemon calls POST /api/tasks/{id}/fail                            │
│      { error: "...", reason: "agent_error" }                         │
│    → task status: running → failed                                   │
│    → TaskService.MaybeRetryFailedTask()                              │
│        if attempt < max_attempts: new queued task (retry)            │
│        if exhausted: issue status → blocked                          │
│    → task:failed event → WebSocket broadcast                         │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Agent Status vs. Runtime Status

These are different things that are often confused:

| Concept | Where stored | Values | Meaning |
|---------|-------------|--------|---------|
| `agent.status` | `agent` table | idle, working, blocked, error, offline | Computed/reconciled state of the agent |
| `agent_runtime.status` | `agent_runtime` table | online, offline | Whether the daemon is currently connected |

The `agent.status` is kept in sync by the server when tasks complete, fail, or time out. The `agent_runtime.status` is kept in sync by heartbeats and the runtime sweeper.

---

## The Runtime Sweeper

A background goroutine (`runRuntimeSweeper` in main.go) runs continuously:

1. Every ~30 seconds, it queries all runtimes with `last_seen_at` older than 75 seconds
2. Marks those runtimes as `offline`
3. Finds any tasks in `running` state on those runtimes
4. Calls `TaskService.HandleFailedTasks()` on those tasks

This is the safety net for detecting crashed or disconnected daemons. Without it, a crashed daemon would leave tasks permanently stuck in `running` state.

The 75-second threshold is intentionally longer than the ~30-second heartbeat interval, giving one missed heartbeat as grace before declaring a runtime offline.

---

## Orphan Recovery

When a daemon restarts after a crash, it calls `POST /api/runtimes/{id}/recover` for each runtime it owns. This:

1. Finds all tasks in `dispatched` or `running` state for that runtime
2. Marks them as `failed` with reason `daemon_restart`
3. Runs `MaybeRetryFailedTask()` on each

This is faster and more precise than waiting for the sweeper (up to 75 seconds). The daemon knows the moment it starts up that the previous process is dead.

---

## Task Concurrency

Each agent has a `max_concurrent_tasks` setting (default: 1). The task claim query enforces this:

```sql
-- Only claim a task if agent currently has fewer than max_concurrent_tasks running
WHERE agent_id = ? 
  AND status = 'queued'
  AND (SELECT COUNT(*) FROM agent_task_queue 
       WHERE agent_id = ? AND status = 'running') < max_concurrent_tasks
```

For most use cases this is 1 (sequential execution). Teams that want parallelism can increase it. The concurrency limit is per-agent, not per-runtime — an agent with `max_concurrent_tasks = 3` running on a single runtime will have three tasks running simultaneously on one machine.

---

## Supported Agent Providers

The `server/pkg/agent/` package contains adapters for each supported agent CLI. Each file implements the `Backend` interface:

```go
type Backend interface {
    Execute(ctx context.Context, prompt string, opts ExecOptions) (*Session, error)
}
```

| File | Provider | CLI Tool |
|------|----------|---------|
| `claude.go` | Claude Code | `claude` |
| `codex.go` | OpenAI Codex CLI | `codex` |
| `copilot.go` | GitHub Copilot | `gh copilot` |
| `cursor.go` | Cursor | `cursor` |
| `gemini.go` | Google Gemini | `gemini` |
| `hermes.go` | Hermes ACP | `hermes` |
| `kimi.go` | Kimi | `kimi` |
| `kiro.go` | Kiro | `kiro` |
| `openclaw.go` | OpenClaw | `openclaw` |
| `opencode.go` | OpenCode | `opencode` |
| `pi.go` | Pi | `pi` |

All providers produce a unified stream of `agent.Message` structs that the daemon forwards to the server.

---

## Agent Visibility

Agents have a `visibility` field (`workspace` or `private`):

- **workspace** — any workspace member can assign issues to this agent
- **private** — only the `owner_id` (the user who created the agent) and workspace admins can use this agent

The visibility check happens in `loadAgentForUser()` and `canUseRuntimeForAgent()`. This is important for shared workspaces where some agents may have credentials or access levels that not everyone should be able to invoke.

---

## Agent Templates

The `server/internal/agenttmpl/` package handles pre-built agent configurations. When a user creates a workspace, they can choose from template agents (e.g., "Code Review Agent," "Documentation Agent"). Templates define:
- Agent name and instructions
- Default skills (which are materialized from the template's skill definitions)
- Runtime configuration

The `GetSkillByWorkspaceAndName` SQL query is specifically used here to implement "find-or-create" for skills during template materialization: if a skill with that name already exists, reuse it rather than creating a duplicate.

---

## Squads: Multi-Agent Coordination

Squads are groups of agents (and optionally humans) that can act as a single assignee. When an issue is assigned to a squad:

1. The squad's leader agent receives a "briefing" task
2. The leader agent decides how to distribute work (by commenting or creating sub-issues)
3. Individual agents in the squad pick up the distributed work

The `squad_briefing.go` handler manages this flow. The leader is a regular agent with a `leader_id` FK from the `squad` table.

---

## Key Fragility Points

1. **The daemon token** is long-lived and scoped to a workspace. If it leaks, anyone with it can claim tasks and report fake completions. For SaaS, daemon token rotation and audit logging would be important.

2. **Skill file materialization** happens at task claim time. If a skill is large (100KB+ SKILL.md), claiming a task that has many skills attached can be slow. There is no caching of materialized skill content.

3. **Session resume** works by saving `session_id` early in the task (`PinTaskSession`). If the agent never emits a `status` message with a session ID (which some providers don't), session resume is not available and a retry starts from scratch.

4. **The max_attempts retry counter** is on the `agent_task_queue` row. The default is 2 retries (3 total attempts). After exhaustion, the issue goes to `blocked` status and requires manual intervention.
