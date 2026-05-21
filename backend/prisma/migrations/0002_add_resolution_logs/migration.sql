-- AlterTable: Add first_resolved_at to contacts
ALTER TABLE "contacts" ADD COLUMN "first_resolved_at" TIMESTAMPTZ;

-- CreateTable: resolution_logs
CREATE TABLE "resolution_logs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "account_id" UUID NOT NULL,
    "conversation_id" INTEGER NOT NULL,
    "resolved_by" TEXT NOT NULL,
    "resolution_type" TEXT NOT NULL DEFAULT 'explicit',
    "ai_participated" BOOLEAN DEFAULT false,
    "agent_id" INTEGER,
    "resolved_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT "resolution_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "resolution_logs_account_id_idx" ON "resolution_logs"("account_id");
CREATE INDEX "resolution_logs_resolved_at_idx" ON "resolution_logs"("resolved_at");
