-- Allow multiple resolutions per conversation (one row per resolution cycle)
-- Drop the unique index that limited to 1 resolution per (account_id, conversation_id)
DROP INDEX IF EXISTS "resolution_logs_account_id_conversation_id_key";

-- Replace with a non-unique composite index for fast lookups by conversation
CREATE INDEX IF NOT EXISTS "resolution_logs_account_conversation_idx"
  ON "resolution_logs"("account_id", "conversation_id", "resolved_at" DESC);
