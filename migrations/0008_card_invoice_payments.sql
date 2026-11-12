-- D2 / SPEC-004: atomic settlement of an invoice's remaining credit debt.
-- The economic purchase is recorded only in credit_purchases/installments.
-- Payment is a single confirmed *cash* outflow, not a second consumption.
CREATE TABLE card_invoice_payments (
 owner_user_id TEXT NOT NULL CHECK(length(owner_user_id) BETWEEN 1 AND 128),
 payment_id TEXT NOT NULL,
 creation_key TEXT NOT NULL,
 card_id TEXT NOT NULL,
 invoice_cycle TEXT NOT NULL CHECK(
  length(invoice_cycle)=7 AND invoice_cycle GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'
 ),
 movement_id TEXT NOT NULL,
 account_id TEXT NOT NULL,
 amount_cents INTEGER NOT NULL CHECK(amount_cents BETWEEN 1 AND 9000000000000),
 method TEXT NOT NULL CHECK(method IN ('cash','pix','debit','bank_transfer')),
 paid_on TEXT NOT NULL CHECK(
  length(paid_on)=10 AND paid_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
 ),
 created_at TEXT NOT NULL,
 PRIMARY KEY (owner_user_id,payment_id),
 UNIQUE (owner_user_id,creation_key),
 UNIQUE (owner_user_id,movement_id),
 FOREIGN KEY (owner_user_id,card_id) REFERENCES credit_cards(owner_user_id,card_id) ON DELETE RESTRICT,
 FOREIGN KEY (owner_user_id,account_id) REFERENCES financial_accounts(owner_user_id,account_id) ON DELETE RESTRICT,
 FOREIGN KEY (owner_user_id,movement_id) REFERENCES posted_cash_movements(owner_user_id,movement_id) ON DELETE RESTRICT
);
CREATE INDEX card_invoice_payments_cycle_idx
 ON card_invoice_payments(owner_user_id,card_id,invoice_cycle,paid_on,created_at,payment_id);

-- Sum installments once; payments are aggregated independently to prevent
-- fan-out and double counting for invoices with multiple purchases/payments.
CREATE VIEW credit_invoice_balances AS
SELECT i.owner_user_id,i.card_id,i.invoice_cycle,
 MIN(i.due_on) AS due_on,MAX(i.due_on) AS max_due,
 COUNT(*) AS installment_count,COUNT(DISTINCT i.purchase_id) AS purchase_count,
 SUM(i.amount_cents) AS total_cents,
 COALESCE((
  SELECT SUM(p.amount_cents) FROM card_invoice_payments p
  WHERE p.owner_user_id=i.owner_user_id AND p.card_id=i.card_id AND p.invoice_cycle=i.invoice_cycle
 ),0) AS paid_cents,
 SUM(i.amount_cents)-COALESCE((
  SELECT SUM(p.amount_cents) FROM card_invoice_payments p
  WHERE p.owner_user_id=i.owner_user_id AND p.card_id=i.card_id AND p.invoice_cycle=i.invoice_cycle
 ),0) AS outstanding_cents
FROM credit_installments i
GROUP BY i.owner_user_id,i.card_id,i.invoice_cycle;

-- A payment must be backed by exactly one cash debit, for the same owner,
-- amount, account, method and payment date. SQLite serializes writers and
-- this trigger checks the LIVE outstanding in the same atomic transaction.
CREATE TRIGGER card_invoice_payment_guard BEFORE INSERT ON card_invoice_payments
BEGIN
 SELECT RAISE(ABORT,'CARD_INVOICE_PAYMENT_MISMATCH')
 WHERE NOT EXISTS (
  SELECT 1 FROM posted_cash_movements m
  WHERE m.owner_user_id=NEW.owner_user_id AND m.movement_id=NEW.movement_id
   AND m.direction='expense' AND m.amount_cents=NEW.amount_cents
   AND m.account_id=NEW.account_id AND m.payment_method=NEW.method
   AND m.occurred_on=NEW.paid_on
 );
 SELECT RAISE(ABORT,'CARD_INVOICE_OVERPAID_OR_MISSING')
 WHERE NEW.amount_cents > COALESCE((
  SELECT outstanding_cents FROM credit_invoice_balances v
  WHERE v.owner_user_id=NEW.owner_user_id AND v.card_id=NEW.card_id
    AND v.invoice_cycle=NEW.invoice_cycle
 ),0);
END;

-- Disallow historical mutation and un-linking of the financial debit.
CREATE TRIGGER card_invoice_payment_no_update BEFORE UPDATE ON card_invoice_payments BEGIN
 SELECT RAISE(ABORT,'CARD_PAYMENT_IMMUTABLE');
END;
CREATE TRIGGER card_invoice_payment_no_delete BEFORE DELETE ON card_invoice_payments BEGIN
 SELECT RAISE(ABORT,'CARD_PAYMENT_IMMUTABLE');
END;
CREATE TRIGGER card_payment_movement_no_update BEFORE UPDATE ON posted_cash_movements
WHEN EXISTS (
 SELECT 1 FROM card_invoice_payments p WHERE p.owner_user_id=OLD.owner_user_id AND p.movement_id=OLD.movement_id
) BEGIN SELECT RAISE(ABORT,'CARD_PAYMENT_MOVEMENT_IMMUTABLE'); END;
CREATE TRIGGER card_payment_movement_no_delete BEFORE DELETE ON posted_cash_movements
WHEN EXISTS (
 SELECT 1 FROM card_invoice_payments p WHERE p.owner_user_id=OLD.owner_user_id AND p.movement_id=OLD.movement_id
) BEGIN SELECT RAISE(ABORT,'CARD_PAYMENT_MOVEMENT_IMMUTABLE'); END;

-- An invoice debit may not also settle an unrelated ordinary obligation:
-- otherwise one bank outflow would count as two extinguished debts.
CREATE TRIGGER card_payment_not_obligation BEFORE INSERT ON financial_obligation_payments
WHEN EXISTS (
 SELECT 1 FROM card_invoice_payments p
 WHERE p.owner_user_id=NEW.owner_user_id AND p.movement_id=NEW.movement_id
) BEGIN SELECT RAISE(ABORT,'CARD_PAYMENT_CANNOT_SETTLE_OTHER_DEBT'); END;
-- Until chargeback/reversal semantics for invoice payments are specified,
-- generic cash-refund cannot credit the account without reopening the debt.
CREATE TRIGGER card_payment_no_generic_refund BEFORE INSERT ON cash_refunds
WHEN EXISTS (
 SELECT 1 FROM card_invoice_payments p
 WHERE p.owner_user_id=NEW.owner_user_id AND p.movement_id=NEW.original_movement_id
) BEGIN SELECT RAISE(ABORT,'CARD_PAYMENT_REQUIRES_SPECIAL_REVERSAL'); END;
