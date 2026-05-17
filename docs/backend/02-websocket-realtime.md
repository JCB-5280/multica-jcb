# Backend: WebSocket and Real-Time Updates

## What It Is

Multica has two WebSocket subsystems with completely different purposes:

1. **The Realtime Hub** (`internal/realtime/`) — pushes events to browsers and the desktop app
2. **The Daemon Hub** (`internal/daemonws/`) — communicates with local agent daemon processes

These are separate TCP endpoints, separate authentication systems, and separate message protocols. Do not confuse them.

---

## The Realtime Hub (Browser-Facing)

### Purpose

Every time data changes in the database, the browser needs to know immediately. The Realtime Hub is the broadcast system that achieves this. When you update an issue, every browser connected to that workspace sees the change within milliseconds — no polling required.

### Connection Flow

```
Browser → GET /api/ws?workspace_slug=myworkspace
         (HTTP → WebSocket upgrade)

Server: gorilla/websocket upgrades the connection
      ↓
      Validates origin (ALLOWED_ORIGINS / FRONTEND_ORIGIN env var)
      ↓
      Waits for auth message (or reads JWT from cookie)
        { type: "auth", payload: { token: "JWT..." } }
        — OR —
        Cookie: multica_auth=... (cookie-based sessions)
      ↓
      Validates JWT → extracts user_id
      ↓
      Looks up workspace by slug → gets workspace_id
      ↓
      Verifies user is a member of this workspace
      ↓
      Registers connection in Hub (keyed by workspace_id)
      ↓
      Sends { type: "auth_ack" } back to browser
      ↓
      Connection stays open; server pushes events as they occur
```

### Scope Subscriptions

After connecting, clients can subscribe to more specific "scopes" beyond the workspace:

```javascript
// Subscribe to a specific task's messages
ws.send(JSON.stringify({
  type: "subscribe",
  payload: { scope_type: "task", scope_id: "<task_uuid>" }
}))

// Subscribe to a specific chat session
ws.send(JSON.stringify({
  type: "subscribe",
  payload: { scope_type: "chat_session", scope_id: "<session_uuid>" }
}))
```

The server validates that the requested resource belongs to the user's workspace before allowing the subscription. This prevents a user in workspace A from subscribing to events in workspace B. The `ScopeAuthorizer` interface handles this check, and positive results are cached to avoid hot-path DB load.

### Event Types

Every event follows the envelope: `{ type: "<event_type>", payload: {...}, actor_id?: "...", actor_type?: "..." }`

| Event Type | When It Fires | What's In the Payload |
|-----------|--------------|----------------------|
| `issue:created` | New issue created | Full issue object |
| `issue:updated` | Issue fields changed | Updated issue object |
| `issue:deleted` | Issue deleted | `{ id }` |
| `comment:created` | New comment posted | Full comment object |
| `comment:updated` | Comment edited | Updated comment |
| `comment:deleted` | Comment deleted | `{ id }` |
| `comment:resolved` | Comment thread resolved | Updated comment |
| `task:queued` | Task added to queue | Task object |
| `task:dispatch` | Task started by daemon | Task object |
| `task:progress` | Agent sent a progress update | `{ task_id, summary, step, total }` |
| `task:message` | Single agent execution message | `{ task_id, seq, type, tool, content, ... }` |
| `task:completed` | Agent finished the task | Task object + result |
| `task:failed` | Agent failed the task | Task object + error |
| `task:cancelled` | Task manually cancelled | Task object |
| `agent:status` | Agent status changed | Agent object |
| `agent:created` | New agent created | Agent object |
| `agent:archived` | Agent archived | `{ id }` |
| `daemon:heartbeat` | Daemon runtime heartbeat | `{ runtime_id, status }` |
| `skill:created` / `updated` / `deleted` | Skill changes | Skill object or `{ id }` |
| `chat:message` | New chat message | Message object |
| `chat:done` | Agent finished chat response | Full assistant message |
| `workspace:updated` | Workspace settings changed | Workspace object |
| `member:added` / `updated` / `removed` | Membership changes | Member object |
| `inbox:new` | New notification | Inbox item |
| `project:created` / `updated` / `deleted` | Project changes | Project object |
| `squad:created` / `updated` / `deleted` | Squad changes | Squad object |
| `github_installation:created` / `deleted` | GitHub integration | Installation object |
| `pull_request:linked` / `updated` / `unlinked` | PR changes | PR object |

### Multi-Node Scaling with Redis

In single-node mode (no `REDIS_URL`), the Hub broadcasts in memory. This works fine for a single server but breaks when you run multiple API nodes — only clients connected to the same node that processed the request would receive the event.

With Redis enabled, the server writes events to Redis Streams and all nodes subscribe to read from those streams:

```
Node A processes a request → publishes event to Redis Stream
Node B reads from Redis Stream → delivers to its connected clients
Node A also reads its own stream → delivers to its connected clients
```

Three relay modes exist:

| Mode | Description | Use Case |
|------|-------------|----------|
| `sharded` | Multiple Redis stream shards, round-robin write, all-shard read | Default — best performance at scale |
| `legacy` | Single Redis pub/sub channel | Old mode, simpler but bottlenecked |
| `dual` | Both sharded + legacy simultaneously | Zero-downtime migration from legacy to sharded |

The number of shards (`REALTIME_RELAY_SHARDS`, default 8) controls throughput. Each shard is an independent Redis Stream key. Events are written to a shard deterministically by workspace ID (so all events for a workspace land on the same shard, preserving ordering).

