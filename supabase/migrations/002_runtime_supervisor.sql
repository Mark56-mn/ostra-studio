-- 002_runtime_supervisor.sql — Ostra Runtime Auto-Start Supervisor
-- Covers: persisted schedule, startup lease/lock, startup history, worker health extension
-- Safe to re-run (IF NOT EXISTS). No destructive changes to existing tables.

-- ── Extend workers for self-registration + heartbeat (additive, nullable) ──
alter table workers add column if not exists endpoint text;
alter table workers add column if not exists registered_at timestamptz;
alter table workers add column if not exists last_seen_at timestamptz;
alter table workers add column if not exists heartbeat_timeout_sec int not null default 90;

-- Ensure events covers the new scheduler/worker event types via plain text `type`.

-- ── runtime_schedules — persisted configurable schedules ──
create table if not exists runtime_schedules (
  id uuid primary key default gen_random_uuid(),
  worker_type text not null check (worker_type in ('script','image','voice','video','youtube')),
  runtime text not null,          -- e.g. kaggle, colab, local
  provider text not null,         -- e.g. kaggle, colab-image, kokoro-82m
  enabled boolean not null default true,
  -- Local wall-clock time (HH:MM, 24h) in the configured timezone. NOT stored as UTC — scheduler converts.
  local_time text not null check (local_time ~ '^[0-2][0-9]:[0-5][0-9]$'),
  timezone text not null default 'Africa/Lagos', -- IANA zone, e.g. Africa/Lagos
  -- Days of week: 0=Sun .. 6=Sat. NULL or '{}' means every day.
  days_of_week int[] not null default '{0,1,2,3,4,5,6}',
  label text,                     -- e.g. Morning / Afternoon / Evening — display only, not logic
  startup_mode text not null default 'kaggle_kernel' check (startup_mode in ('kaggle_kernel','colab_notebook','not_autostartable')),
  max_start_attempts int not null default 3 check (max_start_attempts between 1 and 10),
  cooldown_minutes int not null default 15 check (cooldown_minutes between 0 and 1440),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_runtime_schedules_worker on runtime_schedules(worker_type, runtime);
create index if not exists idx_runtime_schedules_enabled on runtime_schedules(enabled) where enabled = true;
drop trigger if exists trg_runtime_schedules_touch on runtime_schedules;
create trigger trg_runtime_schedules_touch before update on runtime_schedules for each row execute function touch_updated_at();

-- ── runtime_startup_leases — persisted startup lease/lock (survives Render restart) ──
-- One active lease per (worker_type, runtime). Used to prevent duplicate concurrent starts.
create table if not exists runtime_startup_leases (
  id uuid primary key default gen_random_uuid(),
  worker_type text not null,
  runtime text not null,
  -- Who/what requested the startup: 'scheduler:<schedule_id>' | 'run_now' | 'api'
  trigger_source text not null default 'scheduler',
  -- Optional reference to the schedule that triggered this lease (null for Run Now).
  schedule_id uuid references runtime_schedules(id) on delete set null,
  acquired_at timestamptz not null default now(),
  expires_at timestamptz not null,
  -- When the lease was released (null = still held / expired in place).
  released_at timestamptz,
  -- Free-form request correlation (Kaggle execution id, etc.), server-side only.
  provider_run_id text,
  constraint runtime_startup_leases_unique_active unique (worker_type, runtime, released_at) deferrable initially deferred
);
-- Partial unique index: at most one unreleased lease per (worker_type, runtime)
create unique index if not exists idx_runtime_startup_leases_one_active on runtime_startup_leases(worker_type, runtime) where released_at is null;
create index if not exists idx_runtime_startup_leases_expires on runtime_startup_leases(expires_at) where released_at is null;

-- ── runtime_startup_history — auditable history of every startup attempt ──
create table if not exists runtime_startup_history (
  id uuid primary key default gen_random_uuid(),
  schedule_id uuid references runtime_schedules(id) on delete set null,
  worker_type text not null,
  runtime text not null,
  provider text not null,
  trigger_source text not null, -- scheduler | run_now | api | heartbeat_recovery
  requested_at timestamptz not null default now(),
  provider_run_id text,
  provider_response jsonb,       -- redacted (never raw secrets)
  result text not null default 'pending' check (result in ('pending','requested','skipped_already_online','skipped_in_progress','skipped_cooldown','not_autostartable','failed','timed_out','registered','health_passed')),
  error text,
  completed_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists idx_runtime_startup_history_worker on runtime_startup_history(worker_type, runtime, requested_at desc);
create index if not exists idx_runtime_startup_history_schedule on runtime_startup_history(schedule_id);
create index if not exists idx_runtime_startup_history_result on runtime_startup_history(result);
