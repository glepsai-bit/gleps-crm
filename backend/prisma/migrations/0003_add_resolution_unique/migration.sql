-- Step 1: Remove duplicate rows keeping only the oldest record per (account_id, conversation_id) pair
DELETE FROM "resolution_logs" a USING "resolution_logs" b
WHERE a.id > b.id
  AND a.account_id = b.account_id
  AND a.conversation_id = b.conversation_id;

-- Step 2: Now create unique index (safe after deduplication)
CREATE UNIQUE INDEX IF NOT EXISTS "resolution_logs_account_id_conversation_id_key"
  ON "resolution_logs"("account_id", "conversation_id");
