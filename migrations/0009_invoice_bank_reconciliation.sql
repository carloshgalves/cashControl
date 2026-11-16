-- SPEC-004 / D3 — manual bank-statement invoice observations.
-- User-supplied amounts are evidence for comparison only, NOT movements, payments,
-- fees, refunds, or modifications of the calculated invoice.
CREATE TABLE card_invoice_bank_observations (
 observation_seq INTEGER PRIMARY KEY AUTOINCREMENT,
 owner_user_id TEXT NOT NULL CHECK(length(owner_user_id) BETWEEN 1 AND 128),
 observation_id TEXT NOT NULL,
 creation_key TEXT NOT NULL,
 card_id TEXT NOT NULL,
 invoice_cycle TEXT NOT NULL CHECK(length(invoice_cycle)=7 AND invoice_cycle GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'),
 reported_total_cents INTEGER NOT NULL CHECK(reported_total_cents BETWEEN 0 AND 9000000000000),
 calculated_total_at_entry_cents INTEGER NOT NULL CHECK(calculated_total_at_entry_cents BETWEEN 1 AND 9000000000000),
 created_at TEXT NOT NULL,
 UNIQUE(owner_user_id,observation_id),
 UNIQUE(owner_user_id,creation_key),
 FOREIGN KEY(owner_user_id,card_id) REFERENCES credit_cards(owner_user_id,card_id) ON DELETE RESTRICT
);
CREATE INDEX card_invoice_observations_idx
 ON card_invoice_bank_observations(owner_user_id,card_id,invoice_cycle,observation_seq DESC);
-- Never accept observations of a nonexistent invoice, wrong owner, or forged
-- calculated snapshot. The invoice must be real at INSERT time.
CREATE TRIGGER card_invoice_observation_guard BEFORE INSERT ON card_invoice_bank_observations
BEGIN
 SELECT RAISE(ABORT,'CARD_RECONCILIATION_INVALID_INVOICE')
 WHERE NOT EXISTS (
  SELECT 1 FROM credit_invoice_balances v
  WHERE v.owner_user_id=NEW.owner_user_id AND v.card_id=NEW.card_id
   AND v.invoice_cycle=NEW.invoice_cycle
   AND v.total_cents=NEW.calculated_total_at_entry_cents
 );
END;
CREATE TRIGGER card_invoice_observation_no_update BEFORE UPDATE ON card_invoice_bank_observations BEGIN
 SELECT RAISE(ABORT,'CARD_RECONCILIATION_IMMUTABLE');
END;
CREATE TRIGGER card_invoice_observation_no_delete BEFORE DELETE ON card_invoice_bank_observations BEGIN
 SELECT RAISE(ABORT,'CARD_RECONCILIATION_IMMUTABLE');
END;
