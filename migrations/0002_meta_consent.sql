ALTER TABLE facilitator_applications ADD COLUMN meta_consent TEXT NOT NULL DEFAULT 'unknown'
  CHECK(meta_consent IN ('unknown','granted','denied'));
ALTER TABLE facilitator_applications ADD COLUMN meta_consent_updated_at TEXT;
