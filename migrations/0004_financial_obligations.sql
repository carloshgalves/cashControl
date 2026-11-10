-- SPEC-002 / DEC-002: obligations are commitments, NOT posted bank outflows.
-- Posted payments, and only posted payments, affect financial_account_balances.
CREATE TABLE financial_obligations (
  owner_user_id TEXT NOT NULL CHECK (length(owner_user_id) BETWEEN 1 AND 128),
  obligation_id TEXT NOT NULL,
  creation_key TEXT NOT NULL,
  title TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 120),
  category TEXT CHECK (category IS NULL OR length(trim(category)) BETWEEN 1 AND 80),
  total_cents INTEGER NOT NULL CHECK (total_cents BETWEEN 1 AND 9000000000000),
  due_on TEXT NOT NULL CHECK (
    length(due_on) = 10 AND due_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
  ),
  created_at TEXT NOT NULL,
  PRIMARY KEY (owner_user_id, obligation_id),
  UNIQUE (owner_user_id, creation_key)
);
CREATE INDEX obligations_due_idx
  ON financial_obligations(owner_user_id, due_on, obligation_id);

-- A payment has exactly one corresponding cash expense in posted_cash_movements.
-- The service inserts both rows in one D1 batch: either both commit or neither does.
CREATE TABLE financial_obligation_payments (
  owner_user_id TEXT NOT NULL,
  payment_id TEXT NOT NULL,
  creation_key TEXT NOT NULL,
  obligation_id TEXT NOT NULL,
  movement_id TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents BETWEEN 1 AND 9000000000000),
  created_at TEXT NOT NULL,
  PRIMARY KEY (owner_user_id, payment_id),
  UNIQUE (owner_user_id, creation_key),
  UNIQUE (owner_user_id, movement_id),
  FOREIGN KEY (owner_user_id, obligation_id)
    REFERENCES financial_obligations(owner_user_id, obligation_id) ON DELETE RESTRICT,
  FOREIGN KEY (owner_user_id, movement_id)
    REFERENCES posted_cash_movements(owner_user_id, movement_id) ON DELETE RESTRICT
);
CREATE INDEX obligation_payments_due_idx
  ON financial_obligation_payments(owner_user_id, obligation_id, created_at, payment_id);

-- Financial obligation state is derived, never separately changed on one path.
-- A due bill can be OPEN, PARTIALLY_PAID, or PAID; no money moves until a payment.
CREATE VIEW financial_obligation_balances AS
SELECT o.owner_user_id, o.obligation_id, o.creation_key, o.title, o.category,
       o.total_cents, o.due_on, o.created_at,
       COALESCE((SELECT SUM(p.amount_cents)
         FROM financial_obligation_payments p
         WHERE p.owner_user_id = o.owner_user_id AND p.obligation_id = o.obligation_id), 0) AS paid_cents,
       o.total_cents - COALESCE((SELECT SUM(p.amount_cents)
         FROM financial_obligation_payments p
         WHERE p.owner_user_id = o.owner_user_id AND p.obligation_id = o.obligation_id), 0) AS outstanding_cents
FROM financial_obligations o;
