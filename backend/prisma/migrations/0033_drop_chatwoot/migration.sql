-- Migration: drop Chatwoot integration columns from accounts (FitPark variant)
-- T-FitPark: Remove Chatwoot legacy. CRM passa a operar somente via Evolution API.

ALTER TABLE accounts DROP COLUMN IF EXISTS chatwoot_base_url;
ALTER TABLE accounts DROP COLUMN IF EXISTS chatwoot_account_id;
ALTER TABLE accounts DROP COLUMN IF EXISTS chatwoot_api_key;
ALTER TABLE accounts DROP COLUMN IF EXISTS chatwoot_webhook_secret;

-- Defensive: drop any standalone chatwoot_* tables if they ever existed on this DB
DROP TABLE IF EXISTS chatwoot_webhooks CASCADE;
DROP TABLE IF EXISTS chatwoot_events CASCADE;
