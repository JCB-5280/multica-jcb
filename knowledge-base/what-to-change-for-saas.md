---
title: What to Change for SaaS
aliases:
  - SaaS Migration Guide
  - Self-Hosting Assumptions
  - Production Hardening
  - SaaS Readiness
  - Commercial SaaS Checklist
description: Every self-hosting assumption baked into the MATO codebase — security gaps, missing billing, admin tooling holes, weak isolation, and operational infrastructure that must exist before running as a multi-tenant SaaS product. Rated by risk and effort.
tags:
  - saas
  - production
  - security
  - billing
  - multi-tenancy
  - infrastructure
  - roadmap
status: reference
author: documentation-library
created: 2026-05-17
modified: 2026-05-17
related:
  - "[[architecture-overview]]"
  - "[[backend/05-authentication-access-control]]"
  - "[[backend/04-workspace-multitenancy]]"
  - "[[backend/06-skill-knowledge-system]]"
  - "[[database/schema]]"
  - "[[glossary]]"
complexity: high
layer: operations
---

# What to Change for SaaS

## Priority Matrix

| Item | Risk | Effort | Do Before Launch |
|------|------|--------|:---:|
| JWT_SECRET hard default | Critical | XS | ✅ |
| No rate limiting on auth | High | S | ✅ |
| No billing / subscription enforcement | High | XL | ✅ |
| No workspace deletion / data purge tooling | High | M | ✅ |
| No admin dashboard | Medium | L | ✅ |
| PAT workspace scope enforcement | Medium | M | ✅ |
| No refresh token / long-lived session | Medium | M | Before paid tier |
| pgvector not wired up | Low | L | Post-launch |
| No row-level security (RLS) | Medium | XL | High-compliance only |
| Email provider not required | Low | XS | ✅ |
| No SSO/SAML/OIDC | Medium | L | Enterprise tier |
| Local skill data lost without Redis | Low | XS | ✅ (document it) |
| Daemon token rotation not automated | Low | M | Post-launch |

---

## Security Gaps

### 1. JWT_SECRET Has a Dangerous Default

**File:** `server/internal/auth/jwt.go`

The server **runs with a hardcoded default secret** if `JWT_SECRET` is not set:

```go
// current code — logs warning but continues
secret := os.Getenv("JWT_SECRET")
if secret == "" {
    slog.Warn("JWT_SECRET not set, using insecure default")
    secret = "mato-dev-secret-change-in-production"
}
```

**The risk:** Any two instances with the default secret can forge tokens for each other. On a SaaS platform, this means a user on one tenant could forge a JWT and impersonate users on other tenants.

**Fix:** In `server/cmd/server/main.go`, change this to a hard failure:

```go
secret := os.Getenv("JWT_SECRET")
if secret == "" {
    slog.Error("JWT_SECRET environment variable is required")
    os.Exit(1)
}
```

**Effort:** 10 minutes. Do this first.

---

### 2. No Rate Limiting on Auth Endpoints

`POST /api/auth/login` and `POST /api/auth/verify` have no rate limiting in the Go code. Brute-forcing the 6-digit verification code (1,000,000 possibilities) is possible, though `verification_code.attempts` tracks per-code attempts.

**Fix options:**
- Add rate limiting at the CDN/proxy layer (Cloudflare rate limiting, nginx `limit_req`)
- Add in-process rate limiting middleware using a library like `golang.org/x/time/rate`

**Effort:** S. CDN approach is fastest.

---

### 3. Verification Code Attempt Tracking

`verification_code.attempts` is incremented on each failed attempt, but the maximum is configurable and defaults to a relatively high number. Verify the limit is set appropriately for production.

---

### 4. PAT Workspace Scope Not Enforced Everywhere

`personal_access_token.workspace_id` is nullable — a PAT can be workspace-scoped or global. The current auth middleware validates the PAT but may not enforce workspace scope in all paths.

**Fix:** Audit all PAT-authenticated paths to confirm workspace scope is checked when a scoped PAT is used.

---

### 5. No Session Refresh Token

JWT sessions expire after a configurable duration (default: hours). When they expire, users must re-authenticate via email. There's no refresh token flow — long-lived browser sessions will be interrupted.

**Fix:** Add a refresh token table and a `/api/auth/refresh` endpoint. Issue a long-lived HttpOnly refresh token on login; exchange it for a new JWT silently.

**Effort:** M.

---

### 6. Daemon Token Rotation Not Automated

Daemon tokens are workspace-scoped and have an expiry, but there's no automatic renewal. Daemons that run continuously may eventually have expired tokens and silently fail to claim tasks.

**Fix:** Add daemon-side token renewal logic — check expiry approaching, request a new token before the old one expires.

---

## Billing and Subscription

> [!CAUTION] Zero Billing Infrastructure
> There is no billing, subscription, trial period, seat limit, usage limit, or payment enforcement anywhere in the codebase. Every workspace is treated equally. Adding billing is the largest single gap between the open-source project and a commercial SaaS.

