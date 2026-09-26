-- 003_runtime_supervisor_extensions.sql — Ostra Runtime Supervisor extensions
-- Satisfies spec §4-5 exact persistence: workers extended fields, startup history extended fields, startup_request_id, status lifecycle
-- Safe to re-run (IF NOT EXISTS / additive). No destructive changes.

-- ── workers: add spec-exact fields ───────────────────────────────────────
alter table workers add column if not exists worker_id text;
alter table workers add column if not exists error_code text;
alter table workers add column if not exists error_message text;
alter table workers add column if not exists metadata jsonb;
alter table workers add column if not exists current_task text;
-- current_task_id already exists as uuid; current_task (text) is the spec's string task display
-- capabilities already exists; endpoint/registered_at/last_seen_at/heartbeat_timeout_sec added in 002

-- Unique worker_id slug when present (e.g. script-ai-kaggle)
create unique index if not exists idx_workers_worker_id_unique on workers(worker_id) where worker_id is not null;

-- ── runtime_startup_history: extend to spec §5 ───────────────────────────
-- Existing columns (002): id, schedule_id, worker_type, runtime, provider, trigger_source, requested_at, provider_run_id, provider_response, result, error, completed_at, created_at
-- Spec requires: startup_request_id, worker_id, schedule_id, runtime, provider, provider_run_id, requested_at, started_at, registered_at, completed_at, status, error_code, error_message, metadata

alter table runtime_startup_history add column if not exists startup_request_id text;
alter table runtime_startup_history add column if not exists worker_id uuid references workers(id) on delete set null;
alter table runtime_startup_history add column if not exists started_at timestamptz;
alter table runtime_startup_history add column if not exists registered_at timestamptz;
alter table runtime_startup_history add column if not exists status text;
alter table runtime_startup_history add column if not exists error_code text;
alter table runtime_startup_history add column if not exists error_message text;
alter table runtime_startup_history add column if not exists metadata jsonb;

-- Indexes for new columns
create index if not exists idx_runtime_startup_history_worker_id on runtime_startup_history(worker_id);
create index if not exists idx_runtime_startup_history_startup_request_id on runtime_startup_history(startup_request_id);
create index if not exists idx_runtime_startup_history_status on runtime_startup_history(status);
create index if not exists idx_runtime_startup_history_started_at on runtime_startup_history(started_at);

-- Expand checks — drop and re-add with spec states (idempotent)
do $$
begin
  -- Drop old result check if present (name from 002)
  begin
    alter table runtime_startup_history drop constraint if exists runtime_startup_history_result_check;
  exception when others then null;
  end;
  -- Also drop any legacy check that might have been named differently
  begin
    alter table runtime_startup_history drop constraint if exists runtime_startup_history_status_check;
  exception when others then null;
  end;
end $$;

-- Re-add comprehensive result check (covers both legacy snake and spec UPPER)
alter table runtime_startup_history add constraint runtime_startup_history_result_check
  check (result in (
    'pending','requested','starting','registering','online','failed','timed_out','registered','health_passed',
    'skipped_already_online','skipped_in_progress','skipped_cooldown','not_autostartable',
    'REQUESTED','STARTING','REGISTERING','ONLINE','FAILED','TIMEOUT','CANCELLED'
  ));

-- Add status check (spec states) — nullable, only enforced when status is set
alter table runtime_startup_history add constraint runtime_startup_history_status_check
  check (status is null or status in (
    'REQUESTED','STARTING','REGISTERING','ONLINE','FAILED','TIMEOUT','CANCELLED',
    'pending','requested','starting','registering','online','failed','timed_out','registered','health_passed',
    'skipped_already_online','skipped_in_progress','skipped_cooldown','not_autostartable'
  ));

-- Ensure startup_request_id is usable as correlation id (indexed, unique where present)
create unique index if not exists idx_runtime_startup_history_startup_req_unique on runtime_startup_history(startup_request_id) where startup_request_id is not null;

-- ── runtime_schedules: no change (already complete in 002) ──────────────
-- 002 already has: id (schedule_id), worker_type, runtime, provider, enabled, local_time, timezone, days_of_week, startup_mode, max_start_attempts, cooldown_minutes, created_at, updated_at

-- ── runtime_startup_leases: no schema change needed (002 already) ───────
-- Lease survives Render restart via persisted row + expires_at + partial unique one_active where released_at is null.
