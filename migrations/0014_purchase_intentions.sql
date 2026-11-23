-- SPEC-006 F1: intentions and preventive reserves are virtual, not ledger postings.
-- A purchase conversion replaces the virtual reserve with a real payable
-- atomically; neither creation nor conversion creates a cash movement.
CREATE TABLE purchase_intentions (
 owner_user_id TEXT NOT NULL CHECK(length(owner_user_id) BETWEEN 1 AND 128),
 intention_id TEXT NOT NULL,
 creation_key TEXT NOT NULL,
 title TEXT NOT NULL CHECK(length(trim(title)) BETWEEN 1 AND 120),
 description TEXT CHECK(description IS NULL OR length(trim(description)) BETWEEN 1 AND 500),
 amount_cents INTEGER NOT NULL CHECK(typeof(amount_cents)='integer' AND amount_cents BETWEEN 1 AND 9000000000000),
 planned_on TEXT NOT NULL CHECK(length(planned_on)=10 AND planned_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND date(planned_on,'+0 days')=planned_on AND substr(planned_on,1,4)>='1000'),
 created_at TEXT NOT NULL,
 PRIMARY KEY(owner_user_id,intention_id),
 UNIQUE(owner_user_id,creation_key)
);
CREATE INDEX purchase_intentions_date ON purchase_intentions(owner_user_id,planned_on,intention_id);
CREATE TABLE purchase_intention_events (
 event_seq INTEGER PRIMARY KEY AUTOINCREMENT CHECK(event_seq>0),
 owner_user_id TEXT NOT NULL,
 event_id TEXT NOT NULL,
 creation_key TEXT NOT NULL,
 intention_id TEXT NOT NULL,
 action TEXT NOT NULL CHECK(action IN ('reserve','plan','exclude','convert')),
 reserved_cents INTEGER NOT NULL CHECK(typeof(reserved_cents)='integer' AND reserved_cents BETWEEN 0 AND 9000000000000),
 obligation_id TEXT,
 created_at TEXT NOT NULL,
 UNIQUE(owner_user_id,event_id),
 UNIQUE(owner_user_id,creation_key),
 UNIQUE(owner_user_id,obligation_id),
 FOREIGN KEY(owner_user_id,intention_id) REFERENCES purchase_intentions(owner_user_id,intention_id) ON DELETE RESTRICT,
 FOREIGN KEY(owner_user_id,obligation_id) REFERENCES financial_obligations(owner_user_id,obligation_id) ON DELETE RESTRICT,
 CHECK((action='reserve' AND reserved_cents>0 AND obligation_id IS NULL)
    OR (action IN ('plan','exclude') AND reserved_cents=0 AND obligation_id IS NULL)
    OR (action='convert' AND reserved_cents=0 AND obligation_id IS NOT NULL))
);
CREATE INDEX intention_events_by_intention ON purchase_intention_events(owner_user_id,intention_id,event_seq DESC);
CREATE TRIGGER intention_event_invariants BEFORE INSERT ON purchase_intention_events BEGIN
 SELECT RAISE(ABORT,'INTENTION_EVENT_INVALID') WHERE
  NEW.event_seq<>-1
  OR NOT EXISTS(SELECT 1 FROM purchase_intentions i
    WHERE i.owner_user_id=NEW.owner_user_id AND i.intention_id=NEW.intention_id
      AND (NEW.action<>'reserve' OR NEW.reserved_cents<=i.amount_cents))
  OR EXISTS(SELECT 1 FROM purchase_intention_events e
    WHERE e.owner_user_id=NEW.owner_user_id AND e.intention_id=NEW.intention_id
      AND e.action IN ('convert','exclude'))
  OR (NEW.action='plan' AND COALESCE((SELECT e.action FROM purchase_intention_events e
    WHERE e.owner_user_id=NEW.owner_user_id AND e.intention_id=NEW.intention_id
    ORDER BY e.event_seq DESC LIMIT 1),'plan')<>'reserve')
  OR (NEW.action='convert' AND NOT EXISTS(
    SELECT 1 FROM financial_obligations o JOIN purchase_intentions i
    ON i.owner_user_id=o.owner_user_id AND i.intention_id=NEW.intention_id
    WHERE o.owner_user_id=NEW.owner_user_id AND o.obligation_id=NEW.obligation_id
      AND o.creation_key='intention-conversion:'||NEW.creation_key
      AND o.total_cents=i.amount_cents AND o.title=i.title AND o.due_on=i.planned_on))
 ;
END;
CREATE TRIGGER intention_no_update BEFORE UPDATE ON purchase_intentions
 BEGIN SELECT RAISE(ABORT,'INTENTION_IMMUTABLE'); END;
CREATE TRIGGER intention_no_delete BEFORE DELETE ON purchase_intentions
 BEGIN SELECT RAISE(ABORT,'INTENTION_IMMUTABLE'); END;
CREATE TRIGGER intention_event_no_update BEFORE UPDATE ON purchase_intention_events
 BEGIN SELECT RAISE(ABORT,'INTENTION_EVENT_IMMUTABLE'); END;
CREATE TRIGGER intention_event_no_delete BEFORE DELETE ON purchase_intention_events
 BEGIN SELECT RAISE(ABORT,'INTENTION_EVENT_IMMUTABLE'); END;

-- Only the MOST RECENT event controls the preventive reserve.
-- A converted intention retains history but contributes zero reserved cents;
-- its payable appears once in financial_obligation_balances.
CREATE VIEW purchase_intention_balances AS
WITH latest AS (
 SELECT e.* FROM purchase_intention_events e WHERE e.event_seq=(
  SELECT MAX(e2.event_seq) FROM purchase_intention_events e2
  WHERE e2.owner_user_id=e.owner_user_id AND e2.intention_id=e.intention_id
 )
)
SELECT i.*, COALESCE(e.action,'plan') AS latest_action,
 CASE COALESCE(e.action,'plan') WHEN 'reserve' THEN 'reserved'
   WHEN 'convert' THEN 'converted' WHEN 'exclude' THEN 'excluded'
   ELSE 'planning' END AS state,
 CASE WHEN e.action='reserve' THEN e.reserved_cents ELSE 0 END AS reserved_cents,
 e.obligation_id,e.event_seq AS latest_event_seq
FROM purchase_intentions i
LEFT JOIN latest e ON e.owner_user_id=i.owner_user_id AND e.intention_id=i.intention_id;
