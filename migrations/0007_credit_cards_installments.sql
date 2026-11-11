-- SPEC-004 / D1 — one owner for every card, purchase and installment.
-- Instrument credit does not increase financial_account_balances; no cash
-- movement is created until the separate D2 invoice-settlement feature.
CREATE TABLE credit_cards (
 owner_user_id TEXT NOT NULL CHECK(length(owner_user_id) BETWEEN 1 AND 128),
 card_id TEXT NOT NULL,
 creation_key TEXT NOT NULL,
 display_name TEXT NOT NULL CHECK(length(trim(display_name)) BETWEEN 1 AND 80),
 institution TEXT CHECK(institution IS NULL OR length(trim(institution)) BETWEEN 1 AND 80),
 limit_cents INTEGER NOT NULL CHECK(limit_cents BETWEEN 0 AND 9000000000000),
 closing_day INTEGER NOT NULL CHECK(closing_day BETWEEN 1 AND 31),
 due_day INTEGER NOT NULL CHECK(due_day BETWEEN 1 AND 31),
 created_at TEXT NOT NULL,
 PRIMARY KEY(owner_user_id,card_id),
 UNIQUE(owner_user_id,creation_key)
);
CREATE INDEX credit_cards_list_idx ON credit_cards(owner_user_id,created_at,card_id);

CREATE TABLE credit_purchases (
 owner_user_id TEXT NOT NULL,
 purchase_id TEXT NOT NULL,
 card_id TEXT NOT NULL,
 creation_key TEXT NOT NULL,
 title TEXT NOT NULL CHECK(length(trim(title)) BETWEEN 1 AND 120),
 merchant TEXT CHECK(merchant IS NULL OR length(trim(merchant)) BETWEEN 1 AND 120),
 category TEXT CHECK(category IS NULL OR length(trim(category)) BETWEEN 1 AND 80),
 purchased_on TEXT NOT NULL CHECK(
  length(purchased_on)=10 AND purchased_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
 ),
 total_cents INTEGER NOT NULL CHECK(total_cents BETWEEN 1 AND 9000000000000),
 installments_count INTEGER NOT NULL CHECK(installments_count BETWEEN 1 AND 60),
 created_at TEXT NOT NULL,
 PRIMARY KEY(owner_user_id,purchase_id),
 UNIQUE(owner_user_id,creation_key),
 FOREIGN KEY(owner_user_id,card_id) REFERENCES credit_cards(owner_user_id,card_id) ON DELETE RESTRICT
);
CREATE INDEX credit_purchases_card_idx ON credit_purchases(owner_user_id,card_id,purchased_on DESC,created_at DESC,purchase_id DESC);

CREATE TABLE credit_installments (
 owner_user_id TEXT NOT NULL,
 purchase_id TEXT NOT NULL,
 installment_no INTEGER NOT NULL CHECK(installment_no BETWEEN 1 AND 60),
 card_id TEXT NOT NULL,
 invoice_cycle TEXT NOT NULL CHECK(length(invoice_cycle)=7 AND invoice_cycle GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'),
 due_on TEXT NOT NULL CHECK(length(due_on)=10 AND due_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
 amount_cents INTEGER NOT NULL CHECK(amount_cents BETWEEN 1 AND 9000000000000),
 PRIMARY KEY(owner_user_id,purchase_id,installment_no),
 FOREIGN KEY(owner_user_id,purchase_id) REFERENCES credit_purchases(owner_user_id,purchase_id) ON DELETE RESTRICT,
 FOREIGN KEY(owner_user_id,card_id) REFERENCES credit_cards(owner_user_id,card_id) ON DELETE RESTRICT
);
CREATE INDEX credit_installments_invoice_idx
 ON credit_installments(owner_user_id,card_id,invoice_cycle,purchase_id,installment_no);

-- A future writer cannot silently over-allocate a purchase or reassign a
-- single installment to another card/owner. The service inserts all rows in
-- one atomic D1 batch; missing parts are prevented by rollback of that batch.
CREATE TRIGGER credit_installment_invariants BEFORE INSERT ON credit_installments
BEGIN
 SELECT RAISE(ABORT,'CARD_INSTALLMENT_INVALID') WHERE NOT EXISTS (
  SELECT 1 FROM credit_purchases p
  WHERE p.owner_user_id=NEW.owner_user_id AND p.purchase_id=NEW.purchase_id
    AND p.card_id=NEW.card_id AND NEW.installment_no<=p.installments_count
    AND NEW.amount_cents+COALESCE((
      SELECT SUM(i.amount_cents) FROM credit_installments i
      WHERE i.owner_user_id=NEW.owner_user_id AND i.purchase_id=NEW.purchase_id
    ),0)<=p.total_cents
 );
END;
CREATE TRIGGER credit_card_immutable_update BEFORE UPDATE ON credit_cards BEGIN SELECT RAISE(ABORT,'CARD_IMMUTABLE'); END;
CREATE TRIGGER credit_card_immutable_delete BEFORE DELETE ON credit_cards BEGIN SELECT RAISE(ABORT,'CARD_IMMUTABLE'); END;
CREATE TRIGGER credit_purchase_immutable_update BEFORE UPDATE ON credit_purchases BEGIN SELECT RAISE(ABORT,'PURCHASE_IMMUTABLE'); END;
CREATE TRIGGER credit_purchase_immutable_delete BEFORE DELETE ON credit_purchases BEGIN SELECT RAISE(ABORT,'PURCHASE_IMMUTABLE'); END;
CREATE TRIGGER credit_installment_immutable_update BEFORE UPDATE ON credit_installments BEGIN SELECT RAISE(ABORT,'INSTALLMENT_IMMUTABLE'); END;
CREATE TRIGGER credit_installment_immutable_delete BEFORE DELETE ON credit_installments BEGIN SELECT RAISE(ABORT,'INSTALLMENT_IMMUTABLE'); END;
