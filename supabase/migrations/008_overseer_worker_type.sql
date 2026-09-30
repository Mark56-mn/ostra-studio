-- 008_overseer_worker_type.sql — let a dedicated Showrunner (overseer) worker register
--
-- The AI Studio channel added worker type `overseer` for the Showrunner role, and the registration
-- route accepts it, but the `workers.type` CHECK constraint from migration 001 did not, so a real
-- overseer notebook's POST /api/workers/register failed with:
--   new row for relation "workers" violates check constraint "workers_type_check"
--
-- This is additive: it only WIDENS the allowed set. No existing row is touched.
-- Safe to re-run.

alter table workers drop constraint if exists workers_type_check;

alter table workers
  add constraint workers_type_check
  check (type in ('script', 'image', 'voice', 'video', 'youtube', 'overseer'));

comment on constraint workers_type_check on workers is
  'Worker roles: script/image/voice/video/youtube plus overseer (the AI Studio Showrunner).';
