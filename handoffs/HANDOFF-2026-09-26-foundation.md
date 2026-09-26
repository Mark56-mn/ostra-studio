# Handoff — Phase 0/1 Foundation (control plane + dashboard)

## 1. Task
Implement **IMPLEMENTATION_PLAN.md Phase 0 (Repository foundation) + Phase 1 (Domain foundation) + Phase 2 spine + Phase 3 Dashboard** from the blueprint. User said "Please continue" after reviewing the docs-only repo. Goal: real architecture first, no mock workers, no fake success states, provider adapters replaceable, orchestrator owns state, mobile-first dashboard, Supabase as the named DB/storage candidate, Vercel-compatible Next.js frontend, secrets never in frontend, audit log, approval gate default closed.

## 2. Result
Shipped a buildable, preview-verified Next.js 14 application that implements the full domain spine and a production-ready control-plane UI. Workers report real health (OFFLINE when unconfigured) — no mocks — and the API layer persists through Supabase when configured and fails honestly (503 with hint) when not. Build passes, preview is listening.

## 3. Repository state
Branch: `main` (single commit `4e12652` + uncommitted foundation work to be saved via Changes panel).
Runtime: Node 22.23.2, Bun 1.4.2.
Preview: `freebuff-preview start` → `https://3000-int7cdi0mhfqvpwo3t7ht.e2b.app` (Next dev on 0.0.0.0:3000).
Install: `bun install` · Preview: `bun run dev` on 3000 · Build: `bun run build`.

