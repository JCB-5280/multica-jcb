# What to Change for SaaS

This document identifies every part of the Multica codebase that assumes self-hosting or single-tenant usage, and flags what would need to change to support a multi-tenant hosted SaaS with user accounts, billing, tenant data isolation, and all the operational concerns that come with running a commercial product.

---

## Executive Summary

Multica's architecture is already multi-tenant in the database sense — workspaces are logically isolated and all queries filter by `workspace_id`. The core data model does not need to change.

What **does** need to change:

1. **Signup and account creation** — currently gated by a simple allowlist or disabled entirely
2. **Billing and subscription enforcement** — does not exist
3. **Admin / operator tooling** — no super-admin interface
4. **Usage limits and quotas** — not enforced, only reported
5. **Authentication hardening** — JWT secret defaults, no SSO/refresh tokens
6. **Stronger data isolation options** — application-layer only, no RLS
7. **Operational infrastructure** — Redis, multi-node, observability

---

## Category 1: User Registration and Accounts

### What it does now

The `handler.Config` has three fields controlling signup:

```go
type Config struct {
    AllowSignup         bool
    AllowedEmails       []string
    AllowedEmailDomains []string
}
```

These are environment variables set at server startup. The options are:
- Allow everyone
- Block everyone
- Allow only specific emails or domains

### What needs to change

For SaaS, signup needs to be self-service with:
- **Email verification** (currently uses a magic-link code, which is actually fine)
- **Account creation gated by plan selection** — users should pick a plan before they can create a workspace
- **Terms of service acceptance** — stored on the user record
- **Possibly invite-only beta flow** — a waitlist with invites

**Files to modify:**
- `server/internal/handler/auth.go` — `VerifyCode` handler; currently calls `getOrCreateUser()` freely
- `handler.Config` — remove the allowlist fields; replace with subscription-awareness
- Frontend login flow (`packages/views/auth/login-page.tsx`) — add plan selection step

**Existing hook:** The `onboarding_questionnaire` JSONB column on `user` already captures post-signup survey data. The `onboarded_at` timestamp tracks completion. The onboarding flow exists — you'd extend it to include plan selection.

---

## Category 2: Billing and Subscription Enforcement

### What it does now

**Nothing.** There is no billing system. The codebase tracks token usage (`task_usage` table, rollups) and reports it on a dashboard, but no enforcement happens. An account can use unlimited tokens.

### What needs to change

You need to add:

1. **A subscription/plan table**
   ```sql
   CREATE TABLE plan (
     id UUID PRIMARY KEY,
     name TEXT,                  -- "free", "pro", "enterprise"
     max_agents INT,
     max_tasks_per_month BIGINT,
     max_token_spend_per_month BIGINT,
     price_cents INT,
     stripe_price_id TEXT
   );
   
   CREATE TABLE subscription (
     id UUID PRIMARY KEY,
     workspace_id UUID UNIQUE REFERENCES workspace(id),
     plan_id UUID REFERENCES plan(id),
     status TEXT,                -- "active", "past_due", "cancelled"
     current_period_end TIMESTAMPTZ,
     stripe_subscription_id TEXT,
     stripe_customer_id TEXT,
     created_at TIMESTAMPTZ
   );
   ```

2. **Enforcement points** — the task claim handler (`handler/daemon.go → ClaimTask`) is the natural enforcement point. Before allowing a task to be dispatched, check:
   - Does the workspace have an active subscription?
   - Has the workspace exceeded its monthly token quota?
   - Has the workspace exceeded its agent count limit?

3. **Stripe webhook handler** — process subscription lifecycle events (payment success, payment failure, cancellation)

4. **Usage-based billing** — if you charge per token, the `task_usage` table already has the data. The rollup tables (`task_usage_daily`) make it queryable. You need to sum and invoice at period end.

**Key observation:** The token usage infrastructure is already excellent. `task_usage_daily` and `task_usage_dashboard_daily` with their `pg_cron` rollups are exactly what you need for billing calculations. The gap is the enforcement layer on top.

---

## Category 3: Authentication Hardening

### JWT Secret Default

