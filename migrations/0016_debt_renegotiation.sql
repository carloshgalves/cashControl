-- G2 / DEC-012: replace the ACTIVE remaining schedule, never the original audit ledger.
-- Card invoices and ordinary obligations retain their historical gross/paid
-- records. The new agreement is one atomic append-only document with JSON
-- installments; there is never a half-created schedule from a failed batch.
CREATE TABLE debt_renegotiations (
 owner_user_id TEXT NOT NULL CHECK(length(owner_user_id) BETWEEN 1 AND 128),
 agreement_id TEXT NOT NULL,
 creation_key TEXT NOT NULL,
 subject_kind TEXT NOT NULL CHECK(subject_kind IN ('obligation','card_invoice')),
 obligation_id TEXT,
 card_id TEXT,
 invoice_cycle TEXT,
 base_outstanding_cents INTEGER NOT NULL CHECK(typeof(base_outstanding_cents)='integer' AND base_outstanding_cents BETWEEN 1 AND 9000000000000),
 fees_cents INTEGER NOT NULL CHECK(typeof(fees_cents)='integer' AND fees_cents BETWEEN 0 AND 9000000000000),
 schedule_json TEXT NOT NULL CHECK(json_valid(schedule_json) AND json_type(schedule_json)='array' AND json_array_length(schedule_json) BETWEEN 1 AND 24),
 agreed_on TEXT NOT NULL CHECK(length(agreed_on)=10 AND date(agreed_on,'+0 days')=agreed_on AND substr(agreed_on,1,4)>='1000'),
 reason TEXT CHECK(reason IS NULL OR length(trim(reason)) BETWEEN 1 AND 120),
 created_at TEXT NOT NULL,
 PRIMARY KEY(owner_user_id,agreement_id),
 UNIQUE(owner_user_id,creation_key),
 FOREIGN KEY(owner_user_id,obligation_id) REFERENCES financial_obligations(owner_user_id,obligation_id) ON DELETE RESTRICT,
 FOREIGN KEY(owner_user_id,card_id) REFERENCES credit_cards(owner_user_id,card_id) ON DELETE RESTRICT,
 CHECK ((subject_kind='obligation' AND obligation_id IS NOT NULL AND card_id IS NULL AND invoice_cycle IS NULL)
     OR (subject_kind='card_invoice' AND obligation_id IS NULL AND card_id IS NOT NULL AND invoice_cycle IS NOT NULL
       AND invoice_cycle GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]')),
 CHECK(base_outstanding_cents+fees_cents BETWEEN 1 AND 9000000000000)
);
CREATE UNIQUE INDEX one_renegotiation_per_obligation
 ON debt_renegotiations(owner_user_id,obligation_id) WHERE obligation_id IS NOT NULL;
CREATE UNIQUE INDEX one_renegotiation_per_invoice
 ON debt_renegotiations(owner_user_id,card_id,invoice_cycle) WHERE card_id IS NOT NULL;

CREATE TRIGGER debt_renegotiation_guard BEFORE INSERT ON debt_renegotiations BEGIN
 SELECT RAISE(ABORT,'RENEGOTIATION_EXISTS_OR_STALE') WHERE
   EXISTS(SELECT 1 FROM debt_renegotiations a WHERE a.owner_user_id=NEW.owner_user_id AND
    (a.creation_key=NEW.creation_key OR a.agreement_id=NEW.agreement_id OR
     (NEW.subject_kind='obligation' AND a.obligation_id=NEW.obligation_id) OR
     (NEW.subject_kind='card_invoice' AND a.card_id=NEW.card_id AND a.invoice_cycle=NEW.invoice_cycle)))
   OR (NEW.subject_kind='obligation' AND NOT EXISTS(
    SELECT 1 FROM financial_obligation_balances o
    WHERE o.owner_user_id=NEW.owner_user_id AND o.obligation_id=NEW.obligation_id
      AND o.cancellation_id IS NULL AND o.outstanding_cents=NEW.base_outstanding_cents))
   OR (NEW.subject_kind='card_invoice' AND NOT EXISTS(
    SELECT 1 FROM credit_invoice_balances v
    WHERE v.owner_user_id=NEW.owner_user_id AND v.card_id=NEW.card_id
      AND v.invoice_cycle=NEW.invoice_cycle AND v.outstanding_cents=NEW.base_outstanding_cents))
   OR (NEW.subject_kind='obligation' AND EXISTS(
     SELECT 1 FROM financial_obligation_payments p
     JOIN posted_cash_movements m ON m.owner_user_id=p.owner_user_id AND m.movement_id=p.movement_id
     WHERE p.owner_user_id=NEW.owner_user_id AND p.obligation_id=NEW.obligation_id AND m.occurred_on>NEW.agreed_on))
   OR (NEW.subject_kind='obligation' AND EXISTS(
     SELECT 1 FROM salary_withheld_obligation_payments w
     WHERE w.owner_user_id=NEW.owner_user_id AND w.obligation_id=NEW.obligation_id AND w.confirmed_on>NEW.agreed_on))
   OR (NEW.subject_kind='card_invoice' AND EXISTS(
     SELECT 1 FROM card_invoice_payments p
     WHERE p.owner_user_id=NEW.owner_user_id AND p.card_id=NEW.card_id AND p.invoice_cycle=NEW.invoice_cycle
       AND p.paid_on>NEW.agreed_on));
 SELECT RAISE(ABORT,'INVALID_RENEGOTIATION_SCHEDULE') WHERE
   EXISTS(SELECT 1 FROM json_each(NEW.schedule_json) j WHERE
     json_type(j.value)<>'object' OR
     json_type(j.value,'$.dueOn')<>'text' OR
     json_type(j.value,'$.amountCents')<>'integer' OR
     CAST(json_extract(j.value,'$.amountCents') AS INTEGER) NOT BETWEEN 1 AND 9000000000000 OR
     length(json_extract(j.value,'$.dueOn'))<>10 OR
     date(json_extract(j.value,'$.dueOn'),'+0 days')<>json_extract(j.value,'$.dueOn') OR
     substr(json_extract(j.value,'$.dueOn'),1,4)<'1000' OR
     json_extract(j.value,'$.dueOn')<NEW.agreed_on OR
     (CAST(j.key AS INTEGER)>0 AND EXISTS(
       SELECT 1 FROM json_each(NEW.schedule_json) prev WHERE CAST(prev.key AS INTEGER)=CAST(j.key AS INTEGER)-1
        AND json_extract(prev.value,'$.dueOn')>json_extract(j.value,'$.dueOn')))
   )
   OR COALESCE((SELECT SUM(CAST(json_extract(j.value,'$.amountCents') AS INTEGER))
     FROM json_each(NEW.schedule_json) j),0)<>NEW.base_outstanding_cents+NEW.fees_cents;
END;
CREATE TRIGGER renegotiation_no_update BEFORE UPDATE ON debt_renegotiations BEGIN SELECT RAISE(ABORT,'RENEGOTIATION_IMMUTABLE'); END;
CREATE TRIGGER renegotiation_no_delete BEFORE DELETE ON debt_renegotiations BEGIN SELECT RAISE(ABORT,'RENEGOTIATION_IMMUTABLE'); END;

CREATE TABLE debt_renegotiation_payments(
 owner_user_id TEXT NOT NULL,
 payment_id TEXT NOT NULL,
 creation_key TEXT NOT NULL,
 agreement_id TEXT NOT NULL,
 installment_no INTEGER NOT NULL CHECK(typeof(installment_no)='integer' AND installment_no BETWEEN 1 AND 24),
 movement_id TEXT NOT NULL,
 account_id TEXT NOT NULL,
 amount_cents INTEGER NOT NULL CHECK(typeof(amount_cents)='integer' AND amount_cents BETWEEN 1 AND 9000000000000),
 method TEXT NOT NULL CHECK(method IN ('cash','pix','debit','bank_transfer')),
 paid_on TEXT NOT NULL CHECK(length(paid_on)=10 AND date(paid_on,'+0 days')=paid_on AND substr(paid_on,1,4)>='1000'),
 created_at TEXT NOT NULL,
 PRIMARY KEY(owner_user_id,payment_id),
 UNIQUE(owner_user_id,creation_key),
 UNIQUE(owner_user_id,movement_id),
 FOREIGN KEY(owner_user_id,agreement_id) REFERENCES debt_renegotiations(owner_user_id,agreement_id) ON DELETE RESTRICT,
 FOREIGN KEY(owner_user_id,movement_id) REFERENCES posted_cash_movements(owner_user_id,movement_id) ON DELETE RESTRICT,
 FOREIGN KEY(owner_user_id,account_id) REFERENCES financial_accounts(owner_user_id,account_id) ON DELETE RESTRICT
);
CREATE INDEX renegotiation_payments_by_installment ON debt_renegotiation_payments(owner_user_id,agreement_id,installment_no,paid_on,payment_id);
CREATE TRIGGER renegotiation_payment_guard BEFORE INSERT ON debt_renegotiation_payments BEGIN
 SELECT RAISE(ABORT,'RENEGOTIATION_PAYMENT_INVALID') WHERE
  EXISTS(SELECT 1 FROM debt_renegotiation_payments p WHERE p.owner_user_id=NEW.owner_user_id
   AND (p.creation_key=NEW.creation_key OR p.payment_id=NEW.payment_id OR p.movement_id=NEW.movement_id))
  OR NOT EXISTS(SELECT 1 FROM debt_renegotiations a
   JOIN json_each(a.schedule_json) installment ON CAST(installment.key AS INTEGER)=NEW.installment_no-1
   WHERE a.owner_user_id=NEW.owner_user_id AND a.agreement_id=NEW.agreement_id
    AND NEW.paid_on>=a.agreed_on
    AND NEW.amount_cents<=CAST(json_extract(installment.value,'$.amountCents') AS INTEGER)-
     COALESCE((SELECT SUM(p.amount_cents) FROM debt_renegotiation_payments p
      WHERE p.owner_user_id=NEW.owner_user_id AND p.agreement_id=NEW.agreement_id
       AND p.installment_no=NEW.installment_no),0))
  OR NOT EXISTS(SELECT 1 FROM posted_cash_movements m
   WHERE m.owner_user_id=NEW.owner_user_id AND m.movement_id=NEW.movement_id
    AND m.direction='expense' AND m.account_id=NEW.account_id
    AND m.amount_cents=NEW.amount_cents AND m.payment_method=NEW.method
    AND m.occurred_on=NEW.paid_on AND m.creation_key='debt-renegotiation:'||NEW.creation_key)
  OR EXISTS(SELECT 1 FROM card_invoice_payments c
   WHERE c.owner_user_id=NEW.owner_user_id AND c.movement_id=NEW.movement_id)
  OR EXISTS(SELECT 1 FROM financial_obligation_payments o
   WHERE o.owner_user_id=NEW.owner_user_id AND o.movement_id=NEW.movement_id);
END;
CREATE TRIGGER renegotiation_payment_no_update BEFORE UPDATE ON debt_renegotiation_payments BEGIN SELECT RAISE(ABORT,'RENEGOTIATION_PAYMENT_IMMUTABLE'); END;
CREATE TRIGGER renegotiation_payment_no_delete BEFORE DELETE ON debt_renegotiation_payments BEGIN SELECT RAISE(ABORT,'RENEGOTIATION_PAYMENT_IMMUTABLE'); END;

-- Freeze the original schedule when it is replaced; old payments remain in history.
CREATE TRIGGER renegotiation_original_obligation_block BEFORE INSERT ON financial_obligation_payments
 WHEN EXISTS(SELECT 1 FROM debt_renegotiations a WHERE a.owner_user_id=NEW.owner_user_id AND a.obligation_id=NEW.obligation_id)
 BEGIN SELECT RAISE(ABORT,'ORIGINAL_DEBT_RENEGOTIATED'); END;
CREATE TRIGGER renegotiation_original_withholding_block BEFORE INSERT ON salary_withheld_obligation_payments
 WHEN EXISTS(SELECT 1 FROM debt_renegotiations a WHERE a.owner_user_id=NEW.owner_user_id AND a.obligation_id=NEW.obligation_id)
 BEGIN SELECT RAISE(ABORT,'ORIGINAL_DEBT_RENEGOTIATED'); END;
CREATE TRIGGER renegotiation_original_invoice_block BEFORE INSERT ON card_invoice_payments
 WHEN EXISTS(SELECT 1 FROM debt_renegotiations a WHERE a.owner_user_id=NEW.owner_user_id
  AND a.card_id=NEW.card_id AND a.invoice_cycle=NEW.invoice_cycle)
 BEGIN SELECT RAISE(ABORT,'ORIGINAL_INVOICE_RENEGOTIATED'); END;
CREATE TRIGGER renegotiation_original_invoice_purchase_block BEFORE INSERT ON credit_installments
 WHEN EXISTS(SELECT 1 FROM debt_renegotiations a WHERE a.owner_user_id=NEW.owner_user_id
  AND a.card_id=NEW.card_id AND a.invoice_cycle=NEW.invoice_cycle)
 BEGIN SELECT RAISE(ABORT,'ORIGINAL_INVOICE_RENEGOTIATED'); END;
CREATE TRIGGER renegotiation_original_cancel_block BEFORE INSERT ON obligation_cancellations
 WHEN EXISTS(SELECT 1 FROM debt_renegotiations a WHERE a.owner_user_id=NEW.owner_user_id AND a.obligation_id=NEW.obligation_id)
 BEGIN SELECT RAISE(ABORT,'ORIGINAL_DEBT_RENEGOTIATED'); END;
CREATE TRIGGER renegotiation_original_refund_block BEFORE INSERT ON cash_refunds
 WHEN EXISTS(SELECT 1 FROM financial_obligation_payments p
  JOIN debt_renegotiations a ON a.owner_user_id=p.owner_user_id AND a.obligation_id=p.obligation_id
  WHERE p.owner_user_id=NEW.owner_user_id AND p.movement_id=NEW.original_movement_id)
 BEGIN SELECT RAISE(ABORT,'ORIGINAL_DEBT_RENEGOTIATED'); END;
CREATE TRIGGER renegotiation_no_generic_refund BEFORE INSERT ON cash_refunds
 WHEN EXISTS(SELECT 1 FROM debt_renegotiation_payments p
  WHERE p.owner_user_id=NEW.owner_user_id AND p.movement_id=NEW.original_movement_id)
 BEGIN SELECT RAISE(ABORT,'RENEGOTIATION_PAYMENT_REQUIRES_SPECIAL_REVERSAL'); END;

CREATE VIEW debt_renegotiation_installment_balances AS
SELECT a.owner_user_id,a.agreement_id,a.subject_kind,a.obligation_id,a.card_id,a.invoice_cycle,
 CAST(j.key AS INTEGER)+1 AS installment_no,
 json_extract(j.value,'$.dueOn') AS due_on,
 CAST(json_extract(j.value,'$.amountCents') AS INTEGER) AS total_cents,
 COALESCE((SELECT SUM(p.amount_cents) FROM debt_renegotiation_payments p
  WHERE p.owner_user_id=a.owner_user_id AND p.agreement_id=a.agreement_id
   AND p.installment_no=CAST(j.key AS INTEGER)+1),0) AS paid_cents,
 CAST(json_extract(j.value,'$.amountCents') AS INTEGER)-
 COALESCE((SELECT SUM(p.amount_cents) FROM debt_renegotiation_payments p
  WHERE p.owner_user_id=a.owner_user_id AND p.agreement_id=a.agreement_id
   AND p.installment_no=CAST(j.key AS INTEGER)+1),0) AS outstanding_cents
FROM debt_renegotiations a JOIN json_each(a.schedule_json) j;

-- The only source for ACTIVE commitments in dashboards, alerts and F2 scenarios.
-- Original schedules are hidden only from ACTIVE totals; original history remains.
CREATE VIEW financial_active_due_items AS
 SELECT o.owner_user_id,'obligation' AS domain,'obligation:'||o.obligation_id AS due_id,
  o.due_on,o.outstanding_cents
 FROM financial_obligation_balances o
 WHERE o.outstanding_cents>0
  AND NOT EXISTS(SELECT 1 FROM debt_renegotiations a WHERE a.owner_user_id=o.owner_user_id AND a.obligation_id=o.obligation_id)
 UNION ALL
 SELECT v.owner_user_id,'card' AS domain,'card-invoice:'||v.card_id||':'||v.invoice_cycle AS due_id,
  v.due_on,v.outstanding_cents
 FROM credit_invoice_balances v WHERE v.outstanding_cents>0
  AND NOT EXISTS(SELECT 1 FROM debt_renegotiations a WHERE a.owner_user_id=v.owner_user_id AND a.card_id=v.card_id AND a.invoice_cycle=v.invoice_cycle)
 UNION ALL
 SELECT r.owner_user_id,
  CASE WHEN r.subject_kind='obligation' THEN 'obligation' ELSE 'card' END AS domain,
  'renegotiation:'||r.agreement_id||':'||r.installment_no AS due_id,r.due_on,r.outstanding_cents
 FROM debt_renegotiation_installment_balances r WHERE r.outstanding_cents>0;
