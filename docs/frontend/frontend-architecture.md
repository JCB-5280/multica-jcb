# Frontend Architecture

## Overview

The Multica frontend is a monorepo of three apps (web, desktop, docs) and three shared packages (core, views, ui). The apps share the vast majority of their code through the shared packages. The goal is that adding a new feature should touch only the shared packages, with minimal wiring in each app.

```
packages/
  core/     ← Business logic: API calls, state stores, data types
  views/    ← UI pages and feature components
  ui/       ← Design system atoms (buttons, inputs, modals)

apps/
  web/      ← Next.js 15 app (adds only Next.js-specific wiring)
  desktop/  ← Electron app (adds only Electron-specific wiring)
  docs/     ← Documentation site
```

---

## Package Responsibilities

### `packages/core/` — The Brain

This package has zero React DOM dependencies and zero framework imports. It contains:

- **API client** (`api/client.ts`) — fetch-based HTTP client for all REST calls
- **WebSocket client** (`api/ws-client.ts`) — manages the WebSocket connection, authentication, reconnection, and event dispatch
- **Zustand stores** — all global client state (workspace selection, modal state, filters, etc.)
- **TanStack Query hooks** — all server state fetching and caching (query + mutation definitions)
- **TypeScript types** — all shared data types (Issue, Agent, Task, Comment, etc.)
- **Platform adapters** — storage abstraction so Electron and Next.js can use different storage backends (IndexedDB vs. localStorage)
- **Paths** — route generation utilities and reserved-slug list

Since it has no framework dependencies, all state logic can be tested with plain Vitest (no jsdom required for pure logic), and all code runs identically in both apps.

**Key design rule:** Zustand stores live here, not in `packages/views/`. Stores are pure state — not UI. Having them in core means both apps share identical state behavior.

### `packages/views/` — The Face

All shared React components live here. This package can import from `packages/core/` but not from `next/*` or `react-router-dom`. It uses:

- `useNavigation()` from core (the navigation adapter) instead of `next/navigation` or `useNavigate`
- `<AppLink>` instead of Next.js `<Link>` or React Router `<Link>`

This abstraction is what allows the same page component to run in both apps.

Structure follows domain organization:

```
views/
  agents/         ← Agent management pages
  auth/           ← Login page
  autopilots/     ← Autopilot builder
  chat/           ← Chat window
  dashboard/      ← Usage dashboard
  issues/         ← Issue list, detail, kanban, forms
  layout/         ← Dashboard shell, sidebar, navigation
  projects/       ← Project views
  runtimes/       ← Runtime status, model/skill management
  settings/       ← Workspace settings
  skills/         ← Skill editor and library
  squads/         ← Squad management
  common/         ← Shared components (actor-avatar, markdown, etc.)
```

### `packages/ui/` — The Atoms

Atomic UI components with zero business logic. Based on shadcn/ui with Base UI primitives (`@base-ui/react`). When you need a new component, install it with `pnpm ui:add <name>` from the project root — this writes to this package.

**Key rule:** UI has zero imports from `@mato/core`. If a UI component needs business logic, it should receive it as props.

---

## State Management

The state split follows a strict rule: **server state lives in TanStack Query, client state lives in Zustand**.

### TanStack Query (Server State)

Every piece of data that comes from the API lives in the Query cache. The cache key always includes `wsId` (workspace ID) so that switching workspaces automatically shows the correct data:

```typescript
// packages/core/issues/queries.ts
export function useIssues(wsId: string) {
  return useQuery({
    queryKey: ["issues", wsId],          // workspace-scoped key
    queryFn: () => api.listIssues(wsId),
  })
}

export function useUpdateIssue(wsId: string) {
  return useMutation({
    mutationFn: (data) => api.updateIssue(data),
    onMutate: async (data) => {
      // Optimistic update: modify cache before request fires
      const previous = queryClient.getQueryData(["issues", wsId])
      queryClient.setQueryData(["issues", wsId], (old) => 
        old.map(i => i.id === data.id ? { ...i, ...data } : i)
      )
      return { previous }
    },
    onError: (_, __, ctx) => {
      // Rollback on failure
      queryClient.setQueryData(["issues", wsId], ctx.previous)
    },
    onSettled: () => {
      // Refresh from server
      queryClient.invalidateQueries({ queryKey: ["issues", wsId] })
    }
  })
}
```

