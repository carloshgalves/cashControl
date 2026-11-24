-- SPEC-007 / G1: private loans granted to third parties and return of principal.
-- They are asset exchanges, not earned income nor consumer expenditure.
-- The cash effect is derived in the same canonical account-balance view.
CREATE TABLE personal_loans (
 owner_user_id TEXT NOT NULL CHECK(length(owner_user_id) BETWEEN 1 AND 128),
 loan_id TEXT NOT NULL,
 creation_key TEXT NOT NULL,
 borrower TEXT NOT NULL CHECK(length(trim(borrower)) BETWEEN 1 AND 120),
 title TEXT NOT NULL CHECK(length(trim(title)) BETWEEN 1 AND 120),
 source_account_id TEXT NOT NULL,
 principal_cents INTEGER NOT NULL CHECK(typeof(principal_cents)='integer' AND principal_cents BETWEEN 1 AND 9000000000000),
 lent_on TEXT NOT NULL CHECK(length(lent_on)=10 AND date(lent_on,'+0 days')=lent_on AND substr(lent_on,1,4)>='1000'),
 due_on TEXT NOT NULL CHECK(length(due_on)=10 AND date(due_on,'+0 days')=due_on AND substr(due_on,1,4)>='1000' AND due_on>=lent_on),
 created_at TEXT NOT NULL,
 PRIMARY KEY(owner_user_id,loan_id),
 UNIQUE(owner_user_id,creation_key),
 FOREIGN KEY(owner_user_id,source_account_id) REFERENCES financial_accounts(owner_user_id,account_id) ON DELETE RESTRICT
);
CREATE INDEX personal_loans_due_idx ON personal_loans(owner_user_id,due_on,loan_id);

CREATE TABLE personal_loan_repayments (
 owner_user_id TEXT NOT NULL,
 repayment_id TEXT NOT NULL,
 creation_key TEXT NOT NULL,
 loan_id TEXT NOT NULL,
 destination_account_id TEXT NOT NULL,
 amount_cents INTEGER NOT NULL CHECK(typeof(amount_cents)='integer' AND amount_cents BETWEEN 1 AND 9000000000000),
 received_on TEXT NOT NULL CHECK(length(received_on)=10 AND date(received_on,'+0 days')=received_on AND substr(received_on,1,4)>='1000'),
 created_at TEXT NOT NULL,
 PRIMARY KEY(owner_user_id,repayment_id),
 UNIQUE(owner_user_id,creation_key),
 FOREIGN KEY(owner_user_id,loan_id) REFERENCES personal_loans(owner_user_id,loan_id) ON DELETE RESTRICT,
 FOREIGN KEY(owner_user_id,destination_account_id) REFERENCES financial_accounts(owner_user_id,account_id) ON DELETE RESTRICT
);
CREATE INDEX loan_repayments_by_loan ON personal_loan_repayments(owner_user_id,loan_id,received_on,repayment_id);

-- Defense against INSERT OR REPLACE silently deleting the old financial event.
CREATE TRIGGER loan_unique_guard BEFORE INSERT ON personal_loans BEGIN
 SELECT RAISE(ABORT,'LOAN_IMMUTABLE') WHERE EXISTS(
  SELECT 1 FROM personal_loans l WHERE l.owner_user_id=NEW.owner_user_id
  AND (l.loan_id=NEW.loan_id OR l.creation_key=NEW.creation_key)
 );
END;
CREATE TRIGGER loan_repayment_unique_guard BEFORE INSERT ON personal_loan_repayments BEGIN
 SELECT RAISE(ABORT,'LOAN_REPAYMENT_IMMUTABLE') WHERE EXISTS(
  SELECT 1 FROM personal_loan_repayments r WHERE r.owner_user_id=NEW.owner_user_id
  AND (r.repayment_id=NEW.repayment_id OR r.creation_key=NEW.creation_key)
 );
 SELECT RAISE(ABORT,'LOAN_OVERPAYMENT') WHERE NOT EXISTS(
  SELECT 1 FROM personal_loans l WHERE l.owner_user_id=NEW.owner_user_id AND l.loan_id=NEW.loan_id
   AND NEW.received_on>=l.lent_on
   AND NEW.amount_cents<=l.principal_cents-COALESCE((
    SELECT SUM(p.amount_cents) FROM personal_loan_repayments p
    WHERE p.owner_user_id=l.owner_user_id AND p.loan_id=l.loan_id
   ),0)
 );
