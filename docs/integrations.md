# Integrations

## How Multica Connects to Agent CLIs

The core integration model is: Multica does not run agent CLIs directly. Instead, a local daemon process (which the user runs on their machine) spawns agent CLI subprocesses and acts as the bridge between Multica's server and the actual AI agent.

```
Multica Server
     ↕  (WebSocket + HTTP)
   Daemon  ← You install this; it runs on your machine or CI
     ↕  (subprocess stdin/stdout)
   Agent CLI  ← Claude Code, Codex, Cursor, etc.
```

---

## The Integration Contract

Every agent CLI adapter implements this Go interface (`server/pkg/agent/agent.go`):

```go
type Backend interface {
    Execute(ctx context.Context, prompt string, opts ExecOptions) (*Session, error)
}

type ExecOptions struct {
    Cwd                       string
    Model                     string
    SystemPrompt              string
    MaxTurns                  int
    Timeout                   time.Duration
    SemanticInactivityTimeout time.Duration
    ResumeSessionID           string       // Resume a previous session
    ExtraArgs                 []string     // Daemon-wide CLI args
    CustomArgs                []string     // Per-agent CLI args
    McpConfig                 json.RawMessage  // MCP server configuration
}

type Session struct {
    Messages <-chan Message   // Stream of events during execution
    Result   <-chan Result    // Final outcome (exactly one value)
}
```

The daemon calls `backend.Execute(ctx, prompt, opts)` and then:
1. Reads messages from `Session.Messages` and forwards them to the server
2. Waits on `Session.Result` for the final outcome
3. Reports success or failure to the server

---

## Supported Agent Providers

| Provider | File | CLI Tool | Notes |
|----------|------|---------|-------|
| Claude Code | `server/pkg/agent/claude.go` | `claude` | Anthropic's coding agent |
| OpenAI Codex | `server/pkg/agent/codex.go` | `codex` | OpenAI's CLI |
| GitHub Copilot | `server/pkg/agent/copilot.go` | `gh copilot` | GitHub CLI extension |
| Cursor | `server/pkg/agent/cursor.go` | `cursor` | Cursor editor agent |
| Google Gemini | `server/pkg/agent/gemini.go` | `gemini` | Google's CLI |
| Hermes ACP | `server/pkg/agent/hermes.go` | `hermes` | Uses ACP (Agent Communication Protocol) |
| Kimi | `server/pkg/agent/kimi.go` | `kimi` | Moonshot AI |
| Kiro | `server/pkg/agent/kiro.go` | `kiro` | AWS's coding agent |
| OpenClaw | `server/pkg/agent/openclaw.go` | `openclaw` | Open source |
| OpenCode | `server/pkg/agent/opencode.go` | `opencode` | Open source |
| Pi | `server/pkg/agent/pi.go` | `pi` | Inflection AI |

Each adapter handles:
- Detecting whether the CLI is installed (`DetectVersion`)
- Constructing the command line arguments
- Parsing the output stream (JSON events from the CLI)
- Mapping CLI output to the unified `agent.Message` type

---

## How Version Detection Works

Before registering a runtime, the daemon checks whether the agent CLI is installed and at a supported minimum version:

```go
// server/pkg/agent/version.go
func DetectVersion(provider string) (string, error) {
    // Runs e.g.: claude --version
    // Returns parsed version string
}

func CheckMinVersion(provider, version string) error {
    // Returns error if version < minimum required
}
```

This prevents the daemon from registering runtimes for CLIs that are too old to work with the expected prompt format.

---

## How to Add a New Agent Provider

To integrate a new coding agent CLI, you need to:

### 1. Create the adapter file

Create `server/pkg/agent/mynewagent.go`:

```go
package agent

import (
    "context"
    "bufio"
    "encoding/json"
    "os/exec"
)

type MyNewAgentBackend struct{}

func (b *MyNewAgentBackend) Execute(ctx context.Context, prompt string, opts ExecOptions) (*Session, error) {
    // Build the command
    args := []string{"--prompt", prompt}
    if opts.Model != "" {
        args = append(args, "--model", opts.Model)
    }
    args = append(args, opts.ExtraArgs...)
    args = append(args, opts.CustomArgs...)
    
    cmd := exec.CommandContext(ctx, "mynewagent", args...)
    cmd.Dir = opts.Cwd
    
    stdout, err := cmd.StdoutPipe()
    if err != nil {
        return nil, err
    }
    
    if err := cmd.Start(); err != nil {
        return nil, err
    }
    
    messages := make(chan Message, 100)
    result := make(chan Result, 1)
    
    go func() {
        defer close(messages)
        defer close(result)
        
        scanner := bufio.NewScanner(stdout)
        for scanner.Scan() {
            line := scanner.Text()
            // Parse the CLI's JSON output format and emit Messages
            // The Message type has: Type, Content, Tool, CallID, Input, Output, Status
            msg := parseMyNewAgentOutput(line)
            messages <- msg
        }
        
        exitErr := cmd.Wait()
        if exitErr != nil {
            result <- Result{Error: exitErr.Error()}
        } else {
            result <- Result{Success: true}
        }
    }()
    
    return &Session{Messages: messages, Result: result}, nil
}
```

### 2. Add version detection

```go
// In server/pkg/agent/version.go (or your new file)
func init() {
    registerVersionCheck("mynewagent", func() (string, error) {
        // Run: mynewagent --version
        // Parse and return version string
    })
}
```

