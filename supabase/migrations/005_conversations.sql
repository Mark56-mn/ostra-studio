-- 005_conversations.sql — Agent Chat rooms
-- Backs GET/POST /api/chat/rooms + /api/chat/rooms/:id/messages in apps/api.
-- A room is the transcript between the human director and the Script AI. `actions` on an assistant
-- row is the AUDIT of what the agent actually wrote to the store — never a plan, never a promise.
-- Safe to re-run (IF NOT EXISTS / additive). No destructive changes to existing rows.

-- ── chat_rooms: one transcript, optionally scoped to a project (the store it may adjust) ──
create table if not exists chat_rooms (
  id uuid primary key default gen_random_uuid(),
  -- null = a general room with no store scope; the agent can still create a project from it.
  project_id uuid references projects(id) on delete cascade,
  title text not null default 'Agent room',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_chat_rooms_project on chat_rooms(project_id);
create index if not exists idx_chat_rooms_updated on chat_rooms(updated_at desc);

drop trigger if exists trg_chat_rooms_touch on chat_rooms;
create trigger trg_chat_rooms_touch before update on chat_rooms
  for each row execute function touch_updated_at();

-- ── chat_messages: the transcript; assistant rows carry the real store writes ──
create table if not exists chat_messages (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references chat_rooms(id) on delete cascade,
  role text not null check (role in ('user','assistant')),
  content text not null,
  -- For role='assistant': the store actions that were APPLIED (ok/error per action, with the real
  -- row id), so the UI can show what changed without re-deriving it. '[]' for user rows.
  actions jsonb not null default '[]'::jsonb,
  -- Which real backend answered: {kind:'project_worker'|'hosted_fallback', provider, model, ...}.
  -- Never a secret, never a fabricated claim.
  backend jsonb,
  -- Populated when the agent could not answer — the honest reason, so a failure is visible in the
  -- transcript instead of being silently dropped.
  error jsonb,
  created_at timestamptz not null default now()
);
create index if not exists idx_chat_messages_room on chat_messages(room_id, created_at);
