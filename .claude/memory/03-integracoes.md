# Integrações externas

Credenciais são **por conta** (armazenadas na tabela `accounts`), não só em env vars —
permite white-label multi-tenant. Alguns segredos globais ficam em env.

## Chatwoot (atendimento / WhatsApp) — central
- Config por conta: `chatwootBaseUrl`, `chatwootAccountId`, `chatwootApiKey`.
- Backend: [chatwoot.service.ts](../../backend/src/services/chatwoot.service.ts), [chatwoot-metrics.service.ts](../../backend/src/services/chatwoot-metrics.service.ts), [inbox.service.ts](../../backend/src/services/inbox.service.ts), util [chatwoot-stage.util.ts](../../backend/src/utils/chatwoot-stage.util.ts).
- Frontend: [src/services/chatwootApi.ts](../../src/services/chatwootApi.ts), hook [useChatwootMetrics.ts](../../src/hooks/useChatwootMetrics.ts), componentes em [src/components/chatwoot/](../../src/components/chatwoot/).
- **Tags do CRM ↔ labels do Chatwoot** sincronizadas (`chatwootLabelId` em `Tag`).
- **Webhooks** entram em `/api/chatwoot/webhook` e `/api/chatwoot/log-resolution` (pulam rate limit). Conversas resolvidas → tabela `resolution_logs` (base das métricas de resolução).
- `CHATWOOT_WEBHOOK_SECRET` valida assinatura dos webhooks.
- Métricas do dashboard documentadas em [docs/METRICAS_DASHBOARD.md](../../docs/METRICAS_DASHBOARD.md) (fonte de verdade dos cálculos).
- Fluxo n8n de referência: [docs/n8n_flow_resolution.json](../../docs/n8n_flow_resolution.json).

## Google Calendar (OAuth)
- Credenciais OAuth **por conta**: `googleClientId/Secret/RedirectUri` (migration 0006/0007 moveu de env p/ DB, com isolamento por usuário).
- Tokens em `GoogleCalendarToken` (1 por usuário). Eventos em `CalendarEvent` (+ `CalendarAttendee`), com `source` google|crm e `googleEventId` para sync bidirecional.
- Callback OAuth: `/api/calendar/google/callback`.
- Backend: [calendar.service.ts](../../backend/src/services/calendar.service.ts).

## RapidAPI — Google Maps (prospecção)
- `RAPIDAPI_KEY` (env global). Usado para extrair leads de estabelecimentos.
- Cota por conta em `ApiUsageLog` / `monthlyExtractionLimit`.
- Backend: [prospecting.service.ts](../../backend/src/services/prospecting.service.ts), [prospecting-audience.service.ts](../../backend/src/services/prospecting-audience.service.ts).

## SendGrid (e-mail)
- Por conta: `sendgridApiKey`, `sendgridFromEmail`, `sendgridFromName`.
- Backend: [sendgrid.service.ts](../../backend/src/services/sendgrid.service.ts), orquestração em [email.service.ts](../../backend/src/services/email.service.ts).
- Webhooks de eventos/inbound previstos em `/api/email/webhook` e `/api/email/inbound`.

## OpenAI (IA para e-mail)
- Por conta: `openaiApiKey`. Geração/assistência de conteúdo de e-mail.
- Backend: [email-ai.service.ts](../../backend/src/services/email-ai.service.ts).

## Supabase (modo Cloud)
- Cliente em [src/integrations/supabase/](../../src/integrations/supabase/). Usado quando `VITE_USE_BACKEND=false`. Há um stub `client.backend-stub.ts` para o modo backend.
