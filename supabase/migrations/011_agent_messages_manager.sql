-- 011_agent_messages_manager.sql — let the Management Team speak in the real channel
--
-- Migration `007` constrained `agent_messages.from_agent` / `to_agent` to
-- ('director','script','image','voice','overseer') — before the hosted Management Team existed
-- (migration-era: `b9695c0 feat(studio): hosted Management Team`). Every channel row the manager
-- wrote, and every handoff addressed TO the manager, was therefore rejected by the check at INSERT
-- time and silently reported as "no row" by `insertChannelMessage` / `runAgentTurn` — the manager's
-- position and handoffs were lost while the API looked healthy.
--
-- The direct-chat feature delivers peer messages with `from_agent` = the agent the director is
-- talking to, so a manager chat turn needs exactly the same widening.
--
-- Additive: it only WIDENS the allowed set. No existing row is touched. Safe to re-run.

alter table agent_messages drop constraint if exists agent_messages_from_agent_check;
alter table agent_messages drop constraint if exists agent_messages_to_agent_check;

alter table agent_messages
  add constraint agent_messages_from_agent_check
  check (from_agent in ('director', 'manager', 'script', 'image', 'voice', 'overseer'));

alter table agent_messages
  add constraint agent_messages_to_agent_check
  check (to_agent in ('director', 'manager', 'script', 'image', 'voice', 'overseer', 'all'));

comment on constraint agent_messages_from_agent_check on agent_messages is
  'Who spoke: the human director, the hosted Management Team, or one of the production roles.';

comment on constraint agent_messages_to_agent_check on agent_messages is
  'Who the message is for, plus `all` (a broadcast) — the Management Team addresses agents by name.';