## 4. Files changed
- `package.json` — Next 14, React 18, Supabase JS, Zod, Tailwind 3, TS 5, eslint-config-next
- `tsconfig.json` — `paths: @/* → ./src/*`, Next preset
- `tailwind.config.ts` / `postcss.config.mjs` / `next.config.mjs` / `src/app/globals.css` — Ostra palette (ink #070A14, card #131A32, accent #FF4D5A / #3DE0B3), mobile-first tokens
- `src/app/layout.tsx` + `src/app/page.tsx` — cinematic landing page: hero with ink-wash, pipeline strip, episode preview card, worker OFFLINE truth, "what's real today" panel, footer
- `src/app/projects/page.tsx` — projects CRUD + episodes per project + inline "new project/episode" forms + AgentRoom embedded
- `src/app/projects/[id]/page.tsx` — stub that routes to `/projects` (full bible/characters expands in Phase 1)
- `src/app/episodes/[id]/page.tsx` — episode detail: pipeline, task list + "queue task" form, approval buttons (approve/reject/changes_requested), artifacts placeholder (versioned, Phase 7)
- `src/app/agents/page.tsx` — Agent Room + live `/api/providers` health probe + raw `/api/health` dump
- `src/app/activity/page.tsx` — immutable audit log, polls `/api/events` every 8s
- `src/components/TopNav.tsx` — sticky top nav, desktop + mobile overflow row, AUTO_PUBLISH OFF badge
- `src/components/Pipeline.tsx` — `PIPELINE_ORDER` visual (IDEA…YOUTUBE) with active/done states
- `src/components/AgentRoom.tsx` + `src/components/ui/Badge.tsx` + `src/components/ui/Card.tsx` + `src/lib/cn.ts` — shared UI
- `src/domain/schemas.ts` — Zod schemas + TS types for project/character/location/episode/scene/artifact/worker/task/event/approval + `PIPELINE_ORDER`, `episodeToPipelineStep`, `nextEpisodeStatus`
- `src/orchestrator/state.ts` — pure state machines for worker/task/episode transitions, `dependenciesSatisfied`, `isHeartbeatStale`, `isPublishBlocked`
- `src/orchestrator/events.ts` — audit helpers, typed `EVT.*`
- `src/providers/contracts.ts` — capability interfaces `ScriptProvider` / `ImageProvider` / `VoiceProvider` / `VideoRenderer` / `StorageProvider` / `YouTubeProvider` + `offlineHealth`/`offlineResult`
- `src/providers/registry.ts` — `resolveRegistry()` / `getRegistry()` — probes `KAGGLE_SCRIPT_URL` / `COLAB_IMAGE_URL` / `KOKORO_VOICE_URL` truthfully; returns OFFLINE adapters when env absent; never fakes COMPLETED
- `src/lib/env.ts` — server-only secret access, `supabaseConfigured()`, `flagAutoPublish()`
- `src/lib/supabase.ts` — `getBrowserSupabase()` / `getServerSupabase()` / `isSupabaseConfigured()`
- `src/app/api/health/route.ts` — real health: `supabase` flag + per-provider `status`/`reason`/`latencyMs`
- `src/app/api/providers/route.ts` — per-provider probe without Supabase
- `src/app/api/projects/route.ts` — GET/POST projects → Supabase or 503 with hint
- `src/app/api/episodes/route.ts` — GET/POST episodes, auto-numbers, writes `episode.created` event
- `src/app/api/tasks/route.ts` — GET/POST tasks, writes `task.created`
- `src/app/api/events/route.ts` — GET/POST events
- `src/app/api/approvals/route.ts` — GET + POST (creates `pending` request or records `approved`/`rejected`/`changes_requested`; on `approved` advances episode status only if `ready_for_review`; writes audit event)
- `src/app/api/workers/route.ts` — GET (Supabase or offline fallback) + POST registration, writes `worker.connected`
- `supabase/migrations/001_initial.sql` — full schema: `projects`, `characters`, `locations`, `episodes`, `scenes`, `workers`, `tasks`, `artifacts`, `events`, `approvals` + indexes + `touch_updated_at()` triggers; `artifacts` enforces `storage_path OR inline_text`
- `.gitignore` — updated for Next

Removed: `index.ts`, `CLAUDE.md` (bun init scaffold). Kept: all `*.md` docs + `handoffs/`. Untracked but expected: `.next/`, `node_modules/`, `bun.lock`.

## 5. Tests/checks
- `bun install` — 82 packages installed
- `tsc --noEmit` — **pass** (no errors)
- `next build` — **pass**, compiled successfully, 7 static/dynamic routes, no type errors
  - Routes: `/` (1.06 kB), `/projects` (6.5 kB), `/agents` (3.87 kB), `/activity` (2.71 kB), `/episodes/[id]` (5.48 kB), APIs dynamic
- `freebuff-preview start` — **ready**, `listening:true` on 3000
- `curl /api/health` — `{ ok:true, supabase:"not_configured", providers: { script:"OFFLINE Set KAGGLE…", image:"OFFLINE…", voice:"OFFLINE…", video:"OFFLINE…", storage:"OFFLINE…", youtube:"OFFLINE…" } }` — truthful, no fake ONLINE
- `curl /` — 200 HTML with `<title>Ostra Studio — Manhwa Production Control</title>`
- No Supabase configured in this sandbox, so `/api/projects` correctly returns 503 with hint — this is the intended "real state" behavior per CONSTRAINTS.md (show OFFLINE/503, don't fake).

## 6. Integration status
- **Next.js / Vercel-compatible frontend** — verified (dev + build + preview)
- **Supabase Postgres + Storage** — **configured but unverified** — migration file shipped, clients handle both anon + service_role, but no Supabase project is connected in this workspace; all API routes degrade to 503/offline-fallback with explicit hints (intentional)
- **Kaggle Script AI** — **not attempted** — adapter probes `KAGGLE_SCRIPT_URL` when set; currently OFFLINE (correct)
- **Colab Image AI** — **not attempted** — probes `COLAB_IMAGE_URL`; OFFLINE
- **Kokoro-82M Voice** — **not attempted** — probes `KOKORO_VOICE_URL` / `COLAB_VOICE_URL`; OFFLINE
- **FFmpeg renderer** — **not attempted** — Phase 7, offline stub
- **YouTube API** — **not attempted** — Phase 9, offline stub

No integration is marked verified without being exercised.

## 7. Known issues
- Supabase not connected in this workspace — projects/episodes/tasks are not persisted until `NEXT_PUBLIC_SUPABASE_URL` + key is set and `supabase/migrations/001_initial.sql` is applied. UI handles this (503 banner) but it is a setup step.
- No auth yet — projects/episodes are currently unscoped; wire Supabase Auth + RLS (or NextAuth) before multi-user use.
- `artifacts` table expects Supabase Storage bucket `ostra-assets` — bucket creation is manual (Storage → New bucket).
- Episode page loads the episode via `GET /api/episodes` (all) and filters client-side — add `GET /api/episodes/:id` before large datasets.
- No Supabase Realtime subscription — activity page polls every 8s; wire `supabase.realtime` when Supabase is connected.
- No rate limiting / CSRF on API routes yet — add before public exposure.
- `tsconfig` still references `bun` lib entry from init; harmless but could be cleaned to `dom` only.

## 8. Decisions
- **Next.js 14 (pages via `src/app` App Router) + Supabase** to satisfy the docs' "Vercel-compatible frontend / Supabase Postgres+Storage" direction; avoids diverging to a Convex stack the docs didn't specify.
- **Provider adapters are real HTTP probers, not mocks** — `registry.ts` uses `fetch(..., { signal: AbortSignal.timeout(4000) })` to report `ONLINE`/`DEGRADED`/`OFFLINE` truthfully; task execution (`developStory` etc.) still returns `OFFLINE — Phase 4/5/6` until the real submit/result protocol is wired, so health ≠ fake progress.
- **Database stores metadata + state, Storage stores binaries** per ARCHITECTURE.md — `artifacts.storage_path` is the Storage key; `inline_text` holds short text artifacts only.
- **Approval gate blocks YouTube by default** — `AUTO_PUBLISH=false` is the server default and the UI badge; `POST /api/approvals` with `approved` only advances `ready_for_review → approved`; YouTube upload will check this again in Phase 9.
- **Orchestrator state is pure functions** (`src/orchestrator/state.ts`) so transitions are unit-testable without Supabase.
- **Mobile-first landing + dashboard** — sticky `TopNav` with horizontal overflow on `<640px`, large touch targets, video-friendly card ratios.

## 9. Environment/configuration
Set in Freebuff Settings → Environment (and mirror in `freebuff-deploy env` for production):

Required for persistence (pick one key set):
- `NEXT_PUBLIC_SUPABASE_URL` — Supabase project URL
- `NEXT_PUBLIC_SUPABASE_ANON_KEY` — anon key (browser-safe)
- `SUPABASE_SERVICE_ROLE_KEY` — server-only (preferred on API routes; never commit, never expose)

Then run once in Supabase SQL editor: `supabase/migrations/001_initial.sql`. Create Storage bucket `ostra-assets` (public or signed URLs as you prefer).

Optional — turn workers ONLINE (no code change):
- `KAGGLE_SCRIPT_URL` — Script AI base URL (Kaggle)
- `KAGGLE_API_TOKEN` — server-only, if your Kaggle service requires auth
- `COLAB_IMAGE_URL` — Image AI base URL (Colab)
- `COLAB_VOICE_URL` — Voice AI (Colab) — alternative to Kokoro
- `KOKORO_VOICE_URL` — Kokoro-82M URL
- `AUTO_PUBLISH` — `false` (default) or `true` — keep `false` until you explicitly want auto-upload
- Future: `YOUTUBE_CLIENT_ID` / `YOUTUBE_CLIENT_SECRET` / `YOUTUBE_REDIRECT_URI` (Phase 9)

No secrets are in `src/` or committed.

Preview/build commands saved: `install=bun install`, `preview=bun run dev` on 3000, `build=bun run build`.

## 10. Next agent
**Implement Phase 1 depth + Phase 4 Script AI wire-up (in that order):**

1. Create `supabase` project, set env vars above, apply migration, verify `GET /api/projects` returns 200 (not 503) and you can create a project + episode end-to-end (use the `/projects` form or curl).
2. Expand project detail at `/projects/[id]` — story bible editor (premise/worldRules/timeline/arcs/visualStyle), characters + locations CRUD (tables already exist, just need UI + `/api/characters`, `/api/locations`).
3. Add `GET /api/episodes/:id` + `PATCH /api/episodes/:id` (status transitions via `canAdvanceEpisode` / `episodeOrder`) and `GET /api/artifacts` + scene management (`/api/scenes`).
4. Then wire **Script AI Phase 4** — decide the Kaggle task protocol (webhook vs. poll), implement `POST /api/tasks/:id/dispatch` that uses `ScriptProvider.developStory/writeScript/breakdownScenes` against `KAGGLE_SCRIPT_URL` with `KAGGLE_API_TOKEN`, persist `artifacts` (versioned, never overwrite), and add retry/timeout handling. Keep the "if Kaggle is down, task stays queued/failed and health is OFFLINE" guarantee.

Prerequisites: Supabase project + the three env vars.

## 11. Do not redo
- Do not re-scaffold the Next project — `package.json` scripts, Tailwind, TS paths are correct and build-verified.
- Do not recreate `001_initial.sql` — it is already idempotent (`IF NOT EXISTS`) and covers all Phase 0/1 tables + indexes + triggers.
- Do not reintroduce mocks — adapters must stay OFFLINE when unconfigured; fix by wiring real URLs/tokens.
- Do not overwrite `src/domain/schemas.ts`, `src/providers/contracts.ts`, `src/orchestrator/state.ts` without a documented reason — they are the contract surface for all future adapters.
- Do not delete `handoffs/` history.

## 12. Verification
- `tsc --noEmit` — verified, pass
- `next build` — verified, pass (see §5 for route sizes)
- `freebuff-preview start` — verified, `listening:true`, `/` + `/api/health` respond
- Supabase persistence — **unverified** (no project configured in this workspace; intentional 503 path is verified, but end-to-end create/list through Supabase is not)
- Kaggle/Colab/Kokoro health probes — **unverified** against real runtimes (env vars not set, so OFFLINE path is verified, ONLINE path is not)
- YouTube/FFmpeg — not attempted (future phases)

---

Generated from `README.md`, `PROJECT_CONTEXT.md`, `ARCHITECTURE.md`, `CONSTRAINTS.md`, `AGENT_CONTRACTS.md`, `IMPLEMENTATION_PLAN.md`, `HANDOFF_PROTOCOL.md`, and `HANDOFF-2026-09-26-repository-blueprint.md` on 2026-09-26.
