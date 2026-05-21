# Banco de dados (Prisma / PostgreSQL)

Schema único: [backend/prisma/schema.prisma](../../backend/prisma/schema.prisma).
Migrations: `backend/prisma/migrations/0001..0020`. Provider: PostgreSQL.

## Convenções
- IDs `uuid`. Timestamps `timestamptz`. Campos no client em camelCase, `@map("snake_case")` no banco.
- **`accountId` em quase toda tabela** → multi-tenancy. Sempre escopar por conta.
- `onDelete: Cascade` na maioria das relações com `Account` (apagar conta limpa tudo).

## Grupos de modelos

**Tenancy & auth**
- `Account` — tenant. Guarda limites + TODAS as credenciais de integração (Chatwoot, Google, SendGrid, OpenAI). Status: active/paused/cancelled.
- `User` — papel super_admin/admin/agent, `permissions String[]`, `chatwootAgentId`.
- `RefreshToken`.

**CRM core**
- `Contact` (lead) — origem, segmentação (nicho/cidade/estado), vínculo Chatwoot (contactId/conversationId), follow-up count, `firstResolvedAt`.
- `Funnel` → `Tag` (type stage|operational, espelha label Chatwoot) → `LeadTag` (contato↔tag) → `TagHistory` (auditoria imutável).
- `LeadNote` — anotações por contato.
- `Event` — event sourcing/auditoria genérica (eventType, actor, entity, payload Json).

**Vendas**
- `Product`, `Sale` (status, método pgto, estorno, recorrência) → `SaleItem`.

**Agenda**
- `CalendarEvent` (+ `CalendarAttendee`), `GoogleCalendarToken`.

**Atendimento/métricas**
- `ResolutionLog` — log de conversas resolvidas no Chatwoot (base das métricas).

**Prospecção**
- `ApiUsageLog` (cota maps/mês), `DispatchBatch` → `DispatchLog`, `ProspectingAudience` → `ProspectingAudienceLead`.

**E-mail** (subsistema maior)
- `EmailCampaign` → `EmailCadence` → `EmailCadenceStep` (com `EmailTemplate` opcional) → `EmailEnrollment` → `EmailSend`.
- `EmailCadenceRule` — ramificação entre cadências por evento.
- `EmailAudience` (+ `EmailAudienceContact` junction), `EmailInboxMessage` (inbound).
- Enums de status: `EmailEnrollmentStatus`, `EmailSendStatus`.

## Comandos Prisma (rodar dentro de /backend)
```sh
npx prisma migrate dev --name <nome>   # cria migration em dev
npx prisma migrate deploy              # aplica em produção
npx prisma generate                    # regenera client após editar schema
npx prisma studio                      # GUI
npm run seed                           # (ver package.json) popula super admins
```
Scripts auxiliares: [backend/scripts/migrate.sh](../../backend/scripts/migrate.sh), `start.sh`.
