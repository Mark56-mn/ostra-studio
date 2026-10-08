-- 009_provider_routing.sql — which model family answers each agent slot (operator intent)
-- Backs GET /api/routing + PATCH /api/routing in apps/api.
-- Safe to re-run (IF NOT EXISTS / additive). No destructive changes to existing rows.
--
-- One single-row table: there is exactly one routing decision for the whole studio, with optional
-- per-slot overrides. Absence of the row is the code default (mode = 'auto'), so a fresh database
-- needs no seeding and behaves exactly like the shipped default.

create table if not exists provider_routing (
  id integer primary key default 1 check (id = 1),
  -- own | auto | nvidia — anything else is rejected by the check AND normalized to 'auto' on read.
  mode text not null default 'auto' check (mode in ('own', 'auto', 'nvidia')),
  -- Per-slot overrides: {"script":"nvidia","voice":"own"} — unknown slots/modes are dropped on read.
  slots jsonb not null default '{}'::jsonb,
  updated_by text,                    -- actor that changed it (audit trail); never a secret
  updated_at timestamptz not null default now()
);

insert into provider_routing (id, mode, slots)
  values (1, 'auto', '{}'::jsonb)
  on conflict (id) do nothing;

drop trigger if exists trg_provider_routing_touch on provider_routing;
create trigger trg_provider_routing_touch before update on provider_routing
  for each row execute function touch_updated_at();
