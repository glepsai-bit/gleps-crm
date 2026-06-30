-- T-026: criptografia em repouso dos tokens OAuth do Google Calendar.
--
-- Esta migration NÃO altera o schema (colunas access_token/refresh_token
-- continuam TEXT). Ela serve como marker de versão pra registrar quando o
-- comportamento "encrypt-on-write / decrypt-on-read" passou a valer no
-- código de aplicação (backend/src/services/calendar.service.ts).
--
-- A reescrita de registros já existentes (plaintext → AES-256-GCM) é feita
-- pelo script `backend/scripts/encrypt-google-tokens.ts` — rodar
-- manualmente em produção UMA vez após o deploy desta versão.
--
-- O wrapper decrypt() é tolerante a valores plaintext (retorna como-está
-- quando o payload não começa com `v1:`), então a app continua funcionando
-- enquanto o backfill ainda não rodou.

SELECT 1;
