-- A package's own migration. Packages number theirs from 900 so they never collide with the
-- core's own numbering.
CREATE TABLE IF NOT EXISTS extension_fixture_notes (
  id bigserial PRIMARY KEY,
  note text NOT NULL,
  at timestamptz NOT NULL DEFAULT now()
);