END;
CREATE TRIGGER loan_no_update BEFORE UPDATE ON personal_loans BEGIN SELECT RAISE(ABORT,'LOAN_IMMUTABLE'); END;
CREATE TRIGGER loan_no_delete BEFORE DELETE ON personal_loans BEGIN SELECT RAISE(ABORT,'LOAN_IMMUTABLE'); END;
CREATE TRIGGER loan_repayment_no_update BEFORE UPDATE ON personal_loan_repayments BEGIN SELECT RAISE(ABORT,'LOAN_REPAYMENT_IMMUTABLE'); END;
CREATE TRIGGER loan_repayment_no_delete BEFORE DELETE ON personal_loan_repayments BEGIN SELECT RAISE(ABORT,'LOAN_REPAYMENT_IMMUTABLE'); END;

-- Recreate canonical balance with loan asset transfers included, without posting
-- phantom salary or expenses in posted_cash_movements.
DROP VIEW financial_account_balances;
CREATE VIEW financial_account_balances AS
SELECT a.owner_user_id,a.account_id,a.display_name,a.kind,a.currency,a.created_at,
 a.opening_cents
 + COALESCE((SELECT SUM(CASE WHEN i.target_account_id=a.account_id THEN i.amount_cents ELSE -i.amount_cents END)
   FROM initial_allocations i WHERE i.owner_user_id=a.owner_user_id
    AND (i.source_account_id=a.account_id OR i.target_account_id=a.account_id)),0)
 + COALESCE((SELECT SUM(CASE WHEN m.direction='income' THEN m.amount_cents ELSE -m.amount_cents END)
   FROM posted_cash_movements m WHERE m.owner_user_id=a.owner_user_id AND m.account_id=a.account_id),0)
 + COALESCE((SELECT SUM(CASE WHEN t.target_account_id=a.account_id THEN t.amount_cents ELSE -t.amount_cents END)
   FROM internal_transfers t WHERE t.owner_user_id=a.owner_user_id
    AND (t.source_account_id=a.account_id OR t.target_account_id=a.account_id)),0)
 - COALESCE((SELECT SUM(l.principal_cents) FROM personal_loans l
   WHERE l.owner_user_id=a.owner_user_id AND l.source_account_id=a.account_id),0)
 + COALESCE((SELECT SUM(r.amount_cents) FROM personal_loan_repayments r
   WHERE r.owner_user_id=a.owner_user_id AND r.destination_account_id=a.account_id),0)
 AS balance_cents
FROM financial_accounts a;

-- Outgoing credit is a real transfer of cash to a borrower. As with internal
-- transfers, refuse insufficient funds in the originating account.
CREATE TRIGGER loan_available_cash BEFORE INSERT ON personal_loans BEGIN
 SELECT RAISE(ABORT,'SOURCE_BALANCE_INSUFFICIENT') WHERE NOT EXISTS(
  SELECT 1 FROM financial_account_balances b
  WHERE b.owner_user_id=NEW.owner_user_id AND b.account_id=NEW.source_account_id
    AND b.balance_cents>=NEW.principal_cents
 );
END;

CREATE VIEW personal_loan_balances AS
SELECT l.*, COALESCE((SELECT SUM(r.amount_cents) FROM personal_loan_repayments r
  WHERE r.owner_user_id=l.owner_user_id AND r.loan_id=l.loan_id),0) AS repaid_cents,
 l.principal_cents-COALESCE((SELECT SUM(r.amount_cents) FROM personal_loan_repayments r
  WHERE r.owner_user_id=l.owner_user_id AND r.loan_id=l.loan_id),0) AS outstanding_cents
FROM personal_loans l;
