-- 006_chat_reasoning.sql — the model's thinking, stored apart from its answer
-- Lets the Agent Chat room show one turn's reasoning in its own block, separately from the reply
-- the director reads (see `splitReasoning` in packages/shared/src/agent/protocol.ts).
-- Additive and safe to re-run. No existing row is touched.
--
-- NULL means the model produced NO separate reasoning trace for that turn (many answers have none).
-- The UI then renders no thinking block — nothing is ever backfilled or invented. Reasoning is only
-- ever written for role='assistant' rows.

alter table chat_messages
  add column if not exists reasoning text;

comment on column chat_messages.reasoning is
  'Assistant thinking for this turn, when the backend produced it (Qwen3 inline thinking tags in content, or a reasoning_content-style field). NULL when the model did not think. Never fabricated.';
