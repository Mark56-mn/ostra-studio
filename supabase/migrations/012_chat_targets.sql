-- 012_chat_targets.sql — direct agent chat: one conversation per canonical agent
-- Backs GET /api/chat/rooms/:id/targets, POST /api/chat/rooms/:id/message and
-- GET /api/chat/rooms/:id/conversation/:kind in apps/api.
--
-- The director picks WHICH agent to talk to (Management Team / Script AI / Image AI / Voice AI /
-- Showrunner) and each choice keeps its own history, so switching agents never mixes one agent's
-- messages with another's.
--
-- Additive and safe to re-run. No existing row is deleted.
--
--   target_kind    the canonical agent kind this turn belongs to. `chat_rooms` has no per-agent
--                  split: every message carries the agent it was addressed to.
--   client_msg_id  a client-supplied UUID used ONLY for idempotency: a double tap / retried request
--                  with the same id returns the first turn instead of calling the model twice. It is
--                  not a foreign key and never identifies a row on its own.
--
-- Honesty notes (CONSTRAINTS.md):
--  * `target_kind` is written from the request's validated target, so a transcript can never be
--    shown under an agent that did not answer it.
--  * Rows written BEFORE this migration came from the original single-agent room, whose only
--    backend was the Script AI (see `buildAgentSystemPrompt` in POST /api/chat/rooms/:id/messages).
--    They are backfilled to 'script' rather than left NULL, so that history stays visible under the
--    agent that actually wrote it. Nothing else is backfilled.

-- ── chat_messages gains the per-agent targeting ──────────────────────────────
alter table chat_messages
  add column if not exists target_kind text;

alter table chat_messages
  add column if not exists client_msg_id uuid;

-- Legacy rows are all Script AI turns; NULL would hide them from every per-target conversation.
update chat_messages
  set target_kind = 'script'
  where target_kind is null;

-- Constrain the kind to the canonical roster (guarded so the migration is re-runnable).
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'chat_messages_target_kind_check'
  ) then
    alter table chat_messages
      add constraint chat_messages_target_kind_check
      check (target_kind is null or target_kind in ('manager', 'script', 'image', 'voice', 'overseer'));
  end if;
end$$;

comment on column chat_messages.target_kind is
  'The canonical agent this turn was addressed to (manager|script|image|voice|overseer). Per-agent history; NULL never happens after migration 012.';

comment on column chat_messages.client_msg_id is
  'Client-supplied UUID for idempotency only: a retried send with the same id returns the first turn instead of calling the model twice. Never a lookup key for anything else.';

-- One conversation per (room, agent), read newest-first by the API.
create index if not exists idx_chat_messages_target
  on chat_messages(room_id, target_kind, created_at);
-- Idempotency lookup. Deliberately NOT unique: the user row and its assistant answer share the id.
create index if not exists idx_chat_messages_client
  on chat_messages(room_id, client_msg_id)
  where client_msg_id is not null;
