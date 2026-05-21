-- Step 1: Corrigir ai_participated em resolucoes inferidas (hardcodado como true incorretamente)
UPDATE resolution_logs
SET ai_participated = false
WHERE resolution_type = 'inferred'
  AND ai_participated = true;

-- Step 2: Remover duplicatas (manter o registro mais recente por account_id + conversation_id)
DELETE FROM resolution_logs a
USING resolution_logs b
WHERE a.id < b.id
  AND a.account_id = b.account_id
  AND a.conversation_id = b.conversation_id;

-- Step 3: Garantir unique constraint (pode ja existir da migracao 0003)
CREATE UNIQUE INDEX IF NOT EXISTS "resolution_logs_account_id_conversation_id_key"
  ON resolution_logs(account_id, conversation_id);
