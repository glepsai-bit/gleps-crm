-- UpdateChatwootCredentials
-- Atualiza as credenciais do Chatwoot para todas as contas que já tinham integração parcial.
-- Executada automaticamente pelo prisma migrate deploy no startup do container.

UPDATE accounts
SET chatwoot_base_url = 'https://atendimento.gleps.com.br',
    chatwoot_account_id = '1',
    chatwoot_api_key = 'UjBMtqZSRxPB72qSm8Fi1hh1'
WHERE chatwoot_base_url IS NOT NULL
   OR chatwoot_account_id IS NOT NULL;
