-- Management data that lives alongside the (read-only) Google Form responses.
CREATE TABLE IF NOT EXISTS enquiry_state (
  id             TEXT PRIMARY KEY,          -- stable hash of form timestamp + email
  status         TEXT NOT NULL DEFAULT 'new',
  notes          TEXT NOT NULL DEFAULT '',
  confirmed_date TEXT,                      -- YYYY-MM-DD, overrides the date parsed from the form
  follow_up      TEXT,                      -- YYYY-MM-DD
  quote          TEXT NOT NULL DEFAULT '',
  updated_at     TEXT,
  updated_by     TEXT
);

CREATE TABLE IF NOT EXISTS activity (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  enquiry_id TEXT NOT NULL,
  at         TEXT NOT NULL,
  by         TEXT NOT NULL,
  action     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_activity_enquiry ON activity (enquiry_id, at);
