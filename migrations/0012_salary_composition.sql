-- SPEC-005 E3: append-only salary-base revisions and period-specific remuneration composition.
-- These records are evidence/planning; NEVER bank movements, payroll taxes or debt settlement.
CREATE TABLE salary_base_revisions (
 revision_seq INTEGER PRIMARY KEY AUTOINCREMENT CHECK(revision_seq>0),
 owner_user_id TEXT NOT NULL,
 source_id TEXT NOT NULL,
 creation_key TEXT NOT NULL,
 effective_on TEXT NOT NULL CHECK(length(effective_on)=10 AND effective_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND date(effective_on,'+0 days')=effective_on AND substr(effective_on,1,4)>='1000'),
 net_cents INTEGER NOT NULL CHECK(typeof(net_cents)='integer' AND net_cents BETWEEN 1 AND 9000000000000),
 reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 120),
 created_at TEXT NOT NULL,
 UNIQUE(owner_user_id,creation_key),
 UNIQUE(owner_user_id,source_id,effective_on),
 FOREIGN KEY(owner_user_id,source_id) REFERENCES income_sources(owner_user_id,source_id) ON DELETE RESTRICT
);
CREATE INDEX salary_revision_source ON salary_base_revisions(owner_user_id,source_id,effective_on DESC);
CREATE TRIGGER salary_revision_guard BEFORE INSERT ON salary_base_revisions
BEGIN
 SELECT RAISE(ABORT,'SALARY_REVISION_INVALID') WHERE NEW.revision_seq<>-1
 OR NOT EXISTS(SELECT 1 FROM income_sources s
  WHERE s.owner_user_id=NEW.owner_user_id AND s.source_id=NEW.source_id
  AND s.pay_kind IN ('fixed','mixed') AND s.periodicity<>'none'
  AND s.fixed_net_cents>0 AND NEW.effective_on>=s.anchor_on
  AND (s.end_on IS NULL OR NEW.effective_on<=s.end_on))
 OR EXISTS(SELECT 1 FROM salary_base_revisions r
   WHERE r.owner_user_id=NEW.owner_user_id AND r.source_id=NEW.source_id
   AND r.effective_on>=NEW.effective_on);
END;

CREATE TABLE salary_period_statements (
 statement_seq INTEGER PRIMARY KEY AUTOINCREMENT CHECK(statement_seq>0),
 owner_user_id TEXT NOT NULL,
 source_id TEXT NOT NULL,
 occurrence_key TEXT NOT NULL,
 creation_key TEXT NOT NULL,
 net_cents INTEGER NOT NULL CHECK(typeof(net_cents)='integer' AND net_cents BETWEEN 0 AND 9000000000000),
 gross_cents INTEGER CHECK(gross_cents IS NULL OR (typeof(gross_cents)='integer' AND gross_cents BETWEEN 0 AND 9000000000000)),
 discounts_json TEXT NOT NULL CHECK(json_valid(discounts_json) AND json_type(discounts_json)='array' AND length(discounts_json)<=4000),
 components_json TEXT NOT NULL CHECK(json_valid(components_json) AND json_type(components_json)='array' AND length(components_json)<=4000),
 created_at TEXT NOT NULL,
 UNIQUE(owner_user_id,creation_key),
 FOREIGN KEY(owner_user_id,source_id,occurrence_key)
   REFERENCES income_expectations(owner_user_id,source_id,occurrence_key) ON DELETE RESTRICT
);
CREATE INDEX salary_statement_latest ON salary_period_statements(owner_user_id,source_id,occurrence_key,statement_seq DESC);
CREATE TRIGGER salary_statement_guard BEFORE INSERT ON salary_period_statements
BEGIN
 SELECT RAISE(ABORT,'SALARY_STATEMENT_INVALID') WHERE NEW.statement_seq<>-1
 OR NOT EXISTS(SELECT 1 FROM income_sources s WHERE s.owner_user_id=NEW.owner_user_id AND s.source_id=NEW.source_id AND s.pay_kind IN ('fixed','mixed'))
 OR EXISTS(SELECT 1 FROM income_expectation_totals e
  WHERE e.owner_user_id=NEW.owner_user_id AND e.source_id=NEW.source_id
    AND e.occurrence_key=NEW.occurrence_key AND e.state='canceled')
 OR (NEW.gross_cents IS NULL AND NEW.discounts_json<>'[]')
 OR EXISTS(SELECT 1 FROM salary_period_statements p WHERE p.owner_user_id=NEW.owner_user_id AND p.creation_key=NEW.creation_key);
END;
CREATE TRIGGER salary_base_revisions_no_update BEFORE UPDATE ON salary_base_revisions BEGIN SELECT RAISE(ABORT,'SALARY_IMMUTABLE'); END;
CREATE TRIGGER salary_base_revisions_no_delete BEFORE DELETE ON salary_base_revisions BEGIN SELECT RAISE(ABORT,'SALARY_IMMUTABLE'); END;
CREATE TRIGGER salary_period_statements_no_update BEFORE UPDATE ON salary_period_statements BEGIN SELECT RAISE(ABORT,'SALARY_IMMUTABLE'); END;
CREATE TRIGGER salary_period_statements_no_delete BEFORE DELETE ON salary_period_statements BEGIN SELECT RAISE(ABORT,'SALARY_IMMUTABLE'); END;
