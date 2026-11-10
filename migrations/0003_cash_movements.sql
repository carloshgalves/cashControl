-- Confirmed external receipts and expenditures, not obligations, transfers or forecasts.
CREATE TABLE posted_cash_movements (
  owner_user_id TEXT NOT NULL CHECK (length(owner_user_id) BETWEEN 1 AND 128),
  movement_id TEXT NOT NULL,
  creation_key TEXT NOT NULL,
  account_id TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('income', 'expense')),
  amount_cents INTEGER NOT NULL CHECK (amount_cents BETWEEN 1 AND 9000000000000),
  payment_method TEXT NOT NULL CHECK (payment_method IN ('cash', 'pix', 'debit', 'bank_transfer')),
  description TEXT NOT NULL CHECK (length(trim(description)) BETWEEN 1 AND 120),
  source_label TEXT CHECK (source_label IS NULL OR length(trim(source_label)) BETWEEN 1 AND 120),
  category TEXT CHECK (category IS NULL OR length(trim(category)) BETWEEN 1 AND 80),
  occurred_on TEXT NOT NULL CHECK (length(occurred_on) = 10 AND occurred_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  created_at TEXT NOT NULL,
  PRIMARY KEY (owner_user_id, movement_id),
  UNIQUE (owner_user_id, creation_key),
  FOREIGN KEY (owner_user_id, account_id)
    REFERENCES financial_accounts (owner_user_id, account_id) ON DELETE RESTRICT
);
CREATE INDEX movement_timeline_idx
  ON posted_cash_movements(owner_user_id, occurred_on DESC, created_at DESC, movement_id DESC);
CREATE INDEX movement_account_timeline_idx
  ON posted_cash_movements(owner_user_id, account_id, occurred_on DESC, created_at DESC, movement_id DESC);

-- Canonical balance combines opening funds, reallocation and confirmed cashflow.
CREATE VIEW financial_account_balances AS
SELECT a.owner_user_id, a.account_id, a.display_name, a.kind, a.currency, a.created_at,
  a.opening_cents
  + COALESCE((
    SELECT SUM(CASE WHEN t.target_account_id = a.account_id
       THEN t.amount_cents ELSE -t.amount_cents END)
    FROM initial_allocations t
    WHERE t.owner_user_id = a.owner_user_id
      AND (t.source_account_id = a.account_id OR t.target_account_id = a.account_id)
  ), 0)
  + COALESCE((
    SELECT SUM(CASE WHEN m.direction = 'income'
       THEN m.amount_cents ELSE -m.amount_cents END)
    FROM posted_cash_movements m
    WHERE m.owner_user_id = a.owner_user_id AND m.account_id = a.account_id
  ), 0) AS balance_cents
FROM financial_accounts a;