WebSocket events trigger cache invalidations:

```typescript
wsClient.on("issue:updated", (payload) => {
  queryClient.setQueryData(["issue", wsId, payload.id], payload)
  queryClient.invalidateQueries({ queryKey: ["issues", wsId] })
})
```

**Hard rule:** Never copy server data into a Zustand store. Two sources of truth will drift. If it came from the API, it stays in the query cache.

### Zustand (Client State)

Client state that doesn't come from the server: UI selections, filter state, draft text, modal open/close, navigation history.

```typescript
// packages/core/issues/stores/filter-store.ts
const useIssueFilterStore = create<IssueFilterState>()(
  persist(
    (set) => ({
      statusFilter: [],
      priorityFilter: [],
      setStatusFilter: (statuses) => set({ statusFilter: statuses }),
      setPriorityFilter: (priorities) => set({ priorityFilter: priorities }),
    }),
    { name: "issue-filters" }  // persisted to storage
  )
)
```

**Zustand footguns documented in the codebase:**
1. Selectors must return stable references. `s => ({ a: s.a, b: s.b })` creates a new object every render, causing infinite re-renders. Either select primitives separately or use `shallow` comparison.
2. Hooks that need workspace context should accept `wsId` as a parameter rather than reading from `useWorkspaceId()` inside the hook — this lets them work outside the workspace context provider.

---

## Routing

The routing abstraction is one of the trickiest parts of the architecture. Both apps need the same pages, but they use different routing libraries:
- Web: `next/navigation` (App Router)
- Desktop: `react-router-dom` (in-memory router)

The solution is the `NavigationAdapter`:

```typescript
// packages/core/navigation/index.ts
interface NavigationAdapter {
  push(path: string): void
  replace(path: string): void
  back(): void
}

// apps/web/platform/navigation.tsx — Next.js implementation
// apps/desktop/src/renderer/src/platform/navigation.tsx — React Router implementation
```

Shared components use `useNavigation().push(path)` and `<AppLink href={path}>`. They never import from `next/navigation` or `react-router-dom` directly.

### Web App Route Structure

```
app/
├── layout.tsx                    ← Root layout (fonts, providers)
├── (auth)/                       ← Auth group routes (no workspace)
│   ├── login/
│   ├── onboarding/
│   ├── invitations/[token]/
│   └── workspaces/               ← Workspace picker / create
├── (landing)/                    ← Marketing pages
│   ├── page.tsx                  ← Homepage
│   └── ...
└── [workspaceSlug]/              ← Dynamic workspace routes
    ├── layout.tsx                ← Workspace shell (auth check, WS connect)
    └── (dashboard)/              ← Dashboard group
        ├── layout.tsx            ← Sidebar + header
        ├── issues/               ← Issue board
        ├── issues/[id]/          ← Issue detail
        ├── agents/               ← Agent list
        ├── agents/[id]/          ← Agent detail
        ├── skills/               ← Skill library
        ├── autopilots/           ← Autopilot list
        ├── chat/                 ← Chat with agents
        ├── projects/             ← Projects
        ├── squads/               ← Squads
        ├── runtimes/             ← Runtime status
        ├── inbox/                ← Notifications
        ├── usage/                ← Token usage dashboard
        └── settings/             ← Workspace settings
```

---

## Real-Time Data Flow in the UI

```
WebSocket event arrives
  ↓
wsClient.on("issue:updated") fires
  ↓
queryClient.setQueryData(...) or queryClient.invalidateQueries(...)
  ↓
TanStack Query re-fetches (or updates cache directly)
  ↓
React components re-render with new data
```

The `packages/core/realtime/use-realtime-sync.ts` hook wires this up. Components don't listen to WebSocket events directly — they just observe query state, which the realtime hook keeps fresh.

---

## API Client

The `packages/core/api/client.ts` is a fetch-based HTTP client. Key features:

- Automatically includes `Authorization: Bearer <token>` header
- Automatically includes `X-Workspace-ID` header
- Uses `parseWithFallback(schema, data, fallback)` from `api/schema.ts` to parse API responses safely — malformed responses return the fallback instead of throwing into the UI
- Response shapes are defined in `api/schemas.ts` using Zod

