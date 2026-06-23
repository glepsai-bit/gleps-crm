# T-022 FitPark — Roadmap

Branch: `Variação-FitPark` (NUNCA tocar `main` nem `whitelabel/gleps`).
Base: `main@17d3beb`.
Cliente: FitPark (academia).

## Princípio arquitetural

**CRM é autônomo. n8n é opcional.** O CRM funciona 100% sem n8n; n8n só agrega trilhas custom de relacionamento e integrações com sistemas externos (Pacto, ERPs).

**Regra de ouro:** todo disparo de WhatsApp passa pelo endpoint do CRM (`POST /api/campaigns/send-*` ou `POST /api/conversations/:id/messages`). n8n NUNCA chama Evolution direto. Métricas, opt-out e rate-limit aplicam uniformemente.

## Blocos

| Bloco | Conteúdo | Semanas |
|---|---|---|
| 1 | Evolution infra (creds per-account, service, webhook, QR code) | 1-2 |
| 2 | Chat interno (paridade Chatwoot: dept, teams, tags, SLA, custom attrs, canned, mentions, notas, dashboard) | 6-13 |
| 3 | Campanhas WhatsApp (em Prospecção: scheduledAt, templates, transport Evolution, dashboard) | 3-4 |
| 4 | API REST + ApiKey (send-single/batch, contacts, conversations, messages) | 4-5 |
| 5 | Webhook genérico (outbound subscription + inbound `/integrations/inbound/:accountId/:slug`) | 5 |
| 6 | Compliance + anti-ban (consent, opt-out, rate-limit, separação transacional/marketing) | 5-6 |
| 7 | Multi-instância Evolution (pool, round-robin, warming) | 13 |

**Total:** 14-15 semanas reais.

## Sprint 1 (semana 1) — entregáveis

- Schema: `Account.evolutionBaseUrl/ApiKey/Instance`, tabela `ApiKey`
- Migration `0021_add_evolution_and_api_key`
- `backend/src/services/evolution.service.ts` (sendText, sendMedia, sendAudio, getStatus, getQrCode, disconnect)
- `backend/src/services/api-key.service.ts` (generate, hash, validate, list, revoke)
- `backend/src/middlewares/apiKey.middleware.ts` (`requireApiKey`)
- `backend/src/controllers/evolution.controller.ts` + routes (webhook receiver + QR code endpoint)
- `backend/src/controllers/api-key.controller.ts` + routes (CRUD)
- `backend/src/services/account.service.ts` + `account.controller.ts` (mapear novos campos)
- UI super-admin: form Evolution na conta (URL/API key/instance) + botão "Testar" + "QR Code"
- UI super-admin: página "API Keys" da conta (gerar, listar, revogar)

## Fora do sistema (entrega como template n8n em `/docs/n8n/`)

1. AI atendimento (recebe webhook `message.created` → responde via `POST /api/conversations/:id/messages`)
2. Cron aniversário / churn / renovação contrato
3. Sync Pacto → CRM (via webhook inbound)
4. Check-in/no-show (via webhook inbound)
5. Notificação interna equipe (consume outbound)
6. Integrações futuras (Sympla, RD Station, etc.)
