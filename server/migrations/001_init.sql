CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE settings (
  key text PRIMARY KEY,
  value text NOT NULL,
  encrypted boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE people (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username text UNIQUE NOT NULL,
  display_name text NOT NULL,
  password_hash text NOT NULL,
  is_owner boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  must_change_password boolean NOT NULL DEFAULT false,
  daily_limit_cents bigint,
  per_tx_limit_cents bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz
);

CREATE TABLE permissions (
  person_id uuid NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  permission text NOT NULL,
  PRIMARY KEY (person_id, permission)
);

CREATE TABLE sessions (
  id text PRIMARY KEY,
  person_id uuid NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  csrf_token text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  ip text,
  user_agent text
);
CREATE INDEX sessions_person_idx ON sessions(person_id);

CREATE TABLE login_attempts (
  key text PRIMARY KEY,
  failures int NOT NULL DEFAULT 0,
  locked_until timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit_log (
  id bigserial PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  person_id uuid,
  action text NOT NULL,
  target text,
  before_json jsonb,
  after_json jsonb,
  ip text
);
CREATE OR REPLACE FUNCTION audit_log_immutable() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'audit_log is append-only'; END; $$ LANGUAGE plpgsql;
CREATE TRIGGER audit_log_no_update BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();

CREATE TABLE jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  run_at timestamptz NOT NULL DEFAULT now(),
  attempts int NOT NULL DEFAULT 0,
  max_attempts int NOT NULL DEFAULT 5,
  locked_by text,
  locked_at timestamptz,
  done_at timestamptz,
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX jobs_ready_idx ON jobs(run_at) WHERE done_at IS NULL;

CREATE UNLOGGED TABLE cache (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  expires_at timestamptz NOT NULL
);

CREATE TABLE operators (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text UNIQUE NOT NULL,
  credential_enc text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','verified','failed','disabled')),
  priority int NOT NULL DEFAULT 100,
  rotated_at timestamptz NOT NULL DEFAULT now(),
  last_probe_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type text NOT NULL,
  subtype text,
  originator_conversation_id text UNIQUE NOT NULL,
  conversation_id text,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','awaiting_approval','sent','completed','failed','unknown','rejected','cancelled')),
  amount_cents bigint,
  currency text NOT NULL DEFAULT 'KES',
  recipient_kind text,
  recipient_value text,
  recipient_name text,
  account_reference text,
  remarks text,
  payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  operator_id uuid REFERENCES operators(id),
  created_by uuid REFERENCES people(id),
  approved_by uuid REFERENCES people(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  result_at timestamptz,
  result_source text CHECK (result_source IN ('callback','poll')),
  result_code text,
  result_desc text,
  meaning text,
  retriable boolean,
  receipt text,
  raw_result_json jsonb,
  bulk_plan_id uuid
);
CREATE INDEX requests_status_idx ON requests(status, sent_at);

CREATE TABLE balances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  queried_at timestamptz NOT NULL DEFAULT now(),
  working_cents bigint,
  utility_cents bigint,
  charges_paid_cents bigint,
  raw jsonb NOT NULL
);

CREATE TABLE callbacks_raw (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  path text NOT NULL,
  source_ip text,
  in_allowlist boolean NOT NULL DEFAULT false,
  body_json jsonb,
  received_at timestamptz NOT NULL DEFAULT now(),
  matched_request_id uuid,
  verdict text NOT NULL DEFAULT 'unmatched'
    CHECK (verdict IN ('applied','unmatched','off_range','duplicate','selftest'))
);
