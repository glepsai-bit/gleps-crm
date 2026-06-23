-- T-022 Sprint 4 — Chat interno (paridade Chatwoot)
-- 17 tabelas novas: inboxes, teams, team_members, conversations, messages,
-- attachments, conversation_labels, conversation_participants, conversation_notes,
-- canned_responses, custom_attribute_definitions, sla_policies, sla_breaches,
-- mentions, read_receipts, agent_availability.

-- ============================================
-- inboxes
-- ============================================
CREATE TABLE "inboxes" (
  "id" UUID NOT NULL,
  "account_id" UUID NOT NULL,
  "name" VARCHAR(120) NOT NULL,
  "channel_type" VARCHAR(40) NOT NULL DEFAULT 'whatsapp',
  "evolution_instance" VARCHAR(120),
  "greeting" TEXT,
  "business_hours" JSONB,
  "default_team_id" UUID,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "inboxes_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "inboxes_account_id_idx" ON "inboxes"("account_id");
CREATE INDEX "inboxes_active_idx" ON "inboxes"("active");

-- ============================================
-- teams
-- ============================================
CREATE TABLE "teams" (
  "id" UUID NOT NULL,
  "account_id" UUID NOT NULL,
  "name" VARCHAR(120) NOT NULL,
  "description" TEXT,
  "allow_auto_assign" BOOLEAN NOT NULL DEFAULT true,
  "business_hours" JSONB,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "teams_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "teams_account_id_name_key" ON "teams"("account_id", "name");
CREATE INDEX "teams_account_id_idx" ON "teams"("account_id");

-- ============================================
-- team_members
-- ============================================
CREATE TABLE "team_members" (
  "id" UUID NOT NULL,
  "team_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "role" VARCHAR(20) NOT NULL DEFAULT 'member',
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "team_members_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "team_members_team_id_user_id_key" ON "team_members"("team_id", "user_id");
CREATE INDEX "team_members_team_id_idx" ON "team_members"("team_id");
CREATE INDEX "team_members_user_id_idx" ON "team_members"("user_id");

-- ============================================
-- sla_policies
-- ============================================
CREATE TABLE "sla_policies" (
  "id" UUID NOT NULL,
  "account_id" UUID NOT NULL,
  "name" VARCHAR(120) NOT NULL,
  "first_response_min" INTEGER NOT NULL,
  "resolution_min" INTEGER NOT NULL,
  "business_hours_only" BOOLEAN NOT NULL DEFAULT true,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "sla_policies_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "sla_policies_account_id_name_key" ON "sla_policies"("account_id", "name");
CREATE INDEX "sla_policies_account_id_idx" ON "sla_policies"("account_id");

-- ============================================
-- conversations
-- ============================================
CREATE TABLE "conversations" (
  "id" UUID NOT NULL,
  "account_id" UUID NOT NULL,
  "inbox_id" UUID NOT NULL,
  "contact_id" UUID,
  "status" VARCHAR(20) NOT NULL DEFAULT 'open',
  "priority" VARCHAR(20) NOT NULL DEFAULT 'medium',
  "assignee_id" UUID,
  "team_id" UUID,
  "sla_policy_id" UUID,
  "snoozed_until" TIMESTAMPTZ,
  "first_response_at" TIMESTAMPTZ,
  "resolved_at" TIMESTAMPTZ,
  "resolved_by" VARCHAR(20),
  "external_id" VARCHAR(120),
  "custom_attributes" JSONB DEFAULT '{}',
  "unread_count" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "conversations_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "conversations_account_id_idx" ON "conversations"("account_id");
CREATE INDEX "conversations_inbox_id_idx" ON "conversations"("inbox_id");
CREATE INDEX "conversations_contact_id_idx" ON "conversations"("contact_id");
CREATE INDEX "conversations_assignee_id_idx" ON "conversations"("assignee_id");
CREATE INDEX "conversations_team_id_idx" ON "conversations"("team_id");
CREATE INDEX "conversations_status_idx" ON "conversations"("status");
CREATE INDEX "conversations_external_id_idx" ON "conversations"("external_id");

-- ============================================
-- messages
-- ============================================
CREATE TABLE "messages" (
  "id" UUID NOT NULL,
  "conversation_id" UUID NOT NULL,
  "sender_type" VARCHAR(20) NOT NULL,
  "sender_id" UUID,
  "content" TEXT,
  "content_type" VARCHAR(40) NOT NULL DEFAULT 'text',
  "is_private" BOOLEAN NOT NULL DEFAULT false,
  "status" VARCHAR(20) NOT NULL DEFAULT 'sent',
  "external_id" VARCHAR(120),
  "reply_to_id" UUID,
  "delivered_at" TIMESTAMPTZ,
  "read_at" TIMESTAMPTZ,
  "metadata" JSONB DEFAULT '{}',
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "messages_conversation_id_idx" ON "messages"("conversation_id");
CREATE INDEX "messages_sender_type_idx" ON "messages"("sender_type");
CREATE INDEX "messages_external_id_idx" ON "messages"("external_id");
CREATE INDEX "messages_created_at_idx" ON "messages"("created_at");

-- ============================================
-- attachments
-- ============================================
CREATE TABLE "attachments" (
  "id" UUID NOT NULL,
  "message_id" UUID NOT NULL,
  "file_type" VARCHAR(40) NOT NULL,
  "file_url" VARCHAR(2000) NOT NULL,
  "file_size" INTEGER,
  "file_name" VARCHAR(255),
  "mime_type" VARCHAR(120),
  "thumbnail_url" VARCHAR(2000),
  "duration" INTEGER,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "attachments_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "attachments_message_id_idx" ON "attachments"("message_id");

-- ============================================
-- conversation_labels
-- ============================================
CREATE TABLE "conversation_labels" (
  "id" UUID NOT NULL,
  "conversation_id" UUID NOT NULL,
  "tag_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "conversation_labels_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "conversation_labels_conversation_id_tag_id_key" ON "conversation_labels"("conversation_id", "tag_id");
CREATE INDEX "conversation_labels_conversation_id_idx" ON "conversation_labels"("conversation_id");
CREATE INDEX "conversation_labels_tag_id_idx" ON "conversation_labels"("tag_id");

-- ============================================
-- conversation_participants
-- ============================================
CREATE TABLE "conversation_participants" (
  "id" UUID NOT NULL,
  "conversation_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "conversation_participants_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "conversation_participants_conversation_id_user_id_key" ON "conversation_participants"("conversation_id", "user_id");
CREATE INDEX "conversation_participants_conversation_id_idx" ON "conversation_participants"("conversation_id");
CREATE INDEX "conversation_participants_user_id_idx" ON "conversation_participants"("user_id");

-- ============================================
-- conversation_notes
-- ============================================
CREATE TABLE "conversation_notes" (
  "id" UUID NOT NULL,
  "conversation_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "content" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "conversation_notes_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "conversation_notes_conversation_id_idx" ON "conversation_notes"("conversation_id");

-- ============================================
-- canned_responses
-- ============================================
CREATE TABLE "canned_responses" (
  "id" UUID NOT NULL,
  "account_id" UUID NOT NULL,
  "short_code" VARCHAR(80) NOT NULL,
  "content" TEXT NOT NULL,
  "description" TEXT,
  "created_by_id" UUID,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "canned_responses_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "canned_responses_account_id_short_code_key" ON "canned_responses"("account_id", "short_code");
CREATE INDEX "canned_responses_account_id_idx" ON "canned_responses"("account_id");

-- ============================================
-- custom_attribute_definitions
-- ============================================
CREATE TABLE "custom_attribute_definitions" (
  "id" UUID NOT NULL,
  "account_id" UUID NOT NULL,
  "scope" VARCHAR(20) NOT NULL,
  "key" VARCHAR(80) NOT NULL,
  "label" VARCHAR(120) NOT NULL,
  "type" VARCHAR(20) NOT NULL,
  "options" JSONB,
  "required" BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "custom_attribute_definitions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "custom_attribute_definitions_account_id_scope_key_key" ON "custom_attribute_definitions"("account_id", "scope", "key");
CREATE INDEX "custom_attribute_definitions_account_id_scope_idx" ON "custom_attribute_definitions"("account_id", "scope");

-- ============================================
-- sla_breaches
-- ============================================
CREATE TABLE "sla_breaches" (
  "id" UUID NOT NULL,
  "conversation_id" UUID NOT NULL,
  "sla_policy_id" UUID NOT NULL,
  "breach_type" VARCHAR(40) NOT NULL,
  "expected_at" TIMESTAMPTZ NOT NULL,
  "breached_at" TIMESTAMPTZ NOT NULL,
  "notified_at" TIMESTAMPTZ,
  CONSTRAINT "sla_breaches_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "sla_breaches_conversation_id_idx" ON "sla_breaches"("conversation_id");
CREATE INDEX "sla_breaches_sla_policy_id_idx" ON "sla_breaches"("sla_policy_id");

-- ============================================
-- mentions
-- ============================================
CREATE TABLE "mentions" (
  "id" UUID NOT NULL,
  "conversation_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "message_id" UUID,
  "read" BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "mentions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "mentions_user_id_read_idx" ON "mentions"("user_id", "read");
CREATE INDEX "mentions_conversation_id_idx" ON "mentions"("conversation_id");

-- ============================================
-- read_receipts
-- ============================================
CREATE TABLE "read_receipts" (
  "id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "message_id" UUID NOT NULL,
  "read_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "read_receipts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "read_receipts_user_id_message_id_key" ON "read_receipts"("user_id", "message_id");
CREATE INDEX "read_receipts_message_id_idx" ON "read_receipts"("message_id");

-- ============================================
-- agent_availability
-- ============================================
CREATE TABLE "agent_availability" (
  "user_id" UUID NOT NULL,
  "status" VARCHAR(20) NOT NULL DEFAULT 'offline',
  "last_active_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "agent_availability_pkey" PRIMARY KEY ("user_id")
);

CREATE INDEX "agent_availability_status_idx" ON "agent_availability"("status");

-- ============================================
-- FOREIGN KEYS
-- ============================================

-- inboxes
ALTER TABLE "inboxes"
  ADD CONSTRAINT "inboxes_account_id_fkey"
  FOREIGN KEY ("account_id") REFERENCES "accounts"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "inboxes"
  ADD CONSTRAINT "inboxes_default_team_id_fkey"
  FOREIGN KEY ("default_team_id") REFERENCES "teams"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- teams
ALTER TABLE "teams"
  ADD CONSTRAINT "teams_account_id_fkey"
  FOREIGN KEY ("account_id") REFERENCES "accounts"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- team_members
ALTER TABLE "team_members"
  ADD CONSTRAINT "team_members_team_id_fkey"
  FOREIGN KEY ("team_id") REFERENCES "teams"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "team_members"
  ADD CONSTRAINT "team_members_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- conversations
ALTER TABLE "conversations"
  ADD CONSTRAINT "conversations_account_id_fkey"
  FOREIGN KEY ("account_id") REFERENCES "accounts"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "conversations"
  ADD CONSTRAINT "conversations_inbox_id_fkey"
  FOREIGN KEY ("inbox_id") REFERENCES "inboxes"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "conversations"
  ADD CONSTRAINT "conversations_contact_id_fkey"
  FOREIGN KEY ("contact_id") REFERENCES "contacts"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "conversations"
  ADD CONSTRAINT "conversations_assignee_id_fkey"
  FOREIGN KEY ("assignee_id") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "conversations"
  ADD CONSTRAINT "conversations_team_id_fkey"
  FOREIGN KEY ("team_id") REFERENCES "teams"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "conversations"
  ADD CONSTRAINT "conversations_sla_policy_id_fkey"
  FOREIGN KEY ("sla_policy_id") REFERENCES "sla_policies"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- messages
ALTER TABLE "messages"
  ADD CONSTRAINT "messages_conversation_id_fkey"
  FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "messages"
  ADD CONSTRAINT "messages_sender_id_fkey"
  FOREIGN KEY ("sender_id") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "messages"
  ADD CONSTRAINT "messages_reply_to_id_fkey"
  FOREIGN KEY ("reply_to_id") REFERENCES "messages"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- attachments
ALTER TABLE "attachments"
  ADD CONSTRAINT "attachments_message_id_fkey"
  FOREIGN KEY ("message_id") REFERENCES "messages"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- conversation_labels
ALTER TABLE "conversation_labels"
  ADD CONSTRAINT "conversation_labels_conversation_id_fkey"
  FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "conversation_labels"
  ADD CONSTRAINT "conversation_labels_tag_id_fkey"
  FOREIGN KEY ("tag_id") REFERENCES "tags"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- conversation_participants
ALTER TABLE "conversation_participants"
  ADD CONSTRAINT "conversation_participants_conversation_id_fkey"
  FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "conversation_participants"
  ADD CONSTRAINT "conversation_participants_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- conversation_notes
ALTER TABLE "conversation_notes"
  ADD CONSTRAINT "conversation_notes_conversation_id_fkey"
  FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "conversation_notes"
  ADD CONSTRAINT "conversation_notes_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- canned_responses
ALTER TABLE "canned_responses"
  ADD CONSTRAINT "canned_responses_account_id_fkey"
  FOREIGN KEY ("account_id") REFERENCES "accounts"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "canned_responses"
  ADD CONSTRAINT "canned_responses_created_by_id_fkey"
  FOREIGN KEY ("created_by_id") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- custom_attribute_definitions
ALTER TABLE "custom_attribute_definitions"
  ADD CONSTRAINT "custom_attribute_definitions_account_id_fkey"
  FOREIGN KEY ("account_id") REFERENCES "accounts"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- sla_policies
ALTER TABLE "sla_policies"
  ADD CONSTRAINT "sla_policies_account_id_fkey"
  FOREIGN KEY ("account_id") REFERENCES "accounts"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- sla_breaches
ALTER TABLE "sla_breaches"
  ADD CONSTRAINT "sla_breaches_conversation_id_fkey"
  FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "sla_breaches"
  ADD CONSTRAINT "sla_breaches_sla_policy_id_fkey"
  FOREIGN KEY ("sla_policy_id") REFERENCES "sla_policies"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- mentions
ALTER TABLE "mentions"
  ADD CONSTRAINT "mentions_conversation_id_fkey"
  FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "mentions"
  ADD CONSTRAINT "mentions_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- read_receipts
ALTER TABLE "read_receipts"
  ADD CONSTRAINT "read_receipts_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "read_receipts"
  ADD CONSTRAINT "read_receipts_message_id_fkey"
  FOREIGN KEY ("message_id") REFERENCES "messages"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- agent_availability
ALTER TABLE "agent_availability"
  ADD CONSTRAINT "agent_availability_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