**Critical:** The server logs a warning but still starts if `JWT_SECRET` is not set, using `"mato-dev-secret-change-in-production"`:

```go
// server/internal/auth/jwt.go
const defaultJWTSecret = "mato-dev-secret-change-in-production"
```

For SaaS, this default must not exist. The server should refuse to start if `JWT_SECRET` is missing, and the startup check should be a hard failure, not a warning.

**File:** `server/cmd/server/main.go` — change the warning to `os.Exit(1)`

### No Refresh Token System

JWTs expire and users must re-authenticate via email code. For SaaS with enterprise users who expect longer sessions, you'd want refresh tokens with sliding expiry.

**What to add:**
- `refresh_token` table (stores hashed refresh tokens with expiry)
- `POST /api/auth/refresh` endpoint
- Frontend logic to refresh silently before expiry

### No SSO/SAML/OIDC

Enterprise customers often require SAML SSO or OIDC (e.g., Okta, Azure AD). This is a significant engineering effort:
- Add an `sso_provider` table per workspace
- Implement SAML SP or OIDC client
- Skip the email verification flow for SSO users

### Rate Limiting

No rate limiting is implemented at the application level. This should be handled at the proxy/CDN layer (e.g., AWS WAF, Cloudflare), but the auth endpoints (login, verify) are particularly important to protect against brute force.

---

## Category 4: Admin and Operator Tooling

### What it does now

There is no admin interface. An operator can:
- Connect to the database directly and run SQL
- Use the CLI (authenticated as a workspace owner)
- Check server logs

### What needs to change

For SaaS you need:

1. **Super-admin role** — a user role that transcends workspace boundaries; can view all workspaces, all subscriptions, all users
2. **Admin API** — endpoints accessible only to super-admins for support operations (reset user, delete workspace, extend trial, view usage across tenants)
3. **Admin UI** — a dashboard for the operations team

**Implementation approach:** The simplest approach is a separate admin API mounted at `/admin/api/*` with its own middleware that checks for a `is_admin` flag on the user. An alternative is a separate internal service.

---

## Category 5: Data Isolation Guarantees

### Current state

