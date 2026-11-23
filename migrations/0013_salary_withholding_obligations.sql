-- SPEC-005 E4: a confirmed salary withholding pays an obligation without
-- a posted_cash_movements entry. A payroll statement is user-entered evidence
-- but is NOT confirmation. Only a dedicated, explicit confirmation INSERT pays.
CREATE TABLE salary_withheld_obligation_payments (
 owner_user_id TEXT NOT NULL CHECK(length(owner_user_id) BETWEEN 1 AND 128),
 payment_id TEXT NOT NULL,
 creation_key TEXT NOT NULL,
 statement_seq INTEGER NOT NULL,
 discount_index INTEGER NOT NULL CHECK(typeof(discount_index)='integer' AND discount_index BETWEEN 0 AND 19),
 obligation_id TEXT NOT NULL,
 amount_cents INTEGER NOT NULL CHECK(typeof(amount_cents)='integer' AND amount_cents BETWEEN 1 AND 9000000000000),
 confirmed_on TEXT NOT NULL CHECK(length(confirmed_on)=10 AND confirmed_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND date(confirmed_on,'+0 days')=confirmed_on AND substr(confirmed_on,1,4)>='1000'),
 created_at TEXT NOT NULL,
 PRIMARY KEY(owner_user_id,payment_id),
 UNIQUE(owner_user_id,creation_key),
 FOREIGN KEY(statement_seq) REFERENCES salary_period_statements(statement_seq) ON DELETE RESTRICT,
 FOREIGN KEY(owner_user_id,obligation_id) REFERENCES financial_obligations(owner_user_id,obligation_id) ON DELETE RESTRICT
);
CREATE INDEX salary_withheld_by_statement ON salary_withheld_obligation_payments(owner_user_id,statement_seq,discount_index,payment_id);
CREATE INDEX salary_withheld_by_obligation ON salary_withheld_obligation_payments(owner_user_id,obligation_id,confirmed_on,payment_id);

-- Both limits are checked in one SQLite write under D1 transaction
-- serialization. No double settlement can pass, regardless of HTTP retries.
CREATE TRIGGER salary_withheld_guard BEFORE INSERT ON salary_withheld_obligation_payments
BEGIN
 SELECT RAISE(ABORT,'WITHHOLDING_INVALID') WHERE
  -- Prevent REPLACE from deleting/reinserting history when recursive_triggers
  -- are OFF, even when the remaining discount would fit a smaller rewrite.
  EXISTS(SELECT 1 FROM salary_withheld_obligation_payments p WHERE p.owner_user_id=NEW.owner_user_id
   AND (p.payment_id=NEW.payment_id OR p.creation_key=NEW.creation_key))
  OR NOT EXISTS(
   SELECT 1 FROM salary_period_statements s
   JOIN income_expectation_totals e ON e.owner_user_id=s.owner_user_id AND e.source_id=s.source_id AND e.occurrence_key=s.occurrence_key
   WHERE s.statement_seq=NEW.statement_seq AND s.owner_user_id=NEW.owner_user_id
   AND s.gross_cents IS NOT NULL AND e.state<>'canceled'
   -- A statement with incomplete gross/discount reconciliation is
   -- informational only, not eligible as withholding settlement evidence.
   AND s.gross_cents=s.net_cents+COALESCE((
    SELECT SUM(CAST(json_extract(j.value,'$.amountCents') AS INTEGER))
    FROM json_each(s.discounts_json) j
   ),0)
   AND s.statement_seq=(
    SELECT MAX(s2.statement_seq) FROM salary_period_statements s2
    WHERE s2.owner_user_id=s.owner_user_id AND s2.source_id=s.source_id AND s2.occurrence_key=s.occurrence_key)
   AND json_type(s.discounts_json,'$['||NEW.discount_index||']')='object'
   AND json_type(s.discounts_json,'$['||NEW.discount_index||'].amountCents')='integer'
   AND CAST(json_extract(s.discounts_json,'$['||NEW.discount_index||'].amountCents') AS INTEGER)>=NEW.amount_cents
   AND NEW.amount_cents<=CAST(json_extract(s.discounts_json,'$['||NEW.discount_index||'].amountCents') AS INTEGER)-
    COALESCE((SELECT SUM(p.amount_cents) FROM salary_withheld_obligation_payments p
     WHERE p.owner_user_id=NEW.owner_user_id AND p.statement_seq=NEW.statement_seq AND p.discount_index=NEW.discount_index),0)
  )
  OR NOT EXISTS(
   SELECT 1 FROM financial_obligation_balances o
    WHERE o.owner_user_id=NEW.owner_user_id AND o.obligation_id=NEW.obligation_id
     AND o.cancellation_id IS NULL AND o.outstanding_cents>=NEW.amount_cents);
