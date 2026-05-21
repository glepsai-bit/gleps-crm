-- Allow multiple resolutions per conversation (one row per resolution cycle)
DROP INDEX IF EXISTS public.resolution_logs_account_id_conversation_id_key;

CREATE INDEX IF NOT EXISTS resolution_logs_account_conversation_idx
  ON public.resolution_logs(account_id, conversation_id, resolved_at DESC);