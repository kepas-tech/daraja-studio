ALTER TABLE requests
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN poll_attempts int NOT NULL DEFAULT 0,
  ADD COLUMN last_poll_at timestamptz,
  ADD COLUMN checked_by uuid REFERENCES people(id),
  ADD COLUMN checked_at timestamptz,
  ADD COLUMN checked_note text;

CREATE INDEX requests_conversation_idx ON requests(conversation_id);
CREATE INDEX requests_receipt_idx ON requests(receipt);
CREATE INDEX requests_dup_guard_idx ON requests(recipient_value, amount_cents, created_at DESC);
CREATE INDEX requests_created_by_idx ON requests(created_by, created_at DESC);

CREATE OR REPLACE FUNCTION requests_touch() RETURNS trigger AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$ LANGUAGE plpgsql;
CREATE TRIGGER requests_touch BEFORE UPDATE ON requests FOR EACH ROW EXECUTE FUNCTION requests_touch();

-- A request is immutable once final. The only writer allowed to change a final row is a
-- Transaction Status result (result_source = 'poll'), which the design makes authoritative.
CREATE OR REPLACE FUNCTION requests_final_guard() RETURNS trigger AS $$
BEGIN
  IF OLD.status IN ('completed','failed','cancelled','rejected') AND NEW.result_source IS DISTINCT FROM 'poll' THEN
    IF NEW.status IS DISTINCT FROM OLD.status OR NEW.result_code IS DISTINCT FROM OLD.result_code
       OR NEW.result_desc IS DISTINCT FROM OLD.result_desc OR NEW.receipt IS DISTINCT FROM OLD.receipt
       OR NEW.amount_cents IS DISTINCT FROM OLD.amount_cents OR NEW.recipient_kind IS DISTINCT FROM OLD.recipient_kind
       OR NEW.recipient_value IS DISTINCT FROM OLD.recipient_value THEN
      RAISE EXCEPTION 'request % is final', OLD.id;
    END IF;
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER requests_final_guard BEFORE UPDATE ON requests FOR EACH ROW EXECUTE FUNCTION requests_final_guard();
