-- Backend-only first slice of DEC-001. Auth tables and authenticated routes will
-- be introduced separately after the identity decision (#8/#9).
-- owner_user_id refers to the principal obtained from the trusted session, NOT a
-- browser-submitted field. The eventual auth schema must preserve that key.
CREATE TABLE financial_accounts (
  owner_user_id TEXT NOT NULL CHECK (length(owner_user_id) BETWEEN 1 AND 128),
  account_id TEXT NOT NULL,
  creation_key TEXT NOT NULL,
  display_name TEXT NOT NULL CHECK (length(trim(display_name)) BETWEEN 1 AND 80),
  kind TEXT NOT NULL CHECK (kind IN ('general', 'bank', 'cash')),
  currency TEXT NOT NULL DEFAULT 'BRL' CHECK (currency = 'BRL'),
  initial_mode TEXT NOT NULL CHECK (initial_mode IN ('external', 'reallocate')),
  initial_amount_cents INTEGER NOT NULL CHECK (initial_amount_cents BETWEEN 0 AND 9000000000000),
  opening_cents INTEGER NOT NULL CHECK (opening_cents BETWEEN 0 AND 9000000000000),
  funding_account_id TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (owner_user_id, account_id),
  UNIQUE (owner_user_id, creation_key),
  FOREIGN KEY (owner_user_id, funding_account_id)
    REFERENCES financial_accounts (owner_user_id, account_id) ON DELETE RESTRICT,
  CHECK (
    (initial_mode = 'external' AND funding_account_id IS NULL AND opening_cents = initial_amount_cents)
    OR (initial_mode = 'reallocate' AND funding_account_id IS NOT NULL
        AND initial_amount_cents > 0 AND opening_cents = 0)
  )
);
CREATE UNIQUE INDEX single_general_wallet_per_owner
  ON financial_accounts (owner_user_id) WHERE kind = 'general';

-- This is an initial-value reallocation, NOT a cash income or expense.
-- Both ends are tenant-scoped by composite foreign keys.
CREATE TABLE initial_allocations (
  owner_user_id TEXT NOT NULL,
  allocation_id TEXT NOT NULL,
  source_account_id TEXT NOT NULL,
  target_account_id TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents BETWEEN 1 AND 9000000000000),
  created_at TEXT NOT NULL,
  PRIMARY KEY (owner_user_id, allocation_id),
  UNIQUE (owner_user_id, target_account_id),
  FOREIGN KEY (owner_user_id, source_account_id)
    REFERENCES financial_accounts (owner_user_id, account_id) ON DELETE RESTRICT,
  FOREIGN KEY (owner_user_id, target_account_id)
    REFERENCES financial_accounts (owner_user_id, account_id) ON DELETE RESTRICT,
  CHECK (source_account_id <> target_account_id)
);
CREATE INDEX allocation_source_idx ON initial_allocations(owner_user_id, source_account_id);
CREATE INDEX allocation_target_idx ON initial_allocations(owner_user_id, target_account_id);
