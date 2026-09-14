ALTER TABLE callbacks_raw DROP CONSTRAINT callbacks_raw_verdict_check;
ALTER TABLE callbacks_raw ADD CONSTRAINT callbacks_raw_verdict_check
  CHECK (verdict IN ('applied','unmatched','off_range','duplicate','selftest','applied_direct','unmatched_final'));
