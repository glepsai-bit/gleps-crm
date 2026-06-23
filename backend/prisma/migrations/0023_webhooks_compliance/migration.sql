-- ============================================
-- T-022 Sprint 3 — Webhooks Outbound/Inbound + WhatsApp Consent
-- ============================================

-- WebhookSubscription
CREATE TABLE "webhook_subscriptions" (
  "id"               UUID NOT NULL,
  "account_id"       UUID NOT NULL,
  "name"             VARCHAR(160) NOT NULL,
  "url"              VARCHAR(1000) NOT NULL,
  "events"           TEXT[] DEFAULT ARRAY[]::TEXT[],
  "secret"           VARCHAR(255) NOT NULL,
  "active"           BOOLEAN NOT NULL DEFAULT TRUE,
  "last_delivery_at" TIMESTAMPTZ,
  "created_at"       TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"       TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "webhook_subscriptions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "webhook_subscriptions_account_id_idx" ON "webhook_subscriptions"("account_id");
CREATE INDEX "webhook_subscriptions_active_idx" ON "webhook_subscriptions"("active");

ALTER TABLE "webhook_subscriptions"
  ADD CONSTRAINT "webhook_subscriptions_account_id_fkey"
  FOREIGN KEY ("account_id") REFERENCES "accounts"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- WebhookDelivery
CREATE TABLE "webhook_deliveries" (
  "id"              UUID NOT NULL,
  "subscription_id" UUID NOT NULL,
  "event_type"      VARCHAR(120) NOT NULL,
  "payload"         JSONB NOT NULL,
  "status"          VARCHAR(20) NOT NULL DEFAULT 'pending',
  "http_status"     INTEGER,
  "response_body"   TEXT,
  "attempt_count"   INTEGER NOT NULL DEFAULT 0,
  "next_retry_at"   TIMESTAMPTZ,
  "latency_ms"      INTEGER,
  "created_at"      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completed_at"    TIMESTAMPTZ,
  CONSTRAINT "webhook_deliveries_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "webhook_deliveries_subscription_id_idx" ON "webhook_deliveries"("subscription_id");
CREATE INDEX "webhook_deliveries_status_next_retry_at_idx" ON "webhook_deliveries"("status", "next_retry_at");
CREATE INDEX "webhook_deliveries_event_type_idx" ON "webhook_deliveries"("event_type");

ALTER TABLE "webhook_deliveries"
  ADD CONSTRAINT "webhook_deliveries_subscription_id_fkey"
  FOREIGN KEY ("subscription_id") REFERENCES "webhook_subscriptions"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- InboundIntegration
CREATE TABLE "inbound_integrations" (
  "id"         UUID NOT NULL,
  "account_id" UUID NOT NULL,
  "slug"       VARCHAR(80) NOT NULL,
  "handler"    VARCHAR(80) NOT NULL,
  "config"     JSONB NOT NULL DEFAULT '{}',
  "secret"     VARCHAR(255),
  "active"     BOOLEAN NOT NULL DEFAULT TRUE,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "inbound_integrations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "inbound_integrations_account_id_slug_key" ON "inbound_integrations"("account_id", "slug");
CREATE INDEX "inbound_integrations_account_id_idx" ON "inbound_integrations"("account_id");

ALTER TABLE "inbound_integrations"
  ADD CONSTRAINT "inbound_integrations_account_id_fkey"
  FOREIGN KEY ("account_id") REFERENCES "accounts"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- WhatsappConsent
CREATE TABLE "whatsapp_consents" (
  "id"         UUID NOT NULL,
  "account_id" UUID NOT NULL,
  "contact_id" UUID,
  "phone"      VARCHAR(30) NOT NULL,
  "status"     VARCHAR(20) NOT NULL DEFAULT 'opted_in',
  "source"     VARCHAR(40) NOT NULL DEFAULT 'manual',
  "reason"     VARCHAR(255),
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "whatsapp_consents_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "whatsapp_consents_account_id_phone_key" ON "whatsapp_consents"("account_id", "phone");
CREATE INDEX "whatsapp_consents_account_id_status_idx" ON "whatsapp_consents"("account_id", "status");
CREATE INDEX "whatsapp_consents_phone_idx" ON "whatsapp_consents"("phone");

ALTER TABLE "whatsapp_consents"
  ADD CONSTRAINT "whatsapp_consents_account_id_fkey"
  FOREIGN KEY ("account_id") REFERENCES "accounts"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