**API Response Compatibility (critical for desktop app):**

The codebase documents this explicitly: the desktop app installed on a user's machine may be older than the server it connects to. Response shapes must survive drift:

- Parse with Zod schemas, not bare `as` casts
- Optional-chain and default everything downstream
- Enum drift should degrade gracefully, not crash (switch statements need `default` branches)
- Don't bet a UI element on a single boolean field from the server

This is the `parseWithFallback` pattern:

```typescript
const issue = parseWithFallback(IssueSchema, rawData, DEFAULT_ISSUE)
// On parse failure: logs a warning, returns DEFAULT_ISSUE, never throws
```

---

## Desktop App Differences

The desktop app (`apps/desktop/`) adds:

1. **Tab system** — workspace-scoped browser tabs (not URL bar tabs). Each workspace has its own tab group. Tabs are stored in Zustand and persisted to IndexedDB.

2. **`WindowOverlay` system** — pre-workspace flows (create workspace, accept invite) are not routes. They are rendered as overlays on top of whatever is currently displayed. Dispatching `navigation.push('/workspaces/new')` on desktop triggers a window overlay instead of navigating.

3. **`DragStrip` component** — every full-window view must include this as the first flex child, otherwise users can't drag the macOS window (the `-webkit-app-region: drag` CSS property only works on that strip).

4. **No SSR** — the desktop app is entirely client-side. No server-side rendering, no cookies (uses electron-store or IPC for auth token storage).

5. **Workspace healing** — if a tab points to a workspace the user no longer has access to, the desktop app silently drops that tab group and heals. The web app shows a `NoAccessPage` (shareable URL makes the error state meaningful; the desktop has no URL bar).

---

## Internationalization (i18n)

The app supports English (`en`) and Simplified Chinese (`zh-Hans`). The `packages/core/i18n/` module manages:

- Locale detection from browser/system
- Cookie-based locale persistence
- Translation loading
- Language switching

The user's language preference is also stored on the server (`user.language` column) so it persists across devices. The server validates the language value against a hardcoded `supportedLanguages` map in `handler/auth.go` — this list must stay in sync with `SUPPORTED_LOCALES` in `packages/core/i18n/types.ts`.

The translation glossary is in `apps/docs/content/docs/developers/conventions.mdx` (English) and the Chinese version. The legacy `glossary.md` in views is now a stub pointing to the docs page.

---

## Key Components

### `DashboardGuard`
Lives in `packages/views/layout/`. Wraps all workspace dashboard routes. Handles:
- Checking that the user is authenticated
- Checking that the user is a member of the requested workspace
- Redirecting to login/workspace-picker if not

Both apps use this component — it must not have framework-specific code.

### `CoreProvider`
The platform bridge. Initializes:
- API client with base URL and auth token
- Auth store (loads current user)
- Workspace store (loads workspace list)
- WebSocket connection
- QueryClient

Each app wraps its root with `<CoreProvider>` and provides its own `NavigationAdapter`.

### Chat Window (`packages/views/chat/components/chat-window.tsx`)
The real-time chat interface between a user and an agent. Manages:
- Streaming display of agent messages as they arrive via WebSocket
- The live transcript of tool calls during task execution
- Input field with mention support
- Task status indicators

### Task Transcript (`packages/views/common/task-transcript/`)
Shows the live stream of an agent's execution: tool calls, outputs, text reasoning, and status changes. Received via `task:message` WebSocket events during execution and loaded from `task_message` rows after completion.

---

## Testing Conventions

| What | Where | Why |
|------|-------|-----|
| Pure logic (stores, utils) | `packages/core/*.test.ts` | No DOM, fast, no mocking |
| Shared UI components | `packages/views/*.test.tsx` | jsdom, real component testing |
| Next.js-specific wiring | `apps/web/*.test.tsx` | Needs framework mocks |
| Full flows | `e2e/*.spec.ts` | Real browser + backend |

**The most common mistake:** Writing a test for a `packages/views/` component in `apps/web/` and needing to mock `next/navigation`. Move the test to `packages/views/` — if the component doesn't import from Next.js, the test shouldn't need to either.
