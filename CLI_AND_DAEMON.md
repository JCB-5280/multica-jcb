# CLI and Agent Daemon Guide

The `mato` CLI connects your local machine to Multica. It handles authentication, workspace management, issue tracking, and runs the agent daemon that executes AI tasks locally.

## Installation

### Homebrew (macOS/Linux)

```bash
brew install mato-ai/tap/mato
```

### Build from Source

```bash
git clone https://github.com/mato-ai/mato.git
cd mato
make build
cp server/bin/mato /usr/local/bin/mato
```

### Update

```bash
brew upgrade mato-ai/tap/mato
```

For install script or manual installs, use:

```bash
mato update
```

`mato update` auto-detects your installation method and upgrades accordingly.

## Quick Start

```bash
# One-command setup: configure, authenticate, and start the daemon
mato setup

# For self-hosted (local) deployments:
mato setup self-host
```

Or step by step:

```bash
# 1. Authenticate (opens browser for login)
mato login

# 2. Start the agent daemon
mato daemon start

# 3. Done — agents in your watched workspaces can now execute tasks on your machine
```

`mato login` automatically discovers all workspaces you belong to and adds them to the daemon watch list.

## Authentication

### Browser Login

```bash
mato login
```

Opens your browser for OAuth authentication, creates a 90-day personal access token, and auto-configures your workspaces.

### Token Login

```bash
mato login --token <mul_...>
```

Authenticate using a personal access token directly. Useful for headless environments. Pass `--token=` with an empty value to be prompted interactively (so the token never lands in shell history).

### Check Status

```bash
mato auth status
```

Shows your current server, user, and token validity.

### Logout

```bash
mato auth logout
```

Removes the stored authentication token.

## Agent Daemon

The daemon is the local agent runtime. It detects available AI CLIs on your machine, registers them with the Multica server, and executes tasks when agents are assigned work.

### Start

```bash
mato daemon start
```

By default, the daemon runs in the background and logs to `~/.mato/daemon.log`.

To run in the foreground (useful for debugging):

```bash
mato daemon start --foreground
```

### Stop

```bash
mato daemon stop
```

### Status

```bash
mato daemon status
mato daemon status --output json
```

Shows PID, uptime, detected agents, and watched workspaces.

### Logs

```bash
mato daemon logs              # Last 50 lines
mato daemon logs -f           # Follow (tail -f)
mato daemon logs -n 100       # Last 100 lines
```

### Supported Agents

The daemon auto-detects these AI CLIs on your PATH:

