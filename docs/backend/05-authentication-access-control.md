# Backend: Authentication and Access Control

## Authentication Methods

Multica supports three authentication methods:

| Method | Token Format | Used By | Lifetime |
|--------|-------------|---------|---------|
| Email magic-link + JWT | HttpOnly cookie | Web browser sessions | Hours (configurable) |
| Personal Access Token (PAT) | `mul_` prefix | CLI, API integrations, desktop | Until revoked (or explicit expiry) |
| Daemon Token | `mdt_` prefix | Local agent daemon process | Short-lived, workspace-scoped |

---

## Email Magic-Link Flow

Multica does not use passwords. Authentication is via a 6-digit verification code sent to the user's email.

**Step 1: Request a code**
```
POST /api/auth/login
{ "email": "user@example.com" }
```
- Server generates a 6-digit numeric code
- Stores a hashed version with expiry in the `verification_code` table
- Sends the code via Resend API (or SMTP if configured)
- If neither email backend is configured, prints the code to the server log (development only)
- If `MATO_DEV_VERIFICATION_CODE` env var is set (non-production only), that static value is accepted as a valid code

**Step 2: Verify the code**
```
POST /api/auth/verify
{ "email": "user@example.com", "code": "123456" }
```
- Server looks up the code by email, checks expiry, increments attempt counter
- If invalid: returns 401; too many attempts: returns 429
- If valid:
  - Creates user account if this is their first login (`INSERT OR IGNORE`)
  - Issues a JWT signed with `JWT_SECRET` env var
  - Sets the JWT as an HttpOnly cookie `mato_auth`
  - Also returns the JWT in the response body (for non-cookie clients)
  - Deletes the verification_code row

**The JWT payload contains:**
- `sub`: user UUID
- `email`: user's email address
- `iat`, `exp`: issued-at and expiry timestamps

**CSRF protection for cookie auth:**
State-changing requests (POST, PATCH, PUT, DELETE) that use the cookie must include:
- `X-CSRF-Token` header with a CSRF token, OR
- `_csrf` form field

Requests using the `Authorization: Bearer <token>` header bypass CSRF (the token itself is the proof of intent).

---

## Personal Access Tokens (PAT)

PATs allow programmatic access to the API without a browser session. They are the primary auth mechanism for the CLI and for API integrations.

**Format:** `mul_` followed by 40 random hex characters (20 bytes of entropy)

**Storage:** Only the SHA-256 hash of the token is stored in the database. The plaintext token is shown once at creation time and never again.

