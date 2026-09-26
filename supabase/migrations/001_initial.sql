-- 001_initial.sql — Ostra Studio domain
-- Apply in Supabase SQL editor or via supabase db push.
-- Safe to re-run: uses IF NOT EXISTS where possible.

create extension if not exists "pgcrypto";

-- projects hold the persistent story bible
create table if not exists projects (
  id uuid primary key default gen_random_uuid(),
  slug text unique not null check (slug ~ '^[a-z0-9-]{2,64}$'),
  title text not null,
  logline text,
  story_bible jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists characters (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  name text not null,
  role text,
  description text,
  visual_ref text,
  created_at timestamptz not null default now()
);

create table if not exists locations (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  name text not null,
  description text,
  visual_ref text,
  created_at timestamptz not null default now()
);

create table if not exists episodes (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  number int not null check (number >= 1),
  title text not null,
  concept text,
  outline text,
  script text,
  narration text,
  status text not null default 'idea'
    check (status in ('idea','writing','scenes','imaging','voicing','rendering','qc','ready_for_review','approved','uploading','published','archived')),
  auto_publish boolean not null default false,
  youtube_video_id text,
  youtube_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(project_id, number)
);

create table if not exists scenes (
  id uuid primary key default gen_random_uuid(),
  episode_id uuid not null references episodes(id) on delete cascade,
  index int not null check (index >= 0),
  title text,
  script_excerpt text,
  image_spec text,
  narration_segment text,
  duration_sec double precision,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(episode_id, index)
);

-- workers — registered adapters, health is authoritative
create table if not exists workers (
  id uuid primary key default gen_random_uuid(),
  type text not null check (type in ('script','image','voice','video','youtube')),
  provider text not null,
  model text,
  runtime text,
  status text not null default 'OFFLINE'
    check (status in ('OFFLINE','CONNECTING','ONLINE','IDLE','QUEUED','WORKING','WAITING','COMPLETED','FAILED','RETRYING')),
  capabilities text[] not null default '{}',
  current_task_id uuid,
  last_heartbeat_at timestamptz,
  error text,
  config jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists tasks (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references projects(id) on delete set null,
  episode_id uuid references episodes(id) on delete set null,
  scene_id uuid references scenes(id) on delete set null,
  type text not null,
  worker_type text not null check (worker_type in ('script','image','voice','video','youtube')),
  worker_id uuid references workers(id) on delete set null,
  status text not null default 'pending'
    check (status in ('pending','queued','working','waiting','completed','failed','retrying','cancelled')),
  depends_on uuid[] not null default '{}',
  input jsonb,
  output jsonb,
  error text,
  attempts int not null default 0,
  max_attempts int not null default 3,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz
);
create index if not exists idx_tasks_episode on tasks(episode_id);
create index if not exists idx_tasks_status on tasks(status);

-- artifacts are immutable/versioned; large binaries live in Supabase Storage, not here
create table if not exists artifacts (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references projects(id) on delete set null,
  episode_id uuid references episodes(id) on delete set null,
  scene_id uuid references scenes(id) on delete set null,
  task_id uuid references tasks(id) on delete set null,
  kind text not null check (kind in ('script','outline','scene_spec','image','narration','audio','subtitle','thumbnail','draft_video','final_video','qc_report','other')),
  version int not null default 1,
  storage_path text, -- e.g. "episodes/<id>/scene-03-v2.png" in Supabase Storage bucket "ostra-assets"
  inline_text text,
  metadata jsonb,
  created_at timestamptz not null default now(),
  constraint artifacts_has_content check (storage_path is not null or inline_text is not null)
);
create index if not exists idx_artifacts_episode on artifacts(episode_id);
create index if not exists idx_artifacts_task on artifacts(task_id);

-- immutable audit log
create table if not exists events (
  id uuid primary key default gen_random_uuid(),
  type text not null,
  project_id uuid references projects(id) on delete set null,
  episode_id uuid references episodes(id) on delete set null,
  task_id uuid references tasks(id) on delete set null,
  worker_id uuid references workers(id) on delete set null,
  actor text,
  payload jsonb,
  created_at timestamptz not null default now()
);
create index if not exists idx_events_episode on events(episode_id);
create index if not exists idx_events_created on events(created_at desc);

create table if not exists approvals (
  id uuid primary key default gen_random_uuid(),
  episode_id uuid not null references episodes(id) on delete cascade,
  requested_by text,
  decision text not null default 'pending' check (decision in ('pending','approved','rejected','changes_requested')),
  note text,
  decided_by text,
  decided_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists idx_approvals_episode on approvals(episode_id);

-- updated_at triggers
create or replace function touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

drop trigger if exists trg_projects_touch on projects;
create trigger trg_projects_touch before update on projects for each row execute function touch_updated_at();
drop trigger if exists trg_episodes_touch on episodes;
create trigger trg_episodes_touch before update on episodes for each row execute function touch_updated_at();
drop trigger if exists trg_scenes_touch on scenes;
create trigger trg_scenes_touch before update on scenes for each row execute function touch_updated_at();
drop trigger if exists trg_workers_touch on workers;
create trigger trg_workers_touch before update on workers for each row execute function touch_updated_at();
