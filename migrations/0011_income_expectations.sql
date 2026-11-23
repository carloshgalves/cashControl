-- SPEC-005 / E2: Sources, planned expectations, and links to cash actually posted.
-- Forecasts never insert a cash movement, transfer, balance or dashboard receipt.
CREATE TABLE income_sources (
 owner_user_id TEXT NOT NULL CHECK(length(owner_user_id) BETWEEN 1 AND 128),
 source_id TEXT NOT NULL, creation_key TEXT NOT NULL,
 display_name TEXT NOT NULL CHECK(length(trim(display_name)) BETWEEN 1 AND 120),
 relationship_kind TEXT NOT NULL CHECK(relationship_kind IN ('employment','public','continuous','freelance','other')),
 pay_kind TEXT NOT NULL CHECK(pay_kind IN ('fixed','variable','mixed','occasional')),
 periodicity TEXT NOT NULL CHECK(periodicity IN ('none','weekly','fortnightly','monthly','custom')),
 anchor_on TEXT, end_on TEXT, interval_days INTEGER,
 fixed_net_cents INTEGER CHECK(fixed_net_cents IS NULL OR (typeof(fixed_net_cents)='integer' AND fixed_net_cents BETWEEN 0 AND 9000000000000)),
 created_at TEXT NOT NULL,
 PRIMARY KEY(owner_user_id,source_id), UNIQUE(owner_user_id,creation_key),
 CHECK (
  (periodicity='none' AND anchor_on IS NULL AND end_on IS NULL AND interval_days IS NULL)
  OR (periodicity<>'none' AND anchor_on IS NOT NULL)
 ),
 CHECK (periodicity='custom' AND typeof(interval_days)='integer' AND interval_days BETWEEN 1 AND 365 OR periodicity<>'custom' AND interval_days IS NULL),
 CHECK (pay_kind IN ('fixed','mixed') OR fixed_net_cents IS NULL),
 CHECK(anchor_on IS NULL OR (length(anchor_on)=10 AND anchor_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND date(anchor_on,'+0 days')=anchor_on AND substr(anchor_on,1,4)>='1000')),
 CHECK(end_on IS NULL OR (length(end_on)=10 AND end_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND date(end_on,'+0 days')=end_on AND substr(end_on,1,4)>='1000' AND end_on>=anchor_on))
);
CREATE TABLE income_expectations (
 owner_user_id TEXT NOT NULL, source_id TEXT NOT NULL,
 occurrence_key TEXT NOT NULL CHECK(length(occurrence_key) BETWEEN 1 AND 64),
 creation_key TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('manual','scheduled')),
 original_on TEXT NOT NULL CHECK(length(original_on)=10 AND original_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND date(original_on,'+0 days')=original_on AND substr(original_on,1,4)>='1000'),
 expected_cents INTEGER NOT NULL CHECK(typeof(expected_cents)='integer' AND expected_cents BETWEEN 0 AND 9000000000000),
 created_at TEXT NOT NULL,
 PRIMARY KEY(owner_user_id,source_id,occurrence_key),
 UNIQUE(owner_user_id,creation_key),
 FOREIGN KEY(owner_user_id,source_id) REFERENCES income_sources(owner_user_id,source_id) ON DELETE RESTRICT,
 CHECK((kind='manual' AND occurrence_key GLOB 'manual_*') OR (kind='scheduled' AND occurrence_key='scheduled_'||original_on))
);
CREATE INDEX income_expectations_on ON income_expectations(owner_user_id,original_on,source_id);
CREATE TABLE income_expectation_events (
 seq INTEGER PRIMARY KEY AUTOINCREMENT,
 owner_user_id TEXT NOT NULL, source_id TEXT NOT NULL, occurrence_key TEXT NOT NULL,
 creation_key TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('confirmed','delayed','canceled')),
 expected_on TEXT NOT NULL CHECK(length(expected_on)=10 AND expected_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND date(expected_on,'+0 days')=expected_on AND substr(expected_on,1,4)>='1000'),
 reason TEXT CHECK(reason IS NULL OR (state IN ('delayed','canceled') AND length(trim(reason)) BETWEEN 1 AND 120)),
 created_at TEXT NOT NULL,
 UNIQUE(owner_user_id,creation_key),
 FOREIGN KEY(owner_user_id,source_id,occurrence_key) REFERENCES income_expectations(owner_user_id,source_id,occurrence_key) ON DELETE RESTRICT
);
CREATE INDEX income_events_latest ON income_expectation_events(owner_user_id,source_id,occurrence_key,seq DESC);
CREATE TRIGGER income_event_guard BEFORE INSERT ON income_expectation_events BEGIN
 SELECT RAISE(ABORT,'INCOME_EVENT_INVALID') WHERE NEW.seq<>-1
 OR NOT EXISTS(SELECT 1 FROM income_expectations e WHERE e.owner_user_id=NEW.owner_user_id AND e.source_id=NEW.source_id AND e.occurrence_key=NEW.occurrence_key)
 OR EXISTS(SELECT 1 FROM income_expectation_events e WHERE e.owner_user_id=NEW.owner_user_id AND e.creation_key=NEW.creation_key)
 OR COALESCE((SELECT state FROM income_expectation_events e WHERE e.owner_user_id=NEW.owner_user_id AND e.source_id=NEW.source_id AND e.occurrence_key=NEW.occurrence_key ORDER BY seq DESC LIMIT 1),'planned')='canceled'
 OR (NEW.state='delayed' AND NEW.expected_on<=COALESCE((SELECT expected_on FROM income_expectation_events e WHERE e.owner_user_id=NEW.owner_user_id AND e.source_id=NEW.source_id AND e.occurrence_key=NEW.occurrence_key ORDER BY seq DESC LIMIT 1),(SELECT original_on FROM income_expectations e WHERE e.owner_user_id=NEW.owner_user_id AND e.source_id=NEW.source_id AND e.occurrence_key=NEW.occurrence_key)))
 OR (NEW.state<>'delayed' AND NEW.expected_on<>COALESCE((SELECT expected_on FROM income_expectation_events e WHERE e.owner_user_id=NEW.owner_user_id AND e.source_id=NEW.source_id AND e.occurrence_key=NEW.occurrence_key ORDER BY seq DESC LIMIT 1),(SELECT original_on FROM income_expectations e WHERE e.owner_user_id=NEW.owner_user_id AND e.source_id=NEW.source_id AND e.occurrence_key=NEW.occurrence_key)));