Isolation is **application-layer only**. Every query filters by `workspace_id`, but:
- There is no PostgreSQL Row Level Security (RLS)
- All workspace data is in the same schemas/tables
- A bug in handler code could potentially expose cross-workspace data (this has happened: issues #2143, #2147, #2192 referenced in the codebase)

### Options

**Option A: Stay as-is (acceptable for most SaaS)**

Most SaaS products (Linear, Notion, GitHub) use application-layer isolation. It works if the code is correct. Add a security review checklist to your development process for any new query.

**Option B: Add PostgreSQL Row Level Security**

```sql
ALTER TABLE issue ENABLE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON issue
    USING (workspace_id = current_setting('app.workspace_id')::uuid);
```

This catches bugs at the database level — even if a query forgets the `WHERE workspace_id =` clause, it would return empty results instead of all rows. Requires setting `app.workspace_id` in each session (via a connection middleware), and sqlc-generated queries would need updates.

**Option C: Schema-per-tenant**

Strongest isolation; completely separate schema per workspace. Only feasible for a small number of large tenants. Operationally complex (migration management, connection pooling).

**Recommendation:** For a standard B2B SaaS with compliance requirements, Option B (RLS) is a good middle ground. For high-compliance verticals (healthcare, finance), schema-per-tenant is safer.

---

## Category 6: Usage Limits and Quotas

### What it does now

Token usage is tracked but not enforced. There are no limits.

### What needs to change

Add quota checks in `service/task.go` before allowing tasks to be dispatched:

```go
func (s *TaskService) EnsureTaskQueued(ctx context.Context, issue db.Issue) error {
    // Check subscription is active
    sub, err := s.Queries.GetWorkspaceSubscription(ctx, issue.WorkspaceID)
    if err != nil || sub.Status != "active" {
        return ErrNoActiveSubscription
    }
    
    // Check monthly token quota
    usage, err := s.Queries.GetMonthlyTokenUsage(ctx, issue.WorkspaceID)
    if err == nil && usage > sub.Plan.MaxTokens {
        return ErrQuotaExceeded
    }
    
    // Proceed with task creation
    return s.createTask(ctx, issue)
}
```

This requires:
1. The `subscription` and `plan` tables from Category 2
2. A query that sums `task_usage` for the current billing period
3. Error types that translate to user-facing messages (e.g., "upgrade to continue" banner)

---

## Category 7: Daemon Token Management

### What it does now

Daemon tokens (`mdt_...`) are created by workspace owners/admins and have an expiry. There's no rotation, no audit log of token usage, and no way for a super-admin to revoke all tokens for a workspace.

### What needs to change

For SaaS:
- **Automatic rotation** — daemon tokens should expire regularly and the daemon should automatically renew them
- **Audit log** — record when daemon tokens are used (which runtime, which task, from which IP)
- **Emergency revocation** — super-admins should be able to revoke all tokens for a workspace instantly (e.g., in case of a security incident)

---

## Category 8: Multi-Region and Operational Infrastructure

### Redis

Redis is optional today. For a multi-tenant SaaS with multiple API nodes, **Redis is required**. You cannot load-balance without it (events from one node won't reach clients on another).

**What to change:** Make `REDIS_URL` required in production. The server currently logs a warning and continues — change this to a hard failure in `APP_ENV=production`.

### Database Connection Pooling

The server uses `pgx` with a connection pool. For multi-tenant SaaS at scale, you may want PgBouncer in front of PostgreSQL to reduce connection overhead, especially if you run many API nodes.

### Observability

The codebase has hooks for:
- **Prometheus metrics** (optional, via `METRICS_ADDR` env var)
- **Structured logging** (slog)
- **Database pool stats** (logged periodically)

For SaaS you'd want:
- A metrics backend (Datadog, Grafana, etc.)
- Distributed tracing (OpenTelemetry)
- Error tracking (Sentry)
- Log aggregation (Loki, CloudWatch, etc.)

### Backup and Disaster Recovery

Not present in the codebase. For SaaS, you need:
- Automated PostgreSQL backups (e.g., pg_dump to S3, or RDS automated backups)
- Point-in-time recovery (WAL archiving)
- Regular restore tests

---

## Category 9: The Daemon Model for SaaS

### The fundamental tension

Multica's current model is that AI agents run locally on the user's machine (the daemon). This is great for self-hosted/developer use cases but creates friction for SaaS:

- Users have to install and run a daemon process
- Daemonless SaaS (agents running in the cloud) would be far simpler UX

### Cloud runtime

The `agent_runtime` table supports `runtime_mode = 'cloud'`. The infrastructure for cloud-hosted runtimes exists conceptually, but the code for running agent CLIs in the cloud (e.g., in a container on ECS/GKE) would need to be built. The `server/internal/daemon/` code is the template — you'd build a cloud-equivalent that polls for tasks and runs them in a managed container instead of on a user's machine.

**What already exists:** The `provider` field on `agent_runtime` and the agent `Backend` interface are designed to be extended. A cloud backend would implement the same `Backend` interface but use container APIs (Docker, Kubernetes, Lambda) instead of `exec.Command`.

---

## Priority Checklist for SaaS

In rough order of importance:

| Priority | Change | Effort |
|----------|--------|--------|
| 🔴 Critical | Make `JWT_SECRET` required in production | 1 hour |
| 🔴 Critical | Make `REDIS_URL` required in production | 1 hour |
| 🔴 Critical | Add billing/subscription system | 2-4 weeks |
| 🔴 Critical | Add usage quota enforcement | 1 week |
| 🟡 Important | Admin tooling (super-admin role + UI) | 1-2 weeks |
| 🟡 Important | Rate limiting on auth endpoints | 2-3 days |
| 🟡 Important | Refresh token system | 1 week |
| 🟡 Important | Audit logging improvements | 3-5 days |
| 🟢 Nice to have | PostgreSQL RLS | 1-2 weeks |
| 🟢 Nice to have | SSO/SAML | 3-6 weeks |
| 🟢 Nice to have | Cloud agent runtime | 4-8 weeks |
| 🟢 Nice to have | Schema-per-tenant option | 3-6 weeks |
