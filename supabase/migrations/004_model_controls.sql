-- 004_model_controls.sql — per-model enable/disable switches (operator intent)
-- Backs GET /api/models + PATCH /api/models/:key in apps/api.
-- Safe to re-run (IF NOT EXISTS / additive). No destructive changes to existing rows.

-- ── model_controls: one row per switchable AI model ─────────────────────────
-- Absence of a row means "on" (default ON) — the API only stores explicit decisions, so a fresh
-- database behaves exactly like the code default and nothing has to be seeded.
create table if not exists model_controls (
  id uuid primary key default gen_random_uuid(),
  -- Stable catalog key, e.g. "script-qwen3-1-7b" (see packages/shared/src/providers/models.ts)
  key text unique not null check (key ~ '^[a-z0-9-]{2,120}$'),
  provider_id text not null,          -- registry slot: script | image | voice | video | youtube
  model_ref text not null,            -- concrete adapter, e.g. qwen3-1-7b, ffmpeg
  enabled boolean not null default true,
  note text,
  updated_by text,                    -- actor that flipped it (audit trail); never a secret
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_model_controls_provider on model_controls(provider_id);
create index if not exists idx_model_controls_enabled on model_controls(enabled);

drop trigger if exists trg_model_controls_touch on model_controls;
create trigger trg_model_controls_touch before update on model_controls
  for each row execute function touch_updated_at();

-- ── runtime_startup_history: allow the "switched off" outcome ───────────────
-- A run refused because the model is disabled must be recorded truthfully (not as failed/skipped
-- cooldown). Extend the existing checks from 003 with the new outcome value.
do $$
begin
  begin
    alter table runtime_startup_history drop constraint if exists runtime_startup_history_result_check;
  exception when others then null;
  end;
  begin
    alter table runtime_startup_history drop constraint if exists runtime_startup_history_status_check;
  exception when others then null;
  end;
end $$;

alter table runtime_startup_history add constraint runtime_startup_history_result_check
  check (result in (
    'pending','requested','starting','registering','online','failed','timed_out','registered','health_passed',
    'skipped_already_online','skipped_in_progress','skipped_cooldown','skipped_disabled','not_autostartable',
    'REQUESTED','STARTING','REGISTERING','ONLINE','FAILED','TIMEOUT','CANCELLED'
  ));

alter table runtime_startup_history add constraint runtime_startup_history_status_check
  check (status is null or status in (
    'REQUESTED','STARTING','REGISTERING','ONLINE','FAILED','TIMEOUT','CANCELLED',
    'pending','requested','starting','registering','online','failed','timed_out','registered','health_passed',
    'skipped_already_online','skipped_in_progress','skipped_cooldown','skipped_disabled','not_autostartable'
  ));
