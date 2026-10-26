-- Soft handover + "question for the team" (Ava keeps helping while the team catches up).
alter table conversations
  add column if not exists handed_off_at     timestamptz, -- when Ava escalated to a human
  add column if not exists open_question     text,        -- a question Ava couldn't answer, flagged for the team
  add column if not exists open_question_at  timestamptz;
