ALTER TABLE jobs ADD COLUMN recurring boolean NOT NULL DEFAULT false;
CREATE UNIQUE INDEX jobs_recurring_kind_uniq ON jobs(kind) WHERE recurring AND done_at IS NULL;
