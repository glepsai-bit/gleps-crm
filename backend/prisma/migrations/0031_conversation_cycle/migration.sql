CREATE TABLE "conversation_cycles" (
  "id" UUID NOT NULL PRIMARY KEY,
  "conversation_id" UUID NOT NULL,
  "account_id" UUID NOT NULL,
  "opened_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "resolved_at" TIMESTAMPTZ,
  "resolved_by" VARCHAR(20),
  "resolved_by_user_id" UUID,
  "first_response_at" TIMESTAMPTZ,
  "first_response_by_user_id" UUID,
  "customer_messages_count" INTEGER NOT NULL DEFAULT 0,
  "agent_messages_count" INTEGER NOT NULL DEFAULT 0,
  "duration_sec" INTEGER,
  "sla_breached" BOOLEAN NOT NULL DEFAULT FALSE,
  "sla_breached_at" TIMESTAMPTZ,
  "snapshot" JSONB,
  CONSTRAINT "fk_cycle_conversation" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE,
  CONSTRAINT "fk_cycle_account" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE,
  CONSTRAINT "fk_cycle_resolver" FOREIGN KEY ("resolved_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL,
  CONSTRAINT "fk_cycle_responder" FOREIGN KEY ("first_response_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL
);
CREATE INDEX "idx_cycle_account_resolved" ON "conversation_cycles"("account_id","resolved_at");
CREATE INDEX "idx_cycle_conversation" ON "conversation_cycles"("conversation_id");
CREATE INDEX "idx_cycle_resolved_by" ON "conversation_cycles"("resolved_by");
CREATE INDEX "idx_cycle_account_opened" ON "conversation_cycles"("account_id","opened_at");

ALTER TABLE "conversations" ADD COLUMN "open_cycle_id" UUID;

-- Backfill: criar 1 ciclo pra cada conversation existente
-- Se resolved: cycle com resolvedAt do conversation. Se aberta: cycle open.
INSERT INTO "conversation_cycles" (
  id, conversation_id, account_id, opened_at, resolved_at, resolved_by,
  first_response_at, snapshot
)
SELECT
  gen_random_uuid(),
  id, account_id, created_at, resolved_at, resolved_by,
  first_response_at,
  jsonb_build_object('priority', priority, 'assigneeId', assignee_id, 'teamId', team_id)
FROM "conversations";

-- Set openCycle pra conversations ainda OPEN
UPDATE "conversations" c
SET "open_cycle_id" = cc.id
FROM "conversation_cycles" cc
WHERE cc.conversation_id = c.id
  AND c.resolved_at IS NULL;
