-- AlterTable: WarmupPool gets AI fields (opt-in IA por pool)
ALTER TABLE "warmup_pools"
  ADD COLUMN "use_ai" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "ai_provider" VARCHAR(20),
  ADD COLUMN "ai_model" VARCHAR(80),
  ADD COLUMN "ai_tone" VARCHAR(20) DEFAULT 'casual';

-- AlterTable: WarmupMessage trace de fonte do conteudo
ALTER TABLE "warmup_messages"
  ADD COLUMN "content_source" VARCHAR(20) NOT NULL DEFAULT 'template';