**Important for SaaS:** The Redis relay is how you scale past one API node. Without it, load-balancing the API would break real-time updates.

---

## The Daemon Hub (Agent-Facing)

### Purpose

The Daemon Hub is a completely separate WebSocket endpoint (`/api/daemon/ws`) used by the local agent daemon process. It serves two main purposes:

1. **Wakeup notifications** — the server can push a `task:available` message to the daemon instead of waiting for the daemon to poll
2. **Daemon registration** — the daemon announces which runtimes it manages

### Connection Flow

```
Daemon → GET /api/daemon/ws
       (HTTP → WebSocket upgrade with daemon token auth)

Server: validates daemon token (mdt_...) from Authorization header
      ↓
      Daemon sends DaemonRegisterPayload:
        { daemon_id: "...", agent_id: "...", runtimes: [...] }
      ↓
      Server registers connection in DaemonHub (keyed by runtime_id)
      ↓
      Connection stays open
      ↓
      Server can push { type: "task:available", payload: { runtime_id, task_id } }
      ↓
      Daemon immediately calls ClaimTask HTTP endpoint (doesn't wait for next poll)
```

### Why This Design?

The daemon polls for tasks on a regular interval anyway. The WebSocket wakeup is an optimization: instead of waiting up to N seconds for the next poll, the daemon gets an immediate nudge. The actual task claim still happens via HTTP (not WebSocket), keeping the claim logic stateful and atomic.

This design also means that if the daemon's WebSocket connection drops, task assignment is not broken — the daemon falls back to polling. The WebSocket is a latency optimization, not a correctness requirement.

### Daemon Heartbeat

The daemon sends periodic heartbeats to keep its runtimes marked as "online." These can go via:
1. HTTP: `POST /api/runtimes/{id}/heartbeat` 
2. WebSocket: `{ type: "heartbeat", payload: { runtime_id } }`

The server's `BatchedHeartbeatScheduler` batches these writes to avoid database write amplification. In a large deployment with many runtimes, this prevents thousands of individual DB writes per minute.

---

## The Event Bus (Internal)

Below the WebSocket layer is an in-process event bus (`internal/events/bus.go`). This is not WebSocket — it's a Go pub/sub system used internally between handler code and various listeners.

```go
type Bus struct {
    // map of event type → list of handlers
}

func (b *Bus) Publish(event Event) { ... }
func (b *Bus) Subscribe(eventType string, handler func(Event)) { ... }
```

Registered listeners include:

| Listener | Effect |
|----------|--------|
| Realtime broadcaster | Converts bus events into WebSocket broadcasts |
| Activity listener | Writes to `activity_log` table |
| Subscriber listener | Updates `issue_subscriber` table when issues change hands |
| Notification listener | Creates `inbox_item` rows for relevant parties |
| Autopilot listener | Triggers autopilot runs when issues close |

**The weakness of this design:** The event bus is in-memory and in-process. If a listener throws an exception or the process crashes after a DB write but before publishing the event, the WebSocket broadcast is lost. There is no durable queue guaranteeing delivery. For most real-time updates this is fine (the next page load will fetch fresh data), but for billing or audit events in a SaaS product, you would want a durable queue (e.g., a `events` table with a background consumer, or a proper message broker).

---

## Frontend WebSocket Integration

On the browser side, `packages/core/api/ws-client.ts` manages the WebSocket connection.

Key behaviors:
- **Token security:** In cookie-mode auth, the token is never sent as a URL parameter (which would be logged by proxies). It's sent as the first WebSocket message after connection opens.
- **Automatic reconnect:** The client reconnects with exponential backoff after disconnect. On reconnect, it fires `onReconnect` callbacks so components can refresh their data.
- **Scope subscriptions:** Components can subscribe to specific task or chat session scopes for fine-grained updates.
- **Event handler registration:** `ws.on("issue:updated", handler)` pattern. Multiple handlers can listen to the same event type.

### How the UI Uses Events

```typescript
// packages/core/realtime/use-realtime-sync.ts
useEffect(() => {
  const unsub = wsClient.on("issue:updated", (payload) => {
    // Invalidate the query cache so TanStack Query refetches
    queryClient.invalidateQueries({ queryKey: ["issues", wsId] })
    // Or directly update the cache with the payload (if shape matches)
    queryClient.setQueryData(["issue", wsId, payload.id], payload)
  })
  return unsub
}, [wsId])
```

The pattern is: WebSocket events invalidate query caches. They don't write to Zustand stores directly. The cache (TanStack Query) is the single source of truth for server data.

---

## What a Developer Must Know Before Modifying

1. **Adding a new event type:** Define it in `packages/core/types/events.ts`, add it to the event bus publish call in the Go handler, and add a listener in the frontend's `use-realtime-sync.ts`. The WSEventType union in TypeScript must stay in sync with the Go `events.go` constants.

2. **Scope authorization:** If you add a new subscribable scope (e.g., a "project" scope), you must add it to the `ScopeAuthorizer` implementation with a DB lookup to verify ownership.

3. **Redis shard count:** Once deployed, changing `REALTIME_RELAY_SHARDS` requires draining all stream consumers first. Do not change this in production without a migration plan.

4. **The dual relay mode** is a migration tool, not a permanent state. When migrating from legacy to sharded, use dual mode briefly, then switch to sharded once all consumers have upgraded.

5. **The in-process bus is not retryable.** If you need guaranteed delivery (e.g., you're adding a billing event), consider writing to a dedicated DB table that a background worker consumes.
