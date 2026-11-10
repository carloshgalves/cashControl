-- DEC-002 / B5: cancellations and reimbursements are append-only events.
-- A cancellation has no cash movement. A refund is a confirmed cash credit
-- linked to the original paid expense, NOT an earned income.
CREATE TABLE obligation_cancellations (
  owner_user_id TEXT NOT NULL,
  cancellation_id TEXT NOT NULL,
  creation_key TEXT NOT NULL,
  obligation_id TEXT NOT NULL,
  canceled_on TEXT NOT NULL CHECK (
    length(canceled_on) = 10 AND canceled_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
  ),
  reason TEXT CHECK (reason IS NULL OR length(trim(reason)) BETWEEN 1 AND 120),
  created_at TEXT NOT NULL,
  PRIMARY KEY (owner_user_id, cancellation_id),
  UNIQUE (owner_user_id, obligation_id),
  UNIQUE (owner_user_id, creation_key),
  FOREIGN KEY (owner_user_id, obligation_id)
    REFERENCES financial_obligations(owner_user_id, obligation_id) ON DELETE RESTRICT
);

CREATE TABLE cash_refunds (
  owner_user_id TEXT NOT NULL,
  refund_id TEXT NOT NULL,
  creation_key TEXT NOT NULL,
  original_movement_id TEXT NOT NULL,
  refund_movement_id TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents BETWEEN 1 AND 9000000000000),
  refunded_on TEXT NOT NULL CHECK (
    length(refunded_on) = 10 AND refunded_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
  ),
  reason TEXT CHECK (reason IS NULL OR length(trim(reason)) BETWEEN 1 AND 120),
  created_at TEXT NOT NULL,
  PRIMARY KEY (owner_user_id, refund_id),
  UNIQUE (owner_user_id, creation_key),
  UNIQUE (owner_user_id, refund_movement_id),
  FOREIGN KEY (owner_user_id, original_movement_id)
    REFERENCES posted_cash_movements(owner_user_id, movement_id) ON DELETE RESTRICT,
  FOREIGN KEY (owner_user_id, refund_movement_id)
    REFERENCES posted_cash_movements(owner_user_id, movement_id) ON DELETE RESTRICT,
  CHECK (original_movement_id <> refund_movement_id)
);
CREATE INDEX cash_refunds_original_idx
  ON cash_refunds(owner_user_id, original_movement_id, refunded_on DESC, created_at DESC);
CREATE INDEX cash_refunds_timeline_idx
  ON cash_refunds(owner_user_id, refunded_on DESC, created_at DESC, refund_id DESC);

-- Cancel ONLY an unpaid obligation. Partial/paid cancellations require a
-- separate product decision; refunds of real payments remain supported.
CREATE TRIGGER no_cancel_after_payment
BEFORE INSERT ON obligation_cancellations
BEGIN
  SELECT RAISE(ABORT, 'OBLIGATION_HAS_PAYMENTS')
  WHERE EXISTS (
    SELECT 1 FROM financial_obligation_payments p
    WHERE p.owner_user_id = NEW.owner_user_id AND p.obligation_id = NEW.obligation_id
  );
END;

-- Each credit must be a confirmed refund of a real expense by the same owner,
-- including the same exact amount/date and a non-reusable creation key.
CREATE TRIGGER cash_refund_invariants
BEFORE INSERT ON cash_refunds
BEGIN
  SELECT RAISE(ABORT, 'REFUND_MOVEMENT_MISMATCH')
  WHERE NOT EXISTS (
    SELECT 1 FROM posted_cash_movements original
    JOIN posted_cash_movements returned
      ON returned.owner_user_id = original.owner_user_id
    WHERE original.owner_user_id = NEW.owner_user_id
      AND original.movement_id = NEW.original_movement_id
      AND original.direction = 'expense'
      AND returned.movement_id = NEW.refund_movement_id
      AND returned.direction = 'income'
      AND returned.amount_cents = NEW.amount_cents
      AND returned.occurred_on = NEW.refunded_on
      AND returned.occurred_on >= original.occurred_on
      AND returned.creation_key = 'cash-refund:' || NEW.creation_key
  );
  SELECT RAISE(ABORT, 'REFUND_EXCEEDS_ORIGINAL')
  WHERE NEW.amount_cents > (
    SELECT original.amount_cents - COALESCE((
      SELECT SUM(r.amount_cents) FROM cash_refunds r
      WHERE r.owner_user_id = NEW.owner_user_id
        AND r.original_movement_id = NEW.original_movement_id
    ),0)
    FROM posted_cash_movements original
    WHERE original.owner_user_id = NEW.owner_user_id
      AND original.movement_id = NEW.original_movement_id
  );
END;