END;
CREATE TRIGGER salary_withheld_no_update BEFORE UPDATE ON salary_withheld_obligation_payments
BEGIN SELECT RAISE(ABORT,'WITHHOLDING_IMMUTABLE'); END;
CREATE TRIGGER salary_withheld_no_delete BEFORE DELETE ON salary_withheld_obligation_payments
BEGIN SELECT RAISE(ABORT,'WITHHOLDING_IMMUTABLE'); END;
-- Once a withholding is confirmed from a given competence, freeze its
-- payroll statement: otherwise a newer version could duplicate the evidence.
DROP TRIGGER salary_statement_guard;
CREATE TRIGGER salary_statement_guard BEFORE INSERT ON salary_period_statements
BEGIN
 SELECT RAISE(ABORT,'SALARY_STATEMENT_INVALID') WHERE NEW.statement_seq<>-1
 OR NOT EXISTS(SELECT 1 FROM income_sources s WHERE s.owner_user_id=NEW.owner_user_id AND s.source_id=NEW.source_id AND s.pay_kind IN ('fixed','mixed'))
 OR EXISTS(SELECT 1 FROM income_expectation_totals e
  WHERE e.owner_user_id=NEW.owner_user_id AND e.source_id=NEW.source_id
    AND e.occurrence_key=NEW.occurrence_key AND e.state='canceled')
 OR EXISTS(
  SELECT 1 FROM salary_period_statements old
  JOIN salary_withheld_obligation_payments p ON p.owner_user_id=old.owner_user_id AND p.statement_seq=old.statement_seq
  WHERE old.owner_user_id=NEW.owner_user_id AND old.source_id=NEW.source_id AND old.occurrence_key=NEW.occurrence_key)
 OR (NEW.gross_cents IS NULL AND NEW.discounts_json<>'[]')
 OR NEW.base_net_at_entry_cents<>(
  CASE WHEN (SELECT e.kind FROM income_expectations e
    WHERE e.owner_user_id=NEW.owner_user_id AND e.source_id=NEW.source_id AND e.occurrence_key=NEW.occurrence_key)='scheduled'
  THEN COALESCE((
    SELECT r.net_cents FROM salary_base_revisions r
    JOIN income_expectations e ON e.owner_user_id=r.owner_user_id AND e.source_id=r.source_id
    WHERE e.owner_user_id=NEW.owner_user_id AND e.source_id=NEW.source_id AND e.occurrence_key=NEW.occurrence_key
     AND r.effective_on<=e.original_on ORDER BY r.effective_on DESC LIMIT 1
  ),(SELECT fixed_net_cents FROM income_sources s WHERE s.owner_user_id=NEW.owner_user_id AND s.source_id=NEW.source_id))
  ELSE (SELECT e.expected_cents FROM income_expectations e
    WHERE e.owner_user_id=NEW.owner_user_id AND e.source_id=NEW.source_id AND e.occurrence_key=NEW.occurrence_key)
  END
 )
 OR EXISTS(SELECT 1 FROM salary_period_statements p WHERE p.owner_user_id=NEW.owner_user_id AND p.creation_key=NEW.creation_key);
END;

-- Obligations have TWO settlement provenance channels:
-- (a) cash payment with posted bank expense, and
-- (b) user-confirmed salary withholding with NO bank expense.
-- Refunds affect only (a). The read model combines both once.
DROP VIEW financial_obligation_balances;
CREATE VIEW financial_obligation_balances AS
WITH paid_cash AS (
 SELECT p.owner_user_id,p.obligation_id,
   SUM(p.amount_cents-COALESCE((SELECT SUM(r.amount_cents) FROM cash_refunds r
    WHERE r.owner_user_id=p.owner_user_id AND r.original_movement_id=p.movement_id),0)) AS net_cents
 FROM financial_obligation_payments p GROUP BY p.owner_user_id,p.obligation_id
), paid_payroll AS (
 SELECT owner_user_id,obligation_id,SUM(amount_cents) AS net_cents
 FROM salary_withheld_obligation_payments GROUP BY owner_user_id,obligation_id
)
SELECT o.owner_user_id,o.obligation_id,o.creation_key,o.title,o.category,
 o.total_cents,o.due_on,o.created_at,
 COALESCE(p.net_cents,0)+COALESCE(w.net_cents,0) AS paid_cents,
 CASE WHEN c.cancellation_id IS NOT NULL THEN 0
 ELSE o.total_cents-COALESCE(p.net_cents,0)-COALESCE(w.net_cents,0) END AS outstanding_cents,
 c.cancellation_id,c.canceled_on,c.reason AS cancellation_reason,c.created_at AS canceled_at
FROM financial_obligations o
LEFT JOIN paid_cash p ON p.owner_user_id=o.owner_user_id AND p.obligation_id=o.obligation_id
LEFT JOIN paid_payroll w ON w.owner_user_id=o.owner_user_id AND w.obligation_id=o.obligation_id
LEFT JOIN obligation_cancellations c ON c.owner_user_id=o.owner_user_id AND c.obligation_id=o.obligation_id;

-- An already paid-by-payroll obligation cannot be canceled as 'unpaid'.
DROP TRIGGER no_cancel_after_payment;
CREATE TRIGGER no_cancel_after_payment BEFORE INSERT ON obligation_cancellations
BEGIN
 SELECT RAISE(ABORT,'OBLIGATION_HAS_PAYMENTS') WHERE
 EXISTS(SELECT 1 FROM financial_obligation_payments p WHERE p.owner_user_id=NEW.owner_user_id AND p.obligation_id=NEW.obligation_id)
 OR EXISTS(SELECT 1 FROM salary_withheld_obligation_payments p WHERE p.owner_user_id=NEW.owner_user_id AND p.obligation_id=NEW.obligation_id);
END;
