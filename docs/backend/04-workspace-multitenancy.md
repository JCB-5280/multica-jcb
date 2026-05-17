# Backend: Workspace and Multi-Tenancy Logic

## Current Architecture: Logical Multi-Tenancy

Multica uses **logical multi-tenancy** — all workspaces share the same database, and isolation is enforced at the application layer via `workspace_id` column filters on every query.

This is the standard approach for many SaaS products (it's how Linear, Notion, and others work), but it requires strict discipline: every query that touches workspace data must include `workspace_id` in its WHERE clause.

---

## The Workspace Data Model

```sql
CREATE TABLE workspace (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    slug TEXT UNIQUE NOT NULL,       -- URL-safe identifier, e.g. "my-team"
    description TEXT,
    settings JSONB NOT NULL DEFAULT '{}',
    issue_prefix TEXT,               -- e.g. "MUL" for issue IDs like MUL-42
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE member (
    workspace_id UUID NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
    UNIQUE(workspace_id, user_id)    -- One role per user per workspace
);
```

Every other table that contains workspace-scoped data has a `workspace_id UUID NOT NULL REFERENCES workspace(id) ON DELETE CASCADE` column. The cascade delete means that deleting a workspace deletes all its agents, issues, comments, tasks, skills, etc.

---

## How the Workspace ID Flows Through a Request

Every API request that touches workspace data must include the workspace identifier. There are two ways to provide it:

### 1. `X-Workspace-ID` Header (UUID)
Direct UUID. Used by the desktop app and CLI.

### 2. `X-Workspace-Slug` Header or URL Parameter (slug)
Human-readable identifier. The middleware resolves it to a UUID via a DB lookup.

The middleware (`internal/middleware/workspace.go`) handles this resolution transparently:

```go
func RequireWorkspaceMember(queries *db.Queries) func(http.Handler) http.Handler {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            // Resolve workspace from header or URL
            workspaceID := resolveWorkspaceID(r, queries)
            if workspaceID == "" {
                writeError(w, http.StatusNotFound, "workspace not found")
                return
            }
            
            // Verify the requesting user is a member
            userID := r.Header.Get("X-User-ID")
            member, err := queries.GetMemberByUserAndWorkspace(ctx, ...)
            if err != nil {
                writeError(w, http.StatusForbidden, "not a member")
                return
            }
            
            // Store both in context for downstream handlers
            ctx = context.WithValue(ctx, workspaceIDKey, workspaceID)
            ctx = context.WithValue(ctx, memberKey, member)
            next.ServeHTTP(w, r.WithContext(ctx))
        })
    }
}
```

---

## Workspace Slug System

The slug (`/workspaces/my-team`) is the workspace's public identifier in URLs. It must be:
- Lowercase alphanumeric with hyphens: `^[a-z][a-z0-9-]*[a-z0-9]$`
- Globally unique (enforced by the UNIQUE constraint on `workspace.slug`)
- Not on the reserved slug list

### Reserved Slugs

The reserved slug list lives in `server/internal/handler/reserved_slugs.json`. This is the single source of truth. A TypeScript mirror (`packages/core/paths/reserved-slugs.ts`) is auto-generated from it.

Reserved slugs protect system routes. Examples: `login`, `logout`, `api`, `admin`, `settings`, `issues`, `agents`. Any slug that matches a top-level route in the web app must be reserved, otherwise a workspace named "settings" would conflict with the `/settings` route.

**When you add a new top-level route**, you must add it to the JSON file, run `pnpm generate:reserved-slugs` to regenerate the TypeScript file, and commit both. CI validates that the generated file matches the JSON.

### Issue Prefixes

Each workspace gets an `issue_prefix` (e.g., "MUL" for a workspace named "Multica"). Issues are then addressable as `MUL-1`, `MUL-2`, etc. The prefix is stored on the workspace row. If a workspace predates the issue_prefix feature, the prefix is generated from the workspace name on the fly.

The `loadIssueForUser()` function in handler.go accepts both UUID format and `PREFIX-N` format for the issue ID parameter. This is how agents can reference issues by human-readable identifier in their prompts.

---

## Role-Based Access Control

The three roles are: `owner`, `admin`, `member`.

| Action | owner | admin | member |
|--------|-------|-------|--------|
| View workspace content | ✓ | ✓ | ✓ |
| Create/edit issues | ✓ | ✓ | ✓ |
| Create/edit agents | ✓ | ✓ | ✓ |
| Invite members | ✓ | ✓ | ✗ |
| Remove members | ✓ | ✓ | ✗ |
| Change member roles | ✓ | ✗ | ✗ |
| Delete workspace | ✓ | ✗ | ✗ |
| Create daemon tokens | ✓ | ✓ | ✗ |

The `requireWorkspaceRole()` helper enforces this in handlers:

```go
member, ok := h.requireWorkspaceRole(w, r, workspaceID, "workspace not found", "owner", "admin")
if !ok {
    return // already wrote 403
}
```

**Owner protection:** There must always be at least one owner. Removing or demoting the last owner is blocked. This prevents workspace orphaning.

---

## Membership Checks on Every Request

The middleware chain ensures that:
1. The JWT is valid → user exists
2. The workspace slug/ID resolves to a real workspace
3. The user is a member of that workspace
4. The member's role is stored in request context

This happens before any handler code runs. Handlers pull `ctxMember(r.Context())` to get the authenticated member, and `ctxWorkspaceID(r.Context())` to get the workspace ID.

The only routes that bypass workspace membership checks are:
- `/api/auth/*` — authentication endpoints
- `/api/workspaces` (GET) — listing user's workspaces
- `/api/me` — current user info
- Daemon-specific endpoints (which have their own auth via daemon token)

---

## Workspace Isolation Guarantees

**At the database level:**
- All workspace-scoped tables have `workspace_id UUID NOT NULL`
- The `GetIssueInWorkspace` query pattern verifies both `id = $1 AND workspace_id = $2`
- Workspace cascade delete is the cleanup mechanism

**At the application level:**
- Every query that fetches a single entity by ID uses the "InWorkspace" variant which adds the `workspace_id` filter
- Cross-workspace data leakage would require a developer to bypass the middleware AND use a bare `GetIssue` instead of `GetIssueInWorkspace` — both are needed for a leak

**What this doesn't guarantee:**
- Database-level row-level security (RLS) is not used — isolation is purely at the application layer
- A bug in handler code could expose cross-workspace data (there have been incidents historically, referenced as #2143, #2147, #2192 in the codebase comments)
- For a high-compliance SaaS product, Postgres RLS or separate schemas per tenant would be stronger guarantees

---

## Workspace Invitations

Workspace members can invite new users via email:

1. `POST /api/workspaces/{slug}/invitations` → creates `invitation` row with a unique token and expiry
2. Server emails the invitee with a link containing the token
3. Invitee clicks link → `POST /api/invitations/{token}/accept`
4. Server creates the `member` row and deletes the invitation

The invitation system is separate from the `verification_code` table used for login. Invitations have their own token format and expiry.

---

## Daemon Token Scoping

Daemon tokens (`mdt_...`) are scoped to a workspace:

```sql
CREATE TABLE daemon_token (
    token_hash TEXT UNIQUE NOT NULL,
    workspace_id UUID NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    daemon_id TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL
);
```

When a daemon authenticates with a daemon token, the middleware extracts the workspace ID from the token and stores it in context. All daemon API calls are then automatically scoped to that workspace — the daemon cannot access any other workspace's data with that token.

---

## Multi-Workspace Users

A single user can belong to multiple workspaces. The `user` table is workspace-agnostic — it's the `member` table that creates the workspace relationship. 

When a user logs in and opens the app:
1. `GET /api/workspaces` returns all workspaces the user is a member of
2. The user selects a workspace (or the last-used one is auto-selected)
3. All subsequent API calls include `X-Workspace-ID` for that workspace

The desktop app maintains tabs per workspace — switching workspaces changes which set of tabs is visible and which WebSocket connection is active.

---

## What Would Need to Change for SaaS

See `what-to-change-for-saas.md` for a full analysis. The short version: the current multi-tenancy model works correctly and is a reasonable foundation. The main gaps are around billing, signup control, and stronger isolation guarantees for high-compliance use cases.

The `AllowSignup`, `AllowedEmails`, and `AllowedEmailDomains` config fields in `handler.Config` are currently the only mechanism to control who can create accounts. For SaaS, you would replace this with a proper registration/subscription flow.