### What to Build

1. **Subscription model** — integrate Stripe (or equivalent). Choose between:
   - Per-seat pricing: count `member` rows per workspace
   - Usage pricing: read from `task_usage_daily`; MATO already tracks token consumption
   - Flat workspace subscription

2. **Plan enforcement middleware** — before creating issues, agents, inviting members, etc., check subscription status. Gate features behind plan tiers.

3. **Trial period** — give new workspaces a free trial. Track `workspace.trial_ends_at`.

4. **Overage handling** — when usage limits are hit, either block new tasks or send notifications.

5. **Billing portal** — expose a Stripe Customer Portal for payment management.

6. **Webhook handling** — receive Stripe events (subscription canceled, payment failed) and update workspace status.

**Effort:** XL. This is 4-8 weeks of focused engineering.

---

## Admin and Operations

### Missing Admin Dashboard

There is no admin interface for:
- Viewing all workspaces and their status
- Searching for users by email
- Impersonating a user for support
- Resetting a user's 2FA / auth
- Viewing aggregate usage across all tenants
- Manually suspending a workspace

**Fix:** Build a simple admin-only Next.js section (e.g., `/admin/`) protected by a hardcoded admin user list or a new `is_admin` flag on the `user` table.

---

### No Workspace Deletion or Data Purge

There is no operator-level tool to:
- Delete a workspace and purge all its data (GDPR right to erasure)
- Export a workspace's data for a user
- Transfer workspace ownership on a support request

The database CASCADE deletes work correctly — deleting a workspace row cascades to all children — but there's no UI or CLI tool to trigger this safely.

**Fix:** Add a Go CLI command (`make cli ARGS="workspace delete --slug my-team"`) that verifies the workspace exists, prompts for confirmation, and issues the DELETE.

---

### Onboarding and Signup Flow

The current signup flow is minimal — magic link → account created → first workspace created. For SaaS:

- Add email verification step (currently the magic link IS the verification)
- Add terms of service acceptance tracking
- Add organization setup step (company name, team size)
- Add referral/source tracking

---

## Infrastructure Gaps

### Redis Is Optional, But Shouldn't Be

Without Redis:
- WebSocket broadcasts only work on a single-node deployment
- PAT cache is per-node (each node has its own cache, no sharing)
- Local skill lists evaporate on server restart
- DaemonHub connections are not shared across nodes

**For SaaS:** Make `REDIS_URL` required. Log a fatal error at startup if not set.

---

### pg_cron Must Be Scheduled

The `rollup_task_usage_daily()` function must be scheduled via `pg_cron`. The migration (076) installs the extension but explicitly does NOT schedule the job:

```sql
-- Migration 076 comment:
-- Scheduling must happen *after* a successful backfill run.
-- Operator playbook: run backfill, then schedule cron.
```

**For SaaS:** After initial deployment, follow the operator playbook in migration 076:
1. Run `go run ./cmd/backfill_task_usage_daily`
2. Enable `USAGE_DAILY_ROLLUP_ENABLED=true`
3. Schedule the cron job as superuser

---

### Email Provider Must Be Configured

In development, missing email config prints codes to logs. In production:

```go
// server/internal/auth/handler.go
if APP_ENV == "production" && emailProvider == nil {
    // This case should be a fatal startup error, but currently it's handled
    // by the fallback printing to logs — which fails silently in production
}
```

**Fix:** Add a startup check that fails if `APP_ENV=production` and no email provider is configured.

---

### No Observability Stack

The codebase uses `log/slog` for structured logging but has no:
- Distributed tracing (OpenTelemetry, Jaeger)
- Metrics export (Prometheus endpoint)
- Error tracking (Sentry)
- Uptime monitoring

**Fix (phased):**
1. Add a Prometheus `/metrics` endpoint with key counters: HTTP request count/latency, WebSocket connections, task queue depth, task completion rate
2. Add Sentry for panic reporting
3. Add OpenTelemetry traces for the task lifecycle

---

## Multi-Tenancy Hardening

### No Row-Level Security (RLS)

