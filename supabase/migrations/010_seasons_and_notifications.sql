-- 010_seasons_and_notifications.sql — season-first approval workflow + in-app notifications
--
-- The product's workflow is season-first (spec §5): the Manager AI develops a COMPLETE season package,
-- the human approves or rejects THAT package once, and only then may expensive production begin.
--
-- Additive and safe to re-run. No existing row is touched.
--
--   seasons                one proposed/approved season package per project (a project may iterate).
--   production gate        enforced in the API (apps/api/src/routes/tasks.ts) via the pure decision in
--                          packages/shared/src/domain/seasons.ts — image/voice/video/youtube tasks for a
--                          project are refused (409 SEASON_NOT_APPROVED) until a season is 'approved'.
--   notifications          in-app inbox: season submitted/decided, task failed, agent offline.
--
-- Honesty notes (CONSTRAINTS.md):
--  * A season's `status` only moves through real human decisions. Nothing marks a season approved.
--  * `assumptions` records the questions the Manager could NOT resolve alone, so they reach the human
--    with the package instead of being silently guessed.

-- ── seasons ─────────────────────────────────────────────────────────────────
create table if not exists seasons (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  title text not null,
  premise text,
  episode_count int not null default 0 check (episode_count >= 0),
  -- [{ number, title, synopsis }] — the proposed episode list with a synopsis for each
  episodes jsonb not null default '[]'::jsonb,
  -- [{ name, role, description }] — the proposed cast for the season
  characters jsonb not null default '[]'::jsonb,
  -- world/setting description and established rules
  world jsonb not null default '{}'::jsonb,
  -- major story arcs (plain strings) + the ending the season builds toward
  arcs jsonb not null default '[]'::jsonb,
  ending text,
  -- [{ question, assumption }] — decisions the Manager resolved on its own, surfaced for review
  assumptions jsonb not null default '[]'::jsonb,
  -- { episodes, images, clips, minutes, notes } — estimated production requirements
  production_estimate jsonb not null default '{}'::jsonb,
  status text not null default 'draft'
    check (status in ('draft','submitted','approved','changes_requested','rejected')),
  submitted_at timestamptz,
  decided_at timestamptz,
  decided_by text,
  decision_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_seasons_project on seasons(project_id);
create index if not exists idx_seasons_status on seasons(status);

-- ── notifications (in-app inbox, spec §8) ───────────────────────────────────
create table if not exists notifications (
  id uuid primary key default gen_random_uuid(),
  kind text not null, -- 'season_submitted' | 'season_decided' | 'task_failed' | 'agent_offline' | ...
  project_id uuid references projects(id) on delete cascade,
  season_id uuid references seasons(id) on delete cascade,
  title text not null,
  body text,
  severity text not null default 'info' check (severity in ('info','warning','critical')),
  requires_action boolean not null default false,
  -- idempotency: one notification per (kind, key) so retries never duplicate an inbox row
  dedupe_key text,
  read_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists idx_notifications_created on notifications(created_at desc);
create index if not exists idx_notifications_unread on notifications(read_at) where read_at is null;
create unique index if not exists idx_notifications_dedupe
  on notifications(kind, dedupe_key) where dedupe_key is not null;
