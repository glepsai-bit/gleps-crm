-- AUDIT-CYCLE-RACE: reabertura concorrente (duas msgs inbound quase
-- simultâneas numa conversa resolvida) criava 2 ConversationCycle abertos —
-- um deles ficava órfão eterno (resolvedAt NULL) inflando totalCycles/
-- openCycles nas métricas. Índice único parcial garante no máximo 1 ciclo
-- aberto por conversa (mesma técnica usada para conversations na 0028).

-- Saneamento antes do índice: mantém o ciclo aberto mais recente de cada
-- conversa e fecha os órfãos duplicados como resolved_by='system'.
WITH ranked AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY conversation_id
           ORDER BY opened_at DESC, id DESC
         ) AS rn
  FROM conversation_cycles
  WHERE resolved_at IS NULL
)
UPDATE conversation_cycles c
SET resolved_at = now(),
    resolved_by = 'system',
    duration_sec = GREATEST(0, EXTRACT(EPOCH FROM (now() - c.opened_at)))::int,
    resolve_reason = 'auto-close: ciclo duplicado órfão (migration 0051)'
FROM ranked r
WHERE c.id = r.id
  AND r.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS "conversation_cycles_one_open_per_conversation"
ON "conversation_cycles" ("conversation_id")
WHERE "resolved_at" IS NULL;