Workspace isolation is currently enforced at the application layer only. A bug in a handler that calls `GetIssue` instead of `GetIssueInWorkspace` exposes cross-workspace data. This has happened three times (incidents #2143, #2147, #2192).

**Option A: Application-layer only (current)**
- Continue relying on workspace-scoped query functions
- Add automated tests that verify cross-workspace isolation
- Code review checklist item: "Did you use the workspace-scoped query variant?"

**Option B: PostgreSQL Row-Level Security**

```sql
-- Add application user
CREATE ROLE app_user;

-- Enable RLS on all workspace-scoped tables
ALTER TABLE issue ENABLE ROW LEVEL SECURITY;

-- Policy: can only see rows for the current workspace
CREATE POLICY workspace_isolation ON issue
    FOR ALL TO app_user
    USING (workspace_id = current_setting('app.workspace_id')::uuid);
```

The Go server would call `SET LOCAL app.workspace_id = '...'` at the start of each request. This makes cross-workspace leakage impossible even if handler code is buggy.

**Effort:** XL. Requires changing all queries, adding database session management, extensive testing.

> [!NOTE] Recommendation
> RLS is worth implementing for SOC 2 / enterprise compliance. For initial SaaS launch with individual/small-team customers, hardened application-layer isolation + tests is sufficient.

---

### Invite-Only vs. Open Registration

The `handler.Config` controls signup:

| Config | Effect |
|--------|--------|
| `AllowSignup: true` | Anyone can sign up |
| `AllowSignup: false` | No new accounts |
| `AllowedEmails: [...]` | Only specific addresses |
| `AllowedEmailDomains: [...]` | Domain allowlist |

For SaaS, replace this with a proper registration flow with:
- Email verification (not just magic-link)
- Optional waitlist (`user.cloud_waitlist` already exists in the schema)
- Workspace creation guided by onboarding

---

## Feature Gaps for Commercial Use

### Semantic Skill Search (pgvector)

pgvector is installed. No table has a vector column. Agents receive all attached skills whether relevant or not.

**What to build:**
1. Add `embedding vector(1536)` column to `skill` table
2. Build embedding pipeline: call embedding API on skill create/update
3. Write similarity query: `ORDER BY embedding <=> $1 LIMIT 5`
4. Integrate into task claim: fetch top-N relevant skills rather than all attached

**Value:** Agents with 20+ skills currently get all of them injected into context regardless of relevance. Semantic retrieval would dramatically reduce context bloat for large skill libraries.

---

### No SSO / SAML / OIDC

Enterprise customers expect SSO. Neither Okta, Azure AD, nor Google Workspace login is implemented.

**Fix:** Add a middleware that handles OIDC callback, exchanges code for user info, and either creates or matches a `user` record. Libraries: `coreos/go-oidc`.

---

### No Audit Log Export

`activity_log` exists but there's no export mechanism (CSV, webhook, SIEM integration).

---

### No Workspace Transfer

There's no mechanism to transfer a workspace from one billing account to another (acquisition, team restructuring).

---

## Data Privacy and Compliance

### GDPR Right to Erasure

No tooling to delete a specific user's data across all workspaces while preserving workspace functionality (e.g., comments show "Deleted User" rather than disappearing).

**Fix:** Add a `DELETE /api/admin/users/:id` endpoint that:
1. Anonymizes `user.name` and `user.email`
2. Sets `user.avatar_url = null`
3. Retains the UUID (so FK references don't cascade-delete issues/comments)
4. Does NOT cascade-delete workspace data (their work product belongs to the workspace)

---

### Data Residency

All data is in one database. No mechanism for region-specific storage. If EU customers require data to stay in EU, a separate deployment is needed.

---

## Configuration Checklist for Production Deployment

```bash
# Required
JWT_SECRET=<64+ random hex chars>
DATABASE_URL=postgresql://...
APP_ENV=production

# Required for auth
RESEND_API_KEY=re_...          # OR
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_USERNAME=...
SMTP_PASSWORD=...
SMTP_FROM=noreply@example.com

# Strongly recommended
REDIS_URL=redis://...
ALLOWED_ORIGINS=https://app.yourdomain.com

# GitHub integration (if enabling)
GITHUB_APP_ID=...
GITHUB_APP_PRIVATE_KEY=...
GITHUB_APP_WEBHOOK_SECRET=...

# Signup control
ALLOW_SIGNUP=true              # or false for closed beta
ALLOWED_EMAIL_DOMAINS=         # e.g. "yourcompany.com" for internal

# Monitoring (add these)
SENTRY_DSN=https://...
```

---

## Summary: The Critical Path to Launch

1. **Fix JWT_SECRET** — make startup fail without it (10 min)
2. **Configure email provider** — make startup fail in production without it (30 min)
3. **Set ALLOWED_ORIGINS** — restrict WebSocket origins to your domain (5 min)
4. **Deploy Redis** — required for multi-node; strongly recommended for single-node (1 day infra)
5. **Add rate limiting** — at CDN or middleware level (1 day)
6. **Build billing** — Stripe integration, subscription enforcement (4-8 weeks)
7. **Build admin dashboard** — basic ops tooling for support (1-2 weeks)
8. **Add workspace deletion CLI** — for GDPR compliance (1-2 days)
9. **Run pg_cron backfill** — activate usage analytics (1 hour operator task)
10. **Add monitoring** — Sentry + basic metrics (2-3 days)

---

## Related Documents

- [[backend/05-authentication-access-control]] — Auth gaps detail
- [[backend/04-workspace-multitenancy]] — Isolation model
- [[backend/06-skill-knowledge-system]] — pgvector gap
- [[database/schema]] — Schema evolution notes
- [[architecture-overview]] — System overview
