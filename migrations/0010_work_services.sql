-- E1: work is optional classification of existing cash movements, never a second ledger.
CREATE TABLE work_services (
 owner_user_id TEXT NOT NULL CHECK(length(owner_user_id) BETWEEN 1 AND 128),
 work_id TEXT NOT NULL, creation_key TEXT NOT NULL,
 title TEXT NOT NULL CHECK(length(trim(title)) BETWEEN 1 AND 120),
 client_label TEXT CHECK(client_label IS NULL OR length(trim(client_label)) BETWEEN 1 AND 120),
 expected_cents INTEGER CHECK(expected_cents IS NULL OR (typeof(expected_cents)='integer' AND expected_cents BETWEEN 0 AND 9000000000000)),
 planned_on TEXT, due_on TEXT, category TEXT, notes TEXT, created_at TEXT NOT NULL,
 PRIMARY KEY(owner_user_id,work_id), UNIQUE(owner_user_id,creation_key)
);
CREATE TABLE work_state_events (
 seq INTEGER PRIMARY KEY AUTOINCREMENT,
 owner_user_id TEXT NOT NULL, work_id TEXT NOT NULL, creation_key TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('planned','confirmed','realized','canceled')),
 reason TEXT CHECK(reason IS NULL OR length(trim(reason)) BETWEEN 1 AND 120),
 created_at TEXT NOT NULL,
 UNIQUE(owner_user_id,creation_key),
 FOREIGN KEY(owner_user_id,work_id) REFERENCES work_services(owner_user_id,work_id)
);
CREATE INDEX work_state_latest ON work_state_events(owner_user_id,work_id,seq DESC);
CREATE TRIGGER work_state_guard BEFORE INSERT ON work_state_events BEGIN
 SELECT RAISE(ABORT,'WORK_STATE_INVALID') WHERE
 NOT EXISTS(SELECT 1 FROM work_services w WHERE w.owner_user_id=NEW.owner_user_id AND w.work_id=NEW.work_id)
 OR NOT (
  (COALESCE((SELECT state FROM work_state_events s WHERE s.owner_user_id=NEW.owner_user_id AND s.work_id=NEW.work_id ORDER BY seq DESC LIMIT 1),'none')='none' AND NEW.state='planned')
  OR (COALESCE((SELECT state FROM work_state_events s WHERE s.owner_user_id=NEW.owner_user_id AND s.work_id=NEW.work_id ORDER BY seq DESC LIMIT 1),'none')='planned' AND NEW.state IN ('confirmed','realized','canceled'))
  OR (COALESCE((SELECT state FROM work_state_events s WHERE s.owner_user_id=NEW.owner_user_id AND s.work_id=NEW.work_id ORDER BY seq DESC LIMIT 1),'none')='confirmed' AND NEW.state IN ('realized','canceled'))
  OR (COALESCE((SELECT state FROM work_state_events s WHERE s.owner_user_id=NEW.owner_user_id AND s.work_id=NEW.work_id ORDER BY seq DESC LIMIT 1),'none')='realized' AND NEW.state='canceled')
 );
END;
CREATE TABLE work_movement_links (
 owner_user_id TEXT NOT NULL, work_id TEXT NOT NULL, movement_id TEXT NOT NULL,
 creation_key TEXT NOT NULL, created_at TEXT NOT NULL,
 PRIMARY KEY(owner_user_id,movement_id), UNIQUE(owner_user_id,creation_key),
 FOREIGN KEY(owner_user_id,work_id) REFERENCES work_services(owner_user_id,work_id),
 FOREIGN KEY(owner_user_id,movement_id) REFERENCES posted_cash_movements(owner_user_id,movement_id)
);
CREATE INDEX work_links_by_work ON work_movement_links(owner_user_id,work_id,movement_id);
CREATE TRIGGER work_link_guard BEFORE INSERT ON work_movement_links BEGIN
 SELECT RAISE(ABORT,'WORK_LINK_INVALID') WHERE NOT EXISTS(
  SELECT 1 FROM posted_cash_movements m WHERE m.owner_user_id=NEW.owner_user_id AND m.movement_id=NEW.movement_id
 ) OR EXISTS(SELECT 1 FROM cash_refunds r WHERE r.owner_user_id=NEW.owner_user_id AND r.refund_movement_id=NEW.movement_id)
 OR EXISTS(SELECT 1 FROM card_invoice_payments p WHERE p.owner_user_id=NEW.owner_user_id AND p.movement_id=NEW.movement_id);
END;
-- Prevent reverse-order insertion of a card settlement or refund credit as a linked cost/receipt.
CREATE TRIGGER work_link_no_card_payment BEFORE INSERT ON card_invoice_payments
WHEN EXISTS(SELECT 1 FROM work_movement_links l WHERE l.owner_user_id=NEW.owner_user_id AND l.movement_id=NEW.movement_id)
BEGIN SELECT RAISE(ABORT,'WORK_LINK_CARD_PAYMENT'); END;
CREATE TRIGGER work_link_no_refund_credit BEFORE INSERT ON cash_refunds
WHEN EXISTS(SELECT 1 FROM work_movement_links l WHERE l.owner_user_id=NEW.owner_user_id AND l.movement_id=NEW.refund_movement_id)
BEGIN SELECT RAISE(ABORT,'WORK_LINK_REFUND_CREDIT'); END;
CREATE VIEW work_service_totals AS
SELECT w.*,
 (SELECT state FROM work_state_events s WHERE s.owner_user_id=w.owner_user_id AND s.work_id=w.work_id ORDER BY seq DESC LIMIT 1) AS state,
 COALESCE((SELECT SUM(m.amount_cents) FROM work_movement_links l JOIN posted_cash_movements m ON m.owner_user_id=l.owner_user_id AND m.movement_id=l.movement_id WHERE l.owner_user_id=w.owner_user_id AND l.work_id=w.work_id AND m.direction='income'),0) AS received_cents,
 COALESCE((SELECT SUM(m.amount_cents-COALESCE((SELECT SUM(r.amount_cents) FROM cash_refunds r WHERE r.owner_user_id=m.owner_user_id AND r.original_movement_id=m.movement_id),0)) FROM work_movement_links l JOIN posted_cash_movements m ON m.owner_user_id=l.owner_user_id AND m.movement_id=l.movement_id WHERE l.owner_user_id=w.owner_user_id AND l.work_id=w.work_id AND m.direction='expense'),0) AS cost_cents
FROM work_services w;
CREATE TRIGGER work_services_no_update BEFORE UPDATE ON work_services BEGIN SELECT RAISE(ABORT,'WORK_HISTORY_IMMUTABLE'); END;
CREATE TRIGGER work_services_no_delete BEFORE DELETE ON work_services BEGIN SELECT RAISE(ABORT,'WORK_HISTORY_IMMUTABLE'); END;
CREATE TRIGGER work_state_events_no_update BEFORE UPDATE ON work_state_events BEGIN SELECT RAISE(ABORT,'WORK_HISTORY_IMMUTABLE'); END;
CREATE TRIGGER work_state_events_no_delete BEFORE DELETE ON work_state_events BEGIN SELECT RAISE(ABORT,'WORK_HISTORY_IMMUTABLE'); END;
CREATE TRIGGER work_movement_links_no_update BEFORE UPDATE ON work_movement_links BEGIN SELECT RAISE(ABORT,'WORK_HISTORY_IMMUTABLE'); END;
CREATE TRIGGER work_movement_links_no_delete BEFORE DELETE ON work_movement_links BEGIN SELECT RAISE(ABORT,'WORK_HISTORY_IMMUTABLE'); END;
