# Backend: Skill and Knowledge System

## What Skills Are

In MATO, a "skill" is a named unit of knowledge — essentially a markdown document — that can be attached to an agent and injected into the agent's working environment when it executes a task.

Think of it like giving an employee a reference manual before sending them to do a job. The agent reads the skill document as part of its context.

---

## The Data Model

```sql
-- The skill itself
CREATE TABLE skill (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    content TEXT NOT NULL DEFAULT '',     -- The main SKILL.md document (can be 50-200KB)
    config JSONB NOT NULL DEFAULT '{}',   -- Metadata: tags, version, etc.
    created_by UUID REFERENCES "user"(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(workspace_id, name)            -- Names are unique per workspace
);

-- Supporting files for a skill (beyond the main SKILL.md)
CREATE TABLE skill_file (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    skill_id UUID NOT NULL REFERENCES skill(id) ON DELETE CASCADE,
    path TEXT NOT NULL,                   -- e.g. "examples/test.py"
    content TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(skill_id, path)               -- Each path is unique within a skill
);

-- Many-to-many: which agents have which skills
CREATE TABLE agent_skill (
    agent_id UUID NOT NULL REFERENCES agent(id) ON DELETE CASCADE,
    skill_id UUID NOT NULL REFERENCES skill(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (agent_id, skill_id)
);
```

---

## How Skills Are Used During Task Execution

When the daemon claims a task, it receives the full skill content for each skill attached to the agent. The daemon then:

1. Creates a temporary working directory for the task
2. Writes each skill's `content` as `SKILL.md` in a subdirectory named after the skill
3. Writes each `skill_file` to its specified path within that subdirectory
4. Spawns the agent CLI in that directory

The agent CLI (Claude Code, Codex, etc.) can then read these files as part of its context, following any instructions or examples in the skill documents.

**Example:** An agent has a "Python Testing" skill attached. When the daemon materializes the task environment, the agent's working directory contains:

```
/tmp/task-abc123/
  skills/
    python-testing/
      SKILL.md          ← main skill document (how to write tests, conventions, etc.)
      examples/
        test_example.py ← a supporting file
```

The agent's system prompt includes instructions to read the SKILL.md file for coding conventions.

---

## Important: No Vector Search (pgvector Not Currently Used for Skills)

Despite pgvector being installed, the skill system does **not** use semantic/vector search. There is no vector embedding column on the `skill` table.

Skills are:
- **Discovered by exact name match** (when an agent template references a skill by name)
- **Listed in full** (for the skills management UI)
- **Materialized wholesale** (all attached skills are injected, not selectively retrieved)

The `pgvector` extension is enabled in the database (`CREATE EXTENSION IF NOT EXISTS pgvector` is absent from the migrations — it's part of the pgvector/pgvector Docker image), but no table in the schema currently uses a `vector` column type.

**This is a major capability gap** if you are planning to build a "smart context injection" or "relevant skill retrieval" feature. The infrastructure (pgvector) is available but the embedding pipeline (generate embeddings, store them, query by similarity) has not been built.

---

## Skill Payload Size Problem

Skill content can be large — 50-200KB for a well-documented skill. This created a real production issue: shipping skill content in list responses caused 15-second CLI timeouts from high-latency regions.

The codebase solved this with two query variants:

| Query | Columns | Used By |
|-------|---------|---------|
| `ListSkillsByWorkspace` | All columns including `content` | Single skill GET endpoint |
| `ListSkillSummariesByWorkspace` | All columns EXCEPT `content` | List endpoints, CLI table view |

This pattern is repeated for agent-skill queries too:
- `ListAgentSkills` — includes content
- `ListAgentSkillSummaries` — excludes content

**If you add a new list endpoint that returns skills, always use the summary variant.** The detail endpoint is the right place to return the full content.

---

## Local Skills (Daemon-Reported)

In addition to workspace-managed skills, the daemon can report "local skills" — skill files that exist on the developer's machine but haven't been imported into the workspace.

This is surfaced through a special in-memory store on the server (`LocalSkillListStore`, backed by Redis when available):

1. **Daemon discovers local skills** by scanning configured directories on the machine
2. **Daemon reports them** via `PUT /api/runtimes/{id}/models` (same endpoint pattern as model list)
3. **Server stores them** in `LocalSkillListStore` (in-memory, keyed by runtime)
4. **UI displays them** so users can see what's available locally before importing

The **import flow** (`LocalSkillImportStore`) is similar:
1. User clicks "Import" on a local skill
2. Server creates an import request in `LocalSkillImportStore` (a keyed in-memory record)
3. Daemon polls `GET /api/runtimes/{id}/local-skills` and sees the pending request
4. Daemon reads the local skill file and fulfills the request via `PUT /api/runtimes/{id}/local-skills/{requestId}`
5. Server writes the skill to the database

**Note:** These stores are in-memory by default. With Redis configured, they persist across server restarts and are shared across nodes. Without Redis, a server restart clears all local skill reports — users would need to let the daemon re-register.

---

## Skill Assignment to Agents

Skills are attached to agents via the `agent_skill` junction table. The API:

- `GET /api/agents/{id}/skills` — list skills attached to this agent
- `POST /api/agents/{id}/skills/{skillId}` — attach a skill
- `DELETE /api/agents/{id}/skills/{skillId}` — detach a skill
- `PUT /api/agents/{id}/skills` — replace all skills at once (batch set)

The `AddAgentSkill` query uses `ON CONFLICT DO NOTHING` to prevent duplicate attachment errors.

---

## Skill Files

The `skill_file` table allows a skill to have supporting files beyond the main SKILL.md. This is useful for:
- Code examples
- Configuration templates
- Reference documents
- Test fixtures

Files are stored as text content in the database (not in S3). The path field represents where the file should appear relative to the skill's directory. The `UNIQUE(skill_id, path)` constraint ensures no duplicate paths within a skill — the `UpsertSkillFile` query uses `ON CONFLICT DO UPDATE` for idempotent writes.

---

## Agent Templates and Skills

When a user creates a workspace from a template (e.g., "Software Development Team"), the template can specify default skills for the template agents. The template materialization uses `GetSkillByWorkspaceAndName` to implement find-or-create:

```sql
SELECT * FROM skill WHERE workspace_id = $1 AND name = $2
```

If the skill already exists in the workspace (e.g., from a previous template application), the existing skill is reused rather than creating a duplicate (which would violate the `UNIQUE(workspace_id, name)` constraint).

---

## What a Developer Needs to Know Before Modifying Skills

1. **Never return `content` in list endpoints.** The size will break clients on slow connections.

2. **Skill names are unique per workspace.** If you allow renaming, you must handle the unique constraint violation (it will return a `23505` pgconn error code).

3. **pgvector is available but not wired up.** If you want to add semantic skill retrieval, you need to: add a `vector(N)` column to `skill`, build an embedding pipeline (call an embedding API when skills are created/updated), and write a cosine similarity query. The infrastructure cost is low; the API integration is the work.

4. **Local skills are ephemeral.** If Redis is not configured, they disappear on server restart. This is documented behavior, but users find it surprising.

5. **Skill content is text, not binary.** The `sanitizeNullBytes()` function in `skill.go` cleans embedded null bytes and invalid UTF-8 (Windows-encoded content) before writing to PostgreSQL. This was added after real failures during skill import from Windows machines.