-- Read models derive the net-paid amount, never overwrite historical payments.
DROP VIEW financial_obligation_balances;
CREATE VIEW financial_obligation_balances AS
WITH paid_net AS (
  SELECT p.owner_user_id, p.obligation_id,
    SUM(p.amount_cents - COALESCE((
      SELECT SUM(r.amount_cents) FROM cash_refunds r
      WHERE r.owner_user_id = p.owner_user_id
        AND r.original_movement_id = p.movement_id
    ), 0)) AS net_cents
  FROM financial_obligation_payments p
  GROUP BY p.owner_user_id, p.obligation_id
)
SELECT o.owner_user_id, o.obligation_id, o.creation_key, o.title, o.category,
       o.total_cents, o.due_on, o.created_at,
       COALESCE(p.net_cents, 0) AS paid_cents,
       CASE WHEN c.cancellation_id IS NOT NULL THEN 0
            ELSE o.total_cents - COALESCE(p.net_cents, 0) END AS outstanding_cents,
       c.cancellation_id, c.canceled_on, c.reason AS cancellation_reason,
       c.created_at AS canceled_at
FROM financial_obligations o
LEFT JOIN paid_net p ON p.owner_user_id = o.owner_user_id
  AND p.obligation_id = o.obligation_id
LEFT JOIN obligation_cancellations c ON c.owner_user_id = o.owner_user_id
  AND c.obligation_id = o.obligation_id;

-- Reinstall the original payment integrity trigger using the new NET balance.
DROP TRIGGER obligation_payment_invariants;
CREATE TRIGGER obligation_payment_invariants
BEFORE INSERT ON financial_obligation_payments
BEGIN
  SELECT RAISE(ABORT, 'PAYMENT_MOVEMENT_MISMATCH')
  WHERE NOT EXISTS (
    SELECT 1 FROM posted_cash_movements m
    WHERE m.owner_user_id = NEW.owner_user_id
      AND m.movement_id = NEW.movement_id
      AND m.direction = 'expense'
      AND m.amount_cents = NEW.amount_cents
  );
  SELECT RAISE(ABORT, 'PAYMENT_EXCEEDS_OBLIGATION')
  WHERE NOT EXISTS (
    SELECT 1 FROM financial_obligation_balances o
    WHERE o.owner_user_id = NEW.owner_user_id
      AND o.obligation_id = NEW.obligation_id
      AND o.cancellation_id IS NULL
      AND o.outstanding_cents >= NEW.amount_cents
  );
END;

-- Original transactions and audit/compensation records must never disappear or
-- be silently rewritten. Future corrections shall be new linked events.
CREATE TRIGGER no_update_cash_movements
BEFORE UPDATE ON posted_cash_movements
BEGIN
  SELECT RAISE(ABORT, 'MOVEMENT_IMMUTABLE');
END;
CREATE TRIGGER no_delete_cash_movements
BEFORE DELETE ON posted_cash_movements
BEGIN
  SELECT RAISE(ABORT, 'MOVEMENT_IMMUTABLE');
END;
CREATE TRIGGER no_update_refunds
BEFORE UPDATE ON cash_refunds
BEGIN
  SELECT RAISE(ABORT, 'REFUND_IMMUTABLE');
END;
CREATE TRIGGER no_delete_refunds
BEFORE DELETE ON cash_refunds
BEGIN
  SELECT RAISE(ABORT, 'REFUND_IMMUTABLE');
END;
CREATE TRIGGER no_update_cancellations
BEFORE UPDATE ON obligation_cancellations
BEGIN
  SELECT RAISE(ABORT, 'CANCELLATION_IMMUTABLE');
END;
CREATE TRIGGER no_delete_cancellations
BEFORE DELETE ON obligation_cancellations
BEGIN
  SELECT RAISE(ABORT, 'CANCELLATION_IMMUTABLE');
END;


-- Preserve both the original bill and its historical confirmed settlements.
-- Later renegotiations may supersede them by new linked events, not rewrites.
CREATE TRIGGER no_update_obligation_payments
BEFORE UPDATE ON financial_obligation_payments
BEGIN
  SELECT RAISE(ABORT, 'PAYMENT_IMMUTABLE');
END;
CREATE TRIGGER no_delete_obligation_payments
BEFORE DELETE ON financial_obligation_payments
BEGIN
  SELECT RAISE(ABORT, 'PAYMENT_IMMUTABLE');
END;
CREATE TRIGGER no_update_obligations
BEFORE UPDATE ON financial_obligations
BEGIN
  SELECT RAISE(ABORT, 'OBLIGATION_IMMUTABLE');
END;
CREATE TRIGGER no_delete_obligations
BEFORE DELETE ON financial_obligations
BEGIN
  SELECT RAISE(ABORT, 'OBLIGATION_IMMUTABLE');
END;
