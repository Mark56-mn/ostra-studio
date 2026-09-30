-- 007_agent_channel.sql — the inter-agent production channel
-- Backs the AI Studio collaboration room: agents talk to EACH OTHER (Script AI → Image AI → Voice AI)
-- and the Showrunner reports the real status to the director.
--
-- Additive and safe to re-run. No existing row is touched.
--
--   chat_rooms.kind        'director' (default, the human ↔ Script AI room) | 'studio' (agent channel)
--   agent_messages         one real message in that channel, from one participant to another.
--
-- Honesty notes (see CONSTRAINTS.md):
--  * A row is only written for a message the model ACTUALLY emitted, or for the director's own brief.
--    Nothing is inferred from a reply, and no message is ever backfilled.
--  * `status` records what really happened to the message: 'sent' (recorded, not yet delivered),
--    'delivered' (the recipient agent was actually called with it in its context), 'failed' (the
--    recipient's call failed — `error` says why), 'reported' (it was addressed to the director, so
--    there is no agent to deliver it to).
--  * `backend` records which real model produced an agent row (never a secret). It is NULL for the
--    director's own messages.

-- ── chat_rooms gains the channel kind ────────────────────────────────────────
alter table chat_rooms
  add column if not exists kind text not null default 'director';

-- Keep the kind constrained without failing if a row already predates the column.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'chat_rooms_kind_check'
  ) then
    alter table chat_rooms
      add constraint chat_rooms_kind_check check (kind in ('director', 'studio'));
  end if;
end$$;

comment on column chat_rooms.kind is
  'director = the human ↔ Script AI chat room; studio = the agent-to-agent production channel.';

-- ── agent_messages: the real inter-agent channel ─────────────────────────────
create table if not exists agent_messages (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references chat_rooms(id) on delete cascade,
  -- Denormalised copy of the room's project for cheap filtering; kept in sync on insert only.
  project_id uuid references projects(id) on delete cascade,
  -- Who spoke and who it is for. 'director' is the human; the rest are AI roles.
  from_agent text not null check (from_agent in ('director', 'script', 'image', 'voice', 'overseer')),
  to_agent text not null check (to_agent in ('director', 'script', 'image', 'voice', 'overseer', 'all')),
  -- brief = the director's opening instruction; position = an agent's take for the record;
  -- request = ask a peer to do something; handoff = pass work along; report = the overseer's status
  -- report; ack = acknowledge a peer.
  kind text not null default 'position' check (kind in ('brief', 'position', 'request', 'handoff', 'report', 'ack')),
  content text not null,
  -- Free-form structured extras the model attached (kept primitive/JSON-safe upstream).
  payload jsonb not null default '{}'::jsonb,
  -- What really happened to this message (see the header note). Never optimistic.
  status text not null default 'sent' check (status in ('sent', 'delivered', 'failed', 'reported')),
  -- Which real backend produced an agent row: {kind, provider, model, endpointHost, latencyMs, parse}.
  backend jsonb,
  -- The honest failure reason when `status` is 'failed'. NULL otherwise.
  error jsonb,
  created_at timestamptz not null default now()
);
create index if not exists idx_agent_messages_room on agent_messages(room_id, created_at);
create index if not exists idx_agent_messages_to on agent_messages(room_id, to_agent);
create index if not exists idx_agent_messages_project on agent_messages(project_id, created_at desc);

comment on table agent_messages is
  'The real agent-to-agent production channel. One row per message a participant actually sent; status/backend/error record what really happened.';
