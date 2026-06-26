-- CRITICAL #5: schema.prisma declarava @@unique([accountId, telefone])
-- mas a constraint nao existia no DB, permitindo dedupe race em POSTs
-- paralelos (5 inserts simultaneos com mesmo telefone criavam 5 rows).
--
-- Indice parcial (WHERE telefone IS NOT NULL) porque contatos sem
-- telefone sao validos no CRM (email-only, prospecting list, etc.)
-- e nao devem colidir entre si por NULL.

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "contacts_account_id_telefone_key"
  ON "contacts"("account_id", "telefone")
  WHERE "telefone" IS NOT NULL;
