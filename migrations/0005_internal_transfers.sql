-- DEC-001 / SPEC-002 / B4: an internal transfer is one paired movement,
-- not an income/expense. Both resources belong to the same authenticated owner.
CREATE TABLE internal_transfers (
  owner_user_id TEXT NOT NULL CHECK (length(owner_user_id) BETWEEN 1 AND 128),
  transfer_id TEXT NOT NULL,
  creation_key TEXT NOT NULL,
  source_account_id TEXT NOT NULL,
  target_account_id TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents BETWEEN 1 AND 9000000000000),
  transferred_on TEXT NOT NULL CHECK (
    length(transferred_on) = 10 AND
    transferred_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
  ),
  note TEXT CHECK (note IS NULL OR length(trim(note)) BETWEEN 1 AND 120),
  created_at TEXT NOT NULL,
  PRIMARY KEY (owner_user_id, transfer_id),
  UNIQUE (owner_user_id, creation_key),
  FOREIGN KEY (owner_user_id, source_account_id)
    REFERENCES financial_accounts(owner_user_id, account_id) ON DELETE RESTRICT,
  FOREIGN KEY (owner_user_id, target_account_id)
    REFERENCES financial_accounts(owner_user_id, account_id) ON DELETE RESTRICT,
  CHECK (source_account_id <> target_account_id)
);
CREATE INDEX internal_transfers_source_idx
  ON internal_transfers(owner_user_id, source_account_id, transferred_on DESC, created_at DESC);
CREATE INDEX internal_transfers_target_idx
  ON internal_transfers(owner_user_id, target_account_id, transferred_on DESC, created_at DESC);
CREATE INDEX internal_transfers_timeline_idx
  ON internal_transfers(owner_user_id, transferred_on DESC, created_at DESC, transfer_id DESC);

-- Replace the canonical balance view rather than maintaining two mutable
-- balances that might drift. Every transfer subtracts and adds equal centavos.
DROP VIEW financial_account_balances;
CREATE VIEW financial_account_balances AS
SELECT a.owner_user_id, a.account_id, a.display_name, a.kind, a.currency, a.created_at,
  a.opening_cents
  + COALESCE((
    SELECT SUM(CASE WHEN i.target_account_id = a.account_id
       THEN i.amount_cents ELSE -i.amount_cents END)
    FROM initial_allocations i
    WHERE i.owner_user_id = a.owner_user_id
      AND (i.source_account_id = a.account_id OR i.target_account_id = a.account_id)
  ), 0)
  + COALESCE((
    SELECT SUM(CASE WHEN m.direction = 'income'
       THEN m.amount_cents ELSE -m.amount_cents END)
    FROM posted_cash_movements m
    WHERE m.owner_user_id = a.owner_user_id AND m.account_id = a.account_id
  ), 0)
  + COALESCE((
    SELECT SUM(CASE WHEN t.target_account_id = a.account_id
       THEN t.amount_cents ELSE -t.amount_cents END)
    FROM internal_transfers t
    WHERE t.owner_user_id = a.owner_user_id
      AND (t.source_account_id = a.account_id OR t.target_account_id = a.account_id)
  ), 0) AS balance_cents
FROM financial_accounts a;

-- Single INSERT is atomic: if the source is missing, foreign, or has less
-- recorded cash than requested, it fails before changing any balance.
-- SQLite serializes writers, so two concurrent transfers cannot both consume
-- the same pre-transfer balance. Outgoing transfers require nonnegative funds.
CREATE TRIGGER internal_transfer_available_funds
BEFORE INSERT ON internal_transfers
BEGIN
  SELECT RAISE(ABORT, 'SOURCE_BALANCE_INSUFFICIENT')
  WHERE NOT EXISTS (
    SELECT 1 FROM financial_account_balances b
    WHERE b.owner_user_id = NEW.owner_user_id
      AND b.account_id = NEW.source_account_id
      AND b.balance_cents >= NEW.amount_cents
  );
END;

-- Historical cash operations are append-only. Corrections require a separately
-- recorded compensating operation rather than silently rewriting past balances.
CREATE TRIGGER internal_transfer_no_update
BEFORE UPDATE ON internal_transfers
BEGIN
  SELECT RAISE(ABORT, 'TRANSFER_IMMUTABLE');
END;
CREATE TRIGGER internal_transfer_no_delete
BEFORE DELETE ON internal_transfers
BEGIN
  SELECT RAISE(ABORT, 'TRANSFER_IMMUTABLE');
END;
