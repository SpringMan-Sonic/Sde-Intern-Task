-- Shared bill splitter schema. All money is stored as whole cents (INTEGER).

CREATE TABLE homes (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CONSTRAINT homes_name_not_blank CHECK (length(trim(name)) > 0)
);

CREATE TABLE members (
  id         TEXT PRIMARY KEY,
  home_id    TEXT NOT NULL,
  name       TEXT NOT NULL,
  -- 1, 2, 3 ... in the order members joined the home. Decides who gets the extra cents.
  position   INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  -- Stops a member from pointing at a home that does not exist.
  CONSTRAINT members_home_fk FOREIGN KEY (home_id) REFERENCES homes (id) ON DELETE CASCADE,
  -- Stops two members from getting the same place in the order (two concurrent adds).
  CONSTRAINT members_home_position_unique UNIQUE (home_id, position),
  CONSTRAINT members_name_not_blank CHECK (length(trim(name)) > 0),
  CONSTRAINT members_position_positive CHECK (position > 0)
);

CREATE TABLE bills (
  id          TEXT PRIMARY KEY,
  home_id     TEXT NOT NULL,
  title       TEXT NOT NULL,
  total_cents INTEGER NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CONSTRAINT bills_home_fk FOREIGN KEY (home_id) REFERENCES homes (id) ON DELETE CASCADE,
  CONSTRAINT bills_title_not_blank CHECK (length(trim(title)) > 0),
  -- Stops zero, negative and non-integer (decimal or text) totals, even if the API has a bug.
  CONSTRAINT bills_total_positive_integer CHECK (typeof(total_cents) = 'integer' AND total_cents > 0)
);

CREATE TABLE shares (
  id           TEXT PRIMARY KEY,
  bill_id      TEXT NOT NULL,
  member_id    TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  paid_at      TEXT,
  -- The Idempotency-Key that paid this share. Null while the share is unpaid.
  payment_key  TEXT,
  CONSTRAINT shares_bill_fk FOREIGN KEY (bill_id) REFERENCES bills (id) ON DELETE CASCADE,
  CONSTRAINT shares_member_fk FOREIGN KEY (member_id) REFERENCES members (id) ON DELETE CASCADE,
  -- One share per member per bill.
  CONSTRAINT shares_bill_member_unique UNIQUE (bill_id, member_id),
  -- A share can be 0 cents (2 cents between 3 members), but never negative or a decimal.
  CONSTRAINT shares_amount_non_negative_integer CHECK (typeof(amount_cents) = 'integer' AND amount_cents >= 0),
  -- A share is either fully paid (time and key) or fully unpaid (neither).
  CONSTRAINT shares_paid_state_consistent CHECK ((paid_at IS NULL) = (payment_key IS NULL))
);

CREATE INDEX shares_member_unpaid_idx ON shares (member_id) WHERE paid_at IS NULL;
CREATE INDEX bills_home_idx ON bills (home_id, created_at);