END;
CREATE TABLE income_receipt_links (
 owner_user_id TEXT NOT NULL, source_id TEXT NOT NULL,
 occurrence_key TEXT NOT NULL, movement_id TEXT NOT NULL,
 creation_key TEXT NOT NULL, created_at TEXT NOT NULL,
 PRIMARY KEY(owner_user_id,movement_id), UNIQUE(owner_user_id,creation_key),
 FOREIGN KEY(owner_user_id,source_id,occurrence_key) REFERENCES income_expectations(owner_user_id,source_id,occurrence_key) ON DELETE RESTRICT,
 FOREIGN KEY(owner_user_id,movement_id) REFERENCES posted_cash_movements(owner_user_id,movement_id) ON DELETE RESTRICT
);
CREATE INDEX income_receipt_by_expectation ON income_receipt_links(owner_user_id,source_id,occurrence_key);
CREATE TRIGGER income_receipt_guard BEFORE INSERT ON income_receipt_links BEGIN
 SELECT RAISE(ABORT,'INCOME_RECEIPT_INVALID') WHERE NOT EXISTS(
  SELECT 1 FROM posted_cash_movements m WHERE m.owner_user_id=NEW.owner_user_id AND m.movement_id=NEW.movement_id AND m.direction='income'
 ) OR EXISTS(SELECT 1 FROM cash_refunds r WHERE r.owner_user_id=NEW.owner_user_id AND r.refund_movement_id=NEW.movement_id)
 OR EXISTS(SELECT 1 FROM income_receipt_links l WHERE l.owner_user_id=NEW.owner_user_id AND (l.movement_id=NEW.movement_id OR l.creation_key=NEW.creation_key))
 OR EXISTS(SELECT 1 FROM income_expectation_events e WHERE e.owner_user_id=NEW.owner_user_id AND e.source_id=NEW.source_id AND e.occurrence_key=NEW.occurrence_key AND e.state='canceled' AND e.seq=(SELECT MAX(seq) FROM income_expectation_events x WHERE x.owner_user_id=e.owner_user_id AND x.source_id=e.source_id AND x.occurrence_key=e.occurrence_key));