| CLI | Command | Description |
|-----|---------|-------------|
| [Claude Code](https://docs.anthropic.com/en/docs/claude-code) | `claude` | Anthropic's coding agent |
| [Codex](https://github.com/openai/codex) | `codex` | OpenAI's coding agent |
| [GitHub Copilot CLI](https://docs.github.com/en/copilot) | `copilot` | GitHub's coding agent (model routed by your GitHub entitlement) |
| OpenCode | `opencode` | Open-source coding agent |
| OpenClaw | `openclaw` | Open-source coding agent |
| Hermes | `hermes` | Nous Research coding agent |
| Gemini | `gemini` | Google's coding agent |
| [Pi](https://pi.dev/) | `pi` | Pi coding agent |
| [Cursor Agent](https://cursor.com/) | `cursor-agent` | Cursor's headless coding agent |
| Kimi | `kimi` | Moonshot coding agent |
| Kiro CLI | `kiro-cli` | Kiro ACP coding agent |

You need at least one installed. The daemon registers each detected CLI as an available runtime.

### How It Works

1. On start, the daemon detects installed agent CLIs and registers a runtime for each agent in each watched workspace
2. It polls the server at a configurable interval (default: 3s) for claimed tasks
3. When a task arrives, it creates an isolated workspace directory, spawns the agent CLI, and streams results back
4. Heartbeats are sent periodically (default: 15s) so the server knows the daemon is alive
5. On shutdown, all runtimes are deregistered

### Configuration

Daemon behavior is configured via flags or environment variables:

| Setting | Flag | Env Variable | Default |
|---------|------|--------------|---------|
| Poll interval | `--poll-interval` | `MATO_DAEMON_POLL_INTERVAL` | `3s` |
| Heartbeat interval | `--heartbeat-interval` | `MATO_DAEMON_HEARTBEAT_INTERVAL` | `15s` |
| Agent timeout | `--agent-timeout` | `MATO_AGENT_TIMEOUT` | `2h` |
| Codex semantic inactivity timeout | `--codex-semantic-inactivity-timeout` | `MATO_CODEX_SEMANTIC_INACTIVITY_TIMEOUT` | `10m` |
| Max concurrent tasks | `--max-concurrent-tasks` | `MATO_DAEMON_MAX_CONCURRENT_TASKS` | `20` |
| Daemon ID | `--daemon-id` | `MATO_DAEMON_ID` | hostname |
| Device name | `--device-name` | `MATO_DAEMON_DEVICE_NAME` | hostname |
| Runtime name | `--runtime-name` | `MATO_AGENT_RUNTIME_NAME` | `Local Agent` |
| Workspaces root | — | `MATO_WORKSPACES_ROOT` | `~/mato_workspaces` |
| GC enabled | — | `MATO_GC_ENABLED` | `true` (set `false`/`0` to disable) |
| GC scan interval | — | `MATO_GC_INTERVAL` | `1h` |
| GC TTL (done/cancelled issues) | — | `MATO_GC_TTL` | `24h` |
| GC orphan TTL (no `.gc_meta.json`) | — | `MATO_GC_ORPHAN_TTL` | `72h` |
| GC artifact TTL (open issues) | — | `MATO_GC_ARTIFACT_TTL` | `12h` (set `0` to disable) |
| GC artifact patterns | — | `MATO_GC_ARTIFACT_PATTERNS` | `node_modules,.next,.turbo` |

#### Workspace garbage collection

The daemon periodically scans `MATO_WORKSPACES_ROOT` and reclaims disk space in three modes:

- **Full task cleanup** — when an issue's status is `done` or `cancelled` and has been idle for `MATO_GC_TTL`, the entire task directory is removed.
- **Orphan cleanup** — task directories with no `.gc_meta.json` (e.g. left over from a daemon crash) are removed once they exceed `MATO_GC_ORPHAN_TTL`.
- **Artifact-only cleanup** — when a task has been completed for at least `MATO_GC_ARTIFACT_TTL` but the issue is still open, regenerable build outputs whose directory basename matches `MATO_GC_ARTIFACT_PATTERNS` are removed; the rest of the workdir (source, `.git`, `output/`, `logs/`, `.gc_meta.json`) is preserved so the agent can resume the same workdir on the next task.

Patterns are basename-only — entries containing `/` or `\` are silently dropped — and `.git` subtrees are never descended into. The default list (`node_modules`, `.next`, `.turbo`) is intentionally narrow; extend it per deployment if your repos consistently produce other regenerable directories (for example, `MATO_GC_ARTIFACT_PATTERNS=node_modules,.next,.turbo,target,__pycache__`). To disable artifact cleanup entirely, set `MATO_GC_ARTIFACT_TTL=0`.

Agent-specific overrides:

| Variable | Description |
|----------|-------------|
| `MATO_CLAUDE_PATH` | Custom path to the `claude` binary |
| `MATO_CLAUDE_MODEL` | Override the Claude model used |
| `MATO_CLAUDE_ARGS` | Default extra arguments for Claude Code runs |
| `MATO_CODEX_PATH` | Custom path to the `codex` binary |
| `MATO_CODEX_MODEL` | Override the Codex model used |
| `MATO_CODEX_ARGS` | Default extra arguments for Codex runs |
| `MATO_COPILOT_PATH` | Custom path to the `copilot` binary |
| `MATO_COPILOT_MODEL` | Override the Copilot model used (note: GitHub Copilot routes models through your account entitlement, so this may not be honoured) |
| `MATO_OPENCODE_PATH` | Custom path to the `opencode` binary |
| `MATO_OPENCODE_MODEL` | Override the OpenCode model used |
| `MATO_OPENCLAW_PATH` | Custom path to the `openclaw` binary |
| `MATO_OPENCLAW_MODEL` | Override the OpenClaw model used |
| `MATO_HERMES_PATH` | Custom path to the `hermes` binary |
| `MATO_HERMES_MODEL` | Override the Hermes model used |
| `MATO_GEMINI_PATH` | Custom path to the `gemini` binary |
| `MATO_GEMINI_MODEL` | Override the Gemini model used |
| `MATO_PI_PATH` | Custom path to the `pi` binary |
| `MATO_PI_MODEL` | Override the Pi model used |
| `MATO_CURSOR_PATH` | Custom path to the `cursor-agent` binary |
| `MATO_CURSOR_MODEL` | Override the Cursor Agent model used |
| `MATO_KIMI_PATH` | Custom path to the `kimi` binary |
| `MATO_KIMI_MODEL` | Override the Kimi model used |
| `MATO_KIRO_PATH` | Custom path to the `kiro-cli` binary |
| `MATO_KIRO_MODEL` | Override the Kiro model used |

`MATO_CLAUDE_ARGS` and `MATO_CODEX_ARGS` are parsed with POSIX shellword quoting, so values such as `--model "gpt-5.1 codex" --sandbox read-only` are split like a shell command line. Agent arguments are applied in this order: hardcoded Multica defaults, daemon-wide env defaults, then per-agent `custom_args` from the task.

### Self-Hosted Server

When connecting to a self-hosted Multica instance, the easiest approach is:

```bash
# One command — configures for localhost, authenticates, starts daemon
mato setup self-host

# Or for on-premise with custom domains:
mato setup self-host --server-url https://api.example.com --app-url https://app.example.com
```

Or configure manually:

```bash
# Set URLs individually
mato config set server_url http://localhost:8080
mato config set app_url http://localhost:3000

# For production with TLS:
# mato config set server_url https://api.example.com
# mato config set app_url https://app.example.com

mato login
mato daemon start
```

### Profiles

Profiles let you run multiple daemons on the same machine — for example, one for production and one for a staging server.

```bash
# Set up a staging profile
mato setup self-host --profile staging --server-url https://api-staging.example.com --app-url https://staging.example.com

# Start its daemon
mato daemon start --profile staging

# Default profile runs separately
mato daemon start
```

Each profile gets its own config directory (`~/.mato/profiles/<name>/`), daemon state, health port, and workspace root.

## Workspaces

### List Workspaces

```bash
mato workspace list
```

Watched workspaces are marked with `*`. The daemon only processes tasks for watched workspaces.

### Watch / Unwatch

```bash
mato workspace watch <workspace-id>
mato workspace unwatch <workspace-id>
```

### Get Details

```bash
mato workspace get <workspace-id>
mato workspace get <workspace-id> --output json
```

### List Members

```bash
mato workspace members <workspace-id>
```

## Issues

### List Issues

```bash
mato issue list
mato issue list --status in_progress
mato issue list --priority urgent --assignee "Agent Name"
mato issue list --assignee-id 5fb87ac7-23b5-4a7a-81fa-ed295a54545d
mato issue list --full-id
mato issue list --limit 20 --output json
```

Table output shows a routable issue `KEY` such as `MUL-123`; copy that key into follow-up commands like `issue get`, `issue comment list`, `issue status`, or `--parent`. Add `--full-id` when you need canonical UUIDs. Available filters: `--status`, `--priority`, `--assignee` / `--assignee-id`, `--project`, `--limit`. Use `--assignee-id <uuid>` for unambiguous filtering when names overlap.

### Get Issue

```bash
mato issue get <id>
mato issue get <id> --output json
```

### Create Issue

```bash
mato issue create --title "Fix login bug" --description "..." --priority high --assignee "Lambda"
mato issue create --title "Fix login bug" --assignee-id 5fb87ac7-23b5-4a7a-81fa-ed295a54545d
```

Flags: `--title` (required), `--description`, `--status`, `--priority`, `--assignee` / `--assignee-id`, `--parent`, `--project`, `--due-date`. Pass `--assignee-id <uuid>` (mutually exclusive with `--assignee`) when scripting against the IDs returned by `mato workspace members --output json` / `mato agent list --output json`.

### Update Issue

```bash
mato issue update <id> --title "New title" --priority urgent
```

### Assign Issue

```bash
mato issue assign <id> --to "Lambda"
mato issue assign <id> --to-id 5fb87ac7-23b5-4a7a-81fa-ed295a54545d
mato issue assign <id> --unassign
```

Pass `--to-id <uuid>` to assign by canonical UUID (mutually exclusive with `--to`); useful when names overlap across members and agents.

### Change Status

```bash
mato issue status <id> in_progress
```

Valid statuses: `backlog`, `todo`, `in_progress`, `in_review`, `done`, `blocked`, `cancelled`.

### Comments

```bash
# List comments
mato issue comment list <issue-id>

# Add a comment
mato issue comment add <issue-id> --content "Looks good, merging now"

# Reply to a specific comment
mato issue comment add <issue-id> --parent <comment-id> --content "Thanks!"

# Delete a comment
mato issue comment delete <comment-id>
```

### Subscribers

```bash
# List subscribers of an issue
mato issue subscriber list <issue-id>

# Subscribe yourself to an issue
mato issue subscriber add <issue-id>

# Subscribe another member or agent by name
mato issue subscriber add <issue-id> --user "Lambda"

# Unsubscribe yourself
mato issue subscriber remove <issue-id>

# Unsubscribe another member or agent
mato issue subscriber remove <issue-id> --user "Lambda"
```

Subscribers receive notifications about issue activity (new comments, status changes, etc.). Without `--user`, the command acts on the caller.

### Execution History

```bash
# List all execution runs for an issue
mato issue runs <issue-id>
mato issue runs <issue-id> --full-id
mato issue runs <issue-id> --output json

# View messages for a specific execution run
mato issue run-messages <task-id>
mato issue run-messages <short-task-id> --issue <issue-id>
mato issue run-messages <task-id> --output json

# Incremental fetch (only messages after a given sequence number)
mato issue run-messages <task-id> --since 42 --output json
```

The `runs` command shows all past and current executions for an issue, including running tasks. Table output uses short task UUID prefixes by default; pass `--full-id` to print canonical task UUIDs. The `run-messages` command accepts full task UUIDs directly; copied short task prefixes must be scoped with `--issue <issue-id>` so the CLI only checks that issue's runs. It shows the detailed message log (tool calls, thinking, text, errors) for a single run. Use `--since` for efficient polling of in-progress runs.

## Projects

Projects group related issues (e.g. a sprint, an epic, a workstream). Every project
belongs to a workspace and can optionally have a lead (member or agent).

### List Projects

```bash
mato project list
mato project list --status in_progress
mato project list --output json
```

Available filters: `--status`.

### Get Project

```bash
mato project get <id>
mato project get <id> --output json
```

### Create Project

```bash
mato project create --title "2026 Week 16 Sprint" --icon "🏃" --lead "Lambda"
```

Flags: `--title` (required), `--description`, `--status`, `--icon`, `--lead`.

### Update Project

```bash
mato project update <id> --title "New title" --status in_progress
mato project update <id> --lead "Lambda"
```

Flags: `--title`, `--description`, `--status`, `--icon`, `--lead`.

### Change Status

```bash
mato project status <id> in_progress
```

Valid statuses: `planned`, `in_progress`, `paused`, `completed`, `cancelled`.

### Delete Project

```bash
mato project delete <id>
```

### Associating Issues with Projects

Use the `--project` flag on `issue create` / `issue update` to attach an issue to a
project, or on `issue list` to filter issues by project:

```bash
mato issue create --title "Login bug" --project <project-id>
mato issue update <issue-id> --project <project-id>
mato issue list --project <project-id>
```

## Setup

```bash
# One-command setup for Multica Cloud: configure, authenticate, and start the daemon
mato setup

# For local self-hosted deployments
mato setup self-host

# Custom ports
mato setup self-host --port 9090 --frontend-port 4000

# On-premise with custom domains
mato setup self-host --server-url https://api.example.com --app-url https://app.example.com
```

`mato setup` configures the CLI, opens your browser for authentication, and starts the daemon — all in one step. Use `mato setup self-host` to connect to a self-hosted server instead of Multica Cloud.

## Configuration

### View Config

```bash
mato config show
```

Shows config file path, server URL, app URL, and default workspace.

### Set Values

```bash
mato config set server_url https://api.example.com
mato config set app_url https://app.example.com
mato config set workspace_id <workspace-id>
```

## Autopilot Commands

Autopilots are scheduled/triggered automations that dispatch agent tasks (either by creating an issue or by running an agent directly).

### List Autopilots

```bash
mato autopilot list
mato autopilot list --full-id
mato autopilot list --status active --output json
```

Autopilot table IDs are short UUID prefixes; follow-up autopilot commands accept copied prefixes when they are unique in the current workspace. Use `--full-id` to print canonical UUIDs.

### Get Autopilot Details

```bash
mato autopilot get <id>
mato autopilot get <id> --output json   # includes triggers
```

### Create / Update / Delete

```bash
mato autopilot create \
  --title "Nightly bug triage" \
  --description "Scan todo issues and prioritize." \
  --agent "Lambda" \
  --mode create_issue

mato autopilot update <id> --status paused
mato autopilot update <id> --description "New prompt"
mato autopilot delete <id>
```

`--mode` currently only accepts `create_issue` (creates a new issue on each run and assigns it to the agent). The server data model also defines `run_only`, but the daemon task path doesn't yet resolve a workspace for runs without an issue, so it's not exposed by the CLI. `--agent` accepts either a name or UUID.

### Manual Trigger

```bash
mato autopilot trigger <id>            # Fires the autopilot once, returns the run
```

### Run History

```bash
mato autopilot runs <id>
mato autopilot runs <id> --limit 50 --output json
```

### Schedule Triggers

```bash
mato autopilot trigger-add <autopilot-id> --cron "0 9 * * 1-5" --timezone "America/New_York"
mato autopilot trigger-update <autopilot-id> <trigger-id> --enabled=false
mato autopilot trigger-delete <autopilot-id> <trigger-id>
```

Only cron-based `schedule` triggers are currently exposed via the CLI. The data model also defines `webhook` and `api` kinds, but there is no server endpoint that fires them yet, so they're not surfaced here.

## Other Commands

```bash
mato version              # Show CLI version and commit hash
mato update               # Update to latest version
mato agent list           # List agents in the current workspace
```

## Output Formats

Most commands support `--output` with two formats:

- `table` — human-readable table (default for list commands)
- `json` — structured JSON (useful for scripting and automation)

```bash
mato issue list --output json
mato daemon status --output json
```
