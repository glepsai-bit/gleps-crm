-- T-023: WhatsApp Warmup (aquecimento de chips Evolution)
-- 6 novas tabelas + relations cascade onDelete -> accounts

-- CreateTable
CREATE TABLE "warmup_pools" (
    "id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "description" VARCHAR(500),
    "is_public" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "strategy" VARCHAR(20) NOT NULL DEFAULT 'moderate',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "warmup_pools_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "warmup_numbers" (
    "id" UUID NOT NULL,
    "pool_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "evolution_instance" VARCHAR(255) NOT NULL,
    "phone_e164" VARCHAR(20) NOT NULL,
    "display_name" VARCHAR(160),
    "status" VARCHAR(20) NOT NULL DEFAULT 'cold',
    "current_day" INTEGER NOT NULL DEFAULT 0,
    "quality_score" INTEGER NOT NULL DEFAULT 100,
    "daily_envio_plan" JSONB,
    "daily_enviadas_hoje" INTEGER NOT NULL DEFAULT 0,
    "daily_recebidas_hoje" INTEGER NOT NULL DEFAULT 0,
    "started_at" TIMESTAMPTZ,
    "last_activity_at" TIMESTAMPTZ,
    "paused_reason" VARCHAR(500),
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "warmup_numbers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "warmup_conversations" (
    "id" UUID NOT NULL,
    "pool_id" UUID NOT NULL,
    "number_a_id" UUID NOT NULL,
    "number_b_id" UUID NOT NULL,
    "last_turn_at" TIMESTAMPTZ,
    "last_sender_id" UUID,
    "turns_count" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "warmup_conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "warmup_messages" (
    "id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "sender_id" UUID NOT NULL,
    "receiver_id" UUID NOT NULL,
    "message_type" VARCHAR(20) NOT NULL,
    "content" TEXT,
    "evolution_msg_id" VARCHAR(255),
    "status" VARCHAR(20) NOT NULL DEFAULT 'pending',
    "error_message" VARCHAR(1000),
    "sent_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "warmup_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "warmup_daily_stats" (
    "id" UUID NOT NULL,
    "number_id" UUID NOT NULL,
    "date" DATE NOT NULL,
    "protocol_day" INTEGER NOT NULL,
    "planned_sends" INTEGER NOT NULL DEFAULT 0,
    "actual_sends" INTEGER NOT NULL DEFAULT 0,
    "actual_receives" INTEGER NOT NULL DEFAULT 0,
    "failed_sends" INTEGER NOT NULL DEFAULT 0,
    "quality_end" INTEGER NOT NULL DEFAULT 100,
    "status_end" VARCHAR(20) NOT NULL DEFAULT 'warming',

    CONSTRAINT "warmup_daily_stats_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "warmup_templates" (
    "id" UUID NOT NULL,
    "account_id" UUID,
    "type" VARCHAR(20) NOT NULL,
    "category" VARCHAR(40) NOT NULL,
    "content" TEXT NOT NULL,
    "weight" INTEGER NOT NULL DEFAULT 1,
    "language" VARCHAR(10) NOT NULL DEFAULT 'pt-BR',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "warmup_templates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "warmup_pools_account_id_idx" ON "warmup_pools"("account_id");

-- CreateIndex
CREATE INDEX "warmup_numbers_pool_id_status_idx" ON "warmup_numbers"("pool_id", "status");

-- CreateIndex
CREATE INDEX "warmup_numbers_status_current_day_idx" ON "warmup_numbers"("status", "current_day");

-- CreateIndex
CREATE UNIQUE INDEX "warmup_numbers_account_id_phone_e164_key" ON "warmup_numbers"("account_id", "phone_e164");

-- CreateIndex
CREATE INDEX "warmup_conversations_pool_id_is_active_idx" ON "warmup_conversations"("pool_id", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "warmup_conversations_number_a_id_number_b_id_key" ON "warmup_conversations"("number_a_id", "number_b_id");

-- CreateIndex
CREATE INDEX "warmup_messages_conversation_id_created_at_idx" ON "warmup_messages"("conversation_id", "created_at");

-- CreateIndex
CREATE INDEX "warmup_messages_sender_id_sent_at_idx" ON "warmup_messages"("sender_id", "sent_at");

-- CreateIndex
CREATE INDEX "warmup_daily_stats_date_idx" ON "warmup_daily_stats"("date");

-- CreateIndex
CREATE UNIQUE INDEX "warmup_daily_stats_number_id_date_key" ON "warmup_daily_stats"("number_id", "date");

-- CreateIndex
CREATE INDEX "warmup_templates_type_is_active_idx" ON "warmup_templates"("type", "is_active");

-- CreateIndex
CREATE INDEX "warmup_templates_account_id_idx" ON "warmup_templates"("account_id");

-- AddForeignKey
ALTER TABLE "warmup_pools" ADD CONSTRAINT "warmup_pools_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warmup_numbers" ADD CONSTRAINT "warmup_numbers_pool_id_fkey" FOREIGN KEY ("pool_id") REFERENCES "warmup_pools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warmup_numbers" ADD CONSTRAINT "warmup_numbers_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warmup_conversations" ADD CONSTRAINT "warmup_conversations_pool_id_fkey" FOREIGN KEY ("pool_id") REFERENCES "warmup_pools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warmup_conversations" ADD CONSTRAINT "warmup_conversations_number_a_id_fkey" FOREIGN KEY ("number_a_id") REFERENCES "warmup_numbers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warmup_conversations" ADD CONSTRAINT "warmup_conversations_number_b_id_fkey" FOREIGN KEY ("number_b_id") REFERENCES "warmup_numbers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warmup_messages" ADD CONSTRAINT "warmup_messages_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "warmup_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warmup_messages" ADD CONSTRAINT "warmup_messages_sender_id_fkey" FOREIGN KEY ("sender_id") REFERENCES "warmup_numbers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warmup_messages" ADD CONSTRAINT "warmup_messages_receiver_id_fkey" FOREIGN KEY ("receiver_id") REFERENCES "warmup_numbers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warmup_daily_stats" ADD CONSTRAINT "warmup_daily_stats_number_id_fkey" FOREIGN KEY ("number_id") REFERENCES "warmup_numbers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warmup_templates" ADD CONSTRAINT "warmup_templates_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