### 3. Register the provider

In `server/pkg/agent/agent.go`, add your backend to the provider registry:

```go
func NewBackend(provider string) (Backend, error) {
    switch provider {
    case "claude":
        return &ClaudeBackend{}, nil
    case "codex":
        return &CodexBackend{}, nil
    // ...
    case "mynewagent":
        return &MyNewAgentBackend{}, nil
    default:
        return nil, fmt.Errorf("unknown provider: %s", provider)
    }
}
```

### 4. Add the launch header

```go
// In server/pkg/agent/agent.go
func LaunchHeader(provider string) string {
    // Returns the CLI command name shown in the UI
    switch provider {
    case "mynewagent":
        return "mynewagent"
    // ...
    }
}
```

### 5. Test it

Add `server/pkg/agent/mynewagent_test.go` with a test that:
- Mocks the CLI subprocess (use the exec fixture pattern from existing tests)
- Verifies the output parsing produces correct `Message` types
- Verifies error handling

---

## GitHub Integration

Multica has a GitHub App integration for linking PRs to issues.

### Setup Flow

1. User clicks "Connect GitHub" in workspace settings
2. Browser redirects to GitHub OAuth flow with app installation URL
3. User installs the Multica GitHub App on their GitHub account/org
4. GitHub redirects back to `GET /api/workspaces/{slug}/github/callback`
5. Server stores the installation in `github_installation`

### Webhook Flow

GitHub sends events to `POST /api/webhooks/github`:

1. Server validates the HMAC-SHA256 signature using the webhook secret
2. Server processes the event type (push, pull_request, etc.)
3. For PR events, server upserts the PR in `github_pull_request`
4. If a PR URL matches an `agent_task_queue` result, links issue to PR via `issue_pull_request`

### PR Linking Logic

When an agent completes a task with a PR URL:
1. Server extracts the PR URL from the completion payload
2. Looks up the `github_installation` for the workspace
3. Upserts the `github_pull_request` row
4. Creates the `issue_pull_request` link

This means PRs appear linked to issues even if the webhook hasn't fired yet — the task completion creates the link proactively.

---

## Email Integration

Two email backends are supported:

### Resend API

```
RESEND_API_KEY=re_...
```

The server uses the Resend API to send transactional emails (verification codes, invitations, notifications).

### SMTP

```
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_USER=user@example.com
SMTP_PASSWORD=...
SMTP_FROM=noreply@example.com
```

Standard SMTP relay, useful for self-hosted instances or corporate email servers.

### Development Mode

If neither is configured, the verification code is printed to the server log:
```
WARN: no email backend configured — printing verification code to log: 123456
```

The `MULTICA_DEV_VERIFICATION_CODE` env var sets a static code (useful for automated tests):
```
MULTICA_DEV_VERIFICATION_CODE=000000
```
This is rejected if `APP_ENV=production`.

---

## File Storage

### AWS S3 (Primary)

```
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
AWS_S3_BUCKET=multica-uploads
```

Files are uploaded to S3. URLs are either direct S3 URLs or CloudFront signed URLs:

```
CLOUDFRONT_DOMAIN=d1234.cloudfront.net
CLOUDFRONT_KEY_PAIR_ID=K1234ABCDE
CLOUDFRONT_PRIVATE_KEY=<PEM-encoded private key>
```

With CloudFront signing, URLs expire after a configurable time, preventing hotlinking.

### Local Storage (Fallback)

Without AWS credentials, files are stored locally in an `uploads/` directory and served at `/uploads/*`. This is only suitable for development or small self-hosted instances.

---

## Analytics

The analytics client is pluggable via the `analytics.Client` interface:

```go
type Client interface {
    Track(event Event) error
    Close() error
}
```

The `analytics.NewFromEnv()` factory reads environment variables to determine which implementation to use. The `analytics.NoopClient` is used when no analytics backend is configured.

To add a new analytics backend (Segment, Amplitude, Mixpanel, etc.), implement the `Client` interface and add it to `NewFromEnv()`.

---

## MCP (Model Context Protocol)

The `mcp_config` JSONB column on the `agent` table allows configuring MCP servers for an agent. MCP is Anthropic's standard for giving AI models access to external tools and data sources.

```json
{
  "servers": [
    {
      "name": "github",
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"]
    }
  ]
}
```

When the daemon spawns the agent, it passes the MCP config via `--mcp-config` to the agent CLI (currently implemented for Claude Code). The agent CLI handles the MCP connection — Multica just passes the configuration through.

This means any MCP-compatible tool can be made available to agents without changes to Multica's core code. You configure MCP servers per-agent in the UI or via the API.

---

## Redis

Redis is an optional infrastructure dependency that unlocks horizontal scaling and performance features:

| Feature | Without Redis | With Redis |
|---------|--------------|------------|
| Realtime events | Single-node in-memory broadcast | Multi-node Redis Streams relay |
| PAT cache | In-memory per-node | Shared across all nodes |
| Daemon token cache | In-memory per-node | Shared across all nodes |
| Model list store | In-memory per-node | Shared, survives restarts |
| Local skill list store | In-memory per-node | Shared, survives restarts |
| Heartbeat liveness store | In-memory per-node | Shared, crash-safe |

Without Redis, Multica runs correctly on a single node. With Redis, it can scale horizontally. The environment variable is simply `REDIS_URL=redis://localhost:6379`.
