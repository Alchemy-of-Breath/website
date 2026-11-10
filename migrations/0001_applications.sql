CREATE TABLE IF NOT EXISTS facilitator_applications (
  application_id TEXT PRIMARY KEY,
  payload_hash TEXT NOT NULL,
  submitted_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  variant TEXT NOT NULL CHECK (variant IN ('default','coaches')),
  outcome TEXT NOT NULL,
  application_lead_source TEXT NOT NULL,
  attribution_status TEXT NOT NULL,
  campaign_id TEXT NOT NULL DEFAULT '',
  adset_id TEXT NOT NULL DEFAULT '',
  ad_id TEXT NOT NULL DEFAULT '',
  payload_json TEXT NOT NULL,
  ghl_contact_id TEXT,
  crm_state TEXT NOT NULL DEFAULT 'pending',
  workflow_state TEXT NOT NULL DEFAULT 'pending',
  workflow_attempted_at TEXT,
  status TEXT NOT NULL DEFAULT 'received',
  last_error TEXT,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS facilitator_application_events (
  event_id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL REFERENCES facilitator_applications(application_id),
  event_name TEXT NOT NULL,
  delivery_state TEXT NOT NULL DEFAULT 'pending',
  accepted_at TEXT,
  browser_attempted_at TEXT,
  provider_receipt TEXT,
  UNIQUE(application_id,event_name)
);
CREATE INDEX IF NOT EXISTS applications_received ON facilitator_applications(received_at);
CREATE INDEX IF NOT EXISTS applications_contact ON facilitator_applications(ghl_contact_id);
CREATE INDEX IF NOT EXISTS applications_campaign ON facilitator_applications(campaign_id,received_at);
-- Browser attempts are distinct from provider receipts and conversion attribution.
-- This column is part of the initial schema; migrations are applied only once.