```sql
CREATE TABLE personal_access_token (
    id UUID PRIMARY KEY,
    token_hash TEXT UNIQUE NOT NULL,   -- SHA-256(token)
    user_id UUID NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    workspace_id UUID REFERENCES workspace(id) ON DELETE CASCADE, -- optional scope
    name TEXT NOT NULL,
    expires_at TIMESTAMPTZ,           -- NULL = never expires
    last_used_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

**PAT caching:** The `auth.PATCache` caches positive PAT lookups with a short TTL (~5 minutes by default). On a cache hit, the server skips both the DB lookup and the `last_used_at` update. This means `last_used_at` is accurate to within the TTL window, not per-request. The cache is in-memory (or Redis if available).

---

## Daemon Tokens

Daemon tokens are workspace-scoped short-lived tokens used by the local daemon process. They allow the daemon to make API calls as a daemon identity (not as any specific user).

**Format:** `mdt_` followed by 40 random hex characters

**Key properties:**
- Scoped to a specific workspace (the daemon can only access that workspace's data)
- Has an expiry time (enforced — expired tokens are rejected)
- Tied to a `daemon_id` for audit logging
- Cached similarly to PATs

**When the daemon authenticates**, the middleware extracts the workspace_id from the token and sets it in context. All downstream handlers use `DaemonWorkspaceIDFromContext()` to get this value, ensuring the daemon cannot access other workspaces.

---

## Authentication Middleware

The middleware chain (`internal/middleware/auth.go`) runs before every protected route:

```go
func Auth(queries *db.Queries, patCache *auth.PATCache) func(http.Handler) http.Handler {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            // 1. Extract token from Authorization header OR mato_auth cookie
            tokenString, fromCookie := extractToken(r)
            
            // 2. If cookie auth, validate CSRF for state-changing methods
            if fromCookie && !auth.ValidateCSRF(r) {
                http.Error(w, "CSRF validation failed", 403)
                return
            }
            
            // 3. PAT path (mul_ prefix)
            if strings.HasPrefix(tokenString, "mul_") {
                hash := auth.HashToken(tokenString)
                if userID, ok := patCache.Get(ctx, hash); ok {
                    r.Header.Set("X-User-ID", userID)
                    next.ServeHTTP(w, r)
                    return
                }
                // DB lookup + update last_used_at
                pat, err := queries.GetPersonalAccessTokenByHash(ctx, hash)
                // ... validate, set X-User-ID, continue
            }
            
            // 4. JWT path
            claims, err := validateJWT(tokenString)
            r.Header.Set("X-User-ID", claims.Subject)
            r.Header.Set("X-User-Email", claims.Email)
            next.ServeHTTP(w, r)
        })
    }
}
```

**Daemon auth is separate** (`internal/middleware/daemon_auth.go`). It runs on `/api/daemon/*` routes and validates `mdt_` tokens.

---

## Agent Identity Resolution

When an AI agent makes API calls (reading issues, posting comments, updating status), the server needs to know it's an agent, not a human. This is handled by `resolveActor()` in handler.go:

```go
func (h *Handler) resolveActor(r *http.Request, userID, workspaceID string) (actorType, actorID string) {
    agentID := r.Header.Get("X-Agent-ID")
    taskID := r.Header.Get("X-Task-ID")
    
    // Both headers required — X-Agent-ID alone is not trusted
    if agentID == "" || taskID == "" {
        return "member", userID
    }
    
    // Verify the agent exists in this workspace
    agent, err := h.Queries.GetAgent(ctx, agentUUID)
    if err != nil || agent.WorkspaceID != workspaceID {
        return "member", userID
    }
    
    // Verify the task belongs to this agent
    task, err := h.Queries.GetAgentTask(ctx, taskUUID)
    if err != nil || task.AgentID != agentID {
        return "member", userID
    }
    
    return "agent", agentID
}
```

**Why both headers?** A workspace member can observe an agent's UUID (it appears in API responses). If `X-Agent-ID` alone were trusted, any member could impersonate an agent. Requiring `X-Task-ID` means the caller must also know the task UUID, which is only distributed to the daemon that legitimately claimed the task. (This was a security fix, referenced as PR #2359 in the codebase.)

---

## Signup Restrictions

The server supports three signup restriction modes (configured at startup):

| Mode | Config | Effect |
|------|--------|--------|
| Open | `AllowSignup: true` | Anyone with an email can create an account |
| Disabled | `AllowSignup: false` | No new accounts can be created |
| Allowlist | `AllowedEmails: [...]` or `AllowedEmailDomains: [...]` | Only specific addresses/domains can sign up |

These are checked during the `POST /api/auth/verify` step. If signup is restricted and the email doesn't match, the server returns a specific error (`ErrSignupProhibited` or `ErrEmailNotAllowed`).

For SaaS, this mechanism would be replaced by a proper registration flow with email verification, subscription gating, etc.

---

## WebSocket Authentication

WebSocket connections cannot set custom headers in the browser, so the authentication approach is different:

**Token mode (non-cookie clients):**
1. Client connects to `GET /api/ws?workspace_slug=myworkspace`
2. Server upgrades the connection
3. Client sends first message: `{ type: "auth", payload: { token: "<JWT>" } }`
4. Server validates the JWT
5. Server responds: `{ type: "auth_ack" }`
6. Connection is now authenticated and scoped to the workspace

**Cookie mode (web browser):**
1. Client connects to `GET /api/ws?workspace_slug=myworkspace`
2. Browser automatically sends `mato_auth` cookie with the upgrade request
3. Server reads and validates the cookie
4. No auth message needed — server immediately responds with `auth_ack`

The token is never sent as a URL query parameter (which would be logged by proxies, CDNs, and browser history).

---

## Security Considerations

**What the codebase does well:**
- HttpOnly cookies prevent XSS token theft
- CSRF protection for cookie-based sessions
- PAT hashing with SHA-256 (only hash stored)
- Daemon impersonation prevention (both X-Agent-ID + X-Task-ID required)
- UUID validation preventing silent zero-UUID bugs
- Token format prefixes (`mul_`, `mdt_`) prevent mixing token types

**What to watch for / improve for SaaS:**
1. **JWT_SECRET defaults:** The codebase warns loudly if `JWT_SECRET` is not set and uses a hardcoded default. This is fine for development but would be catastrophic in production — any JWT signed with the default secret would be trusted by any other instance.

2. **No refresh token system:** JWTs expire and users must re-authenticate via email code. There is no refresh token flow. For a SaaS product with enterprise customers, you'd want longer-lived sessions with refresh tokens.

3. **No SSO/SAML/OIDC:** No support for enterprise SSO. For B2B SaaS this is a common enterprise requirement.

4. **No rate limiting** on auth endpoints beyond attempt counters on verification codes. A production deployment should add rate limiting at the proxy/CDN level.

5. **Daemon token rotation:** Daemon tokens have an expiry, but there's no automatic rotation mechanism. Long-lived daemon processes (e.g., in CI) could end up with expired tokens.