END;
CREATE TRIGGER income_link_no_refund BEFORE INSERT ON cash_refunds
WHEN EXISTS(SELECT 1 FROM income_receipt_links l WHERE l.owner_user_id=NEW.owner_user_id AND l.movement_id=NEW.refund_movement_id)
BEGIN SELECT RAISE(ABORT,'INCOME_RECEIPT_IS_NOT_REFUND'); END;
CREATE VIEW income_expectation_totals AS
SELECT p.owner_user_id,p.source_id,p.occurrence_key,p.original_on,p.expected_cents,p.kind,p.created_at,
 COALESCE((SELECT e.state FROM income_expectation_events e WHERE e.owner_user_id=p.owner_user_id AND e.source_id=p.source_id AND e.occurrence_key=p.occurrence_key ORDER BY e.seq DESC LIMIT 1),'planned') AS state,
 COALESCE((SELECT e.expected_on FROM income_expectation_events e WHERE e.owner_user_id=p.owner_user_id AND e.source_id=p.source_id AND e.occurrence_key=p.occurrence_key ORDER BY e.seq DESC LIMIT 1),p.original_on) AS current_on,
 COALESCE((SELECT SUM(m.amount_cents) FROM income_receipt_links l JOIN posted_cash_movements m ON m.owner_user_id=l.owner_user_id AND m.movement_id=l.movement_id WHERE l.owner_user_id=p.owner_user_id AND l.source_id=p.source_id AND l.occurrence_key=p.occurrence_key),0) AS received_cents
FROM income_expectations p;
CREATE TRIGGER income_sources_no_update BEFORE UPDATE ON income_sources BEGIN SELECT RAISE(ABORT,'INCOME_IMMUTABLE'); END;
CREATE TRIGGER income_sources_no_delete BEFORE DELETE ON income_sources BEGIN SELECT RAISE(ABORT,'INCOME_IMMUTABLE'); END;
CREATE TRIGGER income_expectations_no_update BEFORE UPDATE ON income_expectations BEGIN SELECT RAISE(ABORT,'INCOME_IMMUTABLE'); END;
CREATE TRIGGER income_expectations_no_delete BEFORE DELETE ON income_expectations BEGIN SELECT RAISE(ABORT,'INCOME_IMMUTABLE'); END;
CREATE TRIGGER income_expectation_events_no_update BEFORE UPDATE ON income_expectation_events BEGIN SELECT RAISE(ABORT,'INCOME_IMMUTABLE'); END;
CREATE TRIGGER income_expectation_events_no_delete BEFORE DELETE ON income_expectation_events BEGIN SELECT RAISE(ABORT,'INCOME_IMMUTABLE'); END;
CREATE TRIGGER income_receipt_links_no_update BEFORE UPDATE ON income_receipt_links BEGIN SELECT RAISE(ABORT,'INCOME_IMMUTABLE'); END;
CREATE TRIGGER income_receipt_links_no_delete BEFORE DELETE ON income_receipt_links BEGIN SELECT RAISE(ABORT,'INCOME_IMMUTABLE'); END;

-- INSERT OR REPLACE must not remove historical rows even when
-- SQLite recursive_triggers are disabled.
CREATE TRIGGER income_source_no_replace BEFORE INSERT ON income_sources
WHEN EXISTS(SELECT 1 FROM income_sources x WHERE x.owner_user_id=NEW.owner_user_id AND (x.source_id=NEW.source_id OR x.creation_key=NEW.creation_key))
BEGIN SELECT RAISE(ABORT,'INCOME_IMMUTABLE'); END;
CREATE TRIGGER income_expectation_no_replace BEFORE INSERT ON income_expectations
WHEN EXISTS(SELECT 1 FROM income_expectations x WHERE x.owner_user_id=NEW.owner_user_id AND (x.creation_key=NEW.creation_key OR (x.source_id=NEW.source_id AND x.occurrence_key=NEW.occurrence_key)))
BEGIN SELECT RAISE(ABORT,'INCOME_IMMUTABLE'); END;
CREATE TRIGGER income_link_no_replace BEFORE INSERT ON income_receipt_links
WHEN EXISTS(SELECT 1 FROM income_receipt_links x WHERE x.owner_user_id=NEW.owner_user_id AND (x.creation_key=NEW.creation_key OR x.movement_id=NEW.movement_id))
BEGIN SELECT RAISE(ABORT,'INCOME_IMMUTABLE'); END;

-- Serializes safely with the original receipt-link insert. A single valid
-- movement is capped at 9e12 cents, but a source/occurrence may accumulate
-- many payments: reject overflow BEFORE persisting the final link.
CREATE TRIGGER income_receipt_safe_total BEFORE INSERT ON income_receipt_links BEGIN
 SELECT RAISE(ABORT,'INCOME_RECEIPT_TOO_LARGE') WHERE
 (SELECT m.amount_cents FROM posted_cash_movements m WHERE m.owner_user_id=NEW.owner_user_id AND m.movement_id=NEW.movement_id)
 > 9007199254740991-COALESCE((SELECT e.received_cents FROM income_expectation_totals e
  WHERE e.owner_user_id=NEW.owner_user_id AND e.source_id=NEW.source_id AND e.occurrence_key=NEW.occurrence_key),0);
END;
