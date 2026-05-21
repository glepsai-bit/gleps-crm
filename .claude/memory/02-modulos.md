# Módulos funcionais

Rotas frontend em [src/App.tsx](../../src/App.tsx). Páginas em [src/pages/](../../src/pages/).
Permissões (chaves) em [src/config/permissions.config.ts](../../src/config/permissions.config.ts).

## Papéis
- **super_admin** — gerencia tenants (contas), usuários globais. Telas em `src/pages/super-admin/`.
- **admin** — dono da conta, todas as permissões dentro da conta. Telas em `src/pages/admin/`.
- **agent** — atendente; permissões granulares definidas por usuário (array `permissions` na tabela `users`).

## Super Admin (`/super-admin/*`)
- Dashboard, Contas (lista + detalhe), Usuários. Cria/configura tenants: limites (usuários, extrações/mês, e-mails/mês e /dia), credenciais Chatwoot/Google/SendGrid/OpenAI por conta.

## Admin / Agent (`/admin/*`)

| Rota | Página | Permissão | O que faz |
|------|--------|-----------|-----------|
| `/admin` | AdminDashboard | dashboard | KPIs de atendimento (métricas Chatwoot) |
| `/admin/kanban` | AdminKanbanPage | kanban | Quadro de leads por estágio de funil (drag de tags) |
| `/admin/leads` | AdminLeadsPage | leads | Lista de contatos/leads, notas, tags, histórico |
| `/admin/sales` | AdminSalesPage | sales | Vendas (itens, status, estorno) |
| `/admin/finance` | AdminFinancePage | finance | Financeiro / faturamento |
| `/admin/products` | AdminProductsPage | products | Catálogo de produtos |
| `/admin/agenda` | AdminAgendaPage | agenda | Calendário + sync Google Calendar |
| `/admin/insights` | AdminInsightsPage | insights | Relatórios / análises |
| `/admin/prospeccao` | AdminExtracaoPage | extracao | Extração de leads do Google Maps + disparo em massa (só admin/super) |
| `/admin/emails` | AdminEmailsPage | emails | Cadências, templates, campanhas, audiências, inbox (só admin/super) |

`/agent` → cai no Kanban.

## Funis e Tags (núcleo do CRM)
- `Funnel` (funis) contém `Tag`s. Tags têm `type`: `stage` (etapa do Kanban) ou `operational`.
- Tags espelham **labels do Chatwoot** (`chatwootLabelId`). `LeadTag` liga contato↔tag; `TagHistory` é log imutável de auditoria (added/removed/created/deleted) com ator e fonte.
- Componentes em [src/components/kanban/](../../src/components/kanban/), hook [useKanbanData.ts](../../src/hooks/useKanbanData.ts).

## Vendas
- `Sale` → `SaleItem` (produtos). Status: pending/paid/refunded/partial_refund. Estorno guarda motivo + quem estornou. Métodos: pix/boleto/débito/crédito/dinheiro/convênio. Suporta recorrência.

## E-mail (módulo grande)
Fluxo: **Campanha** → **Cadência** (sequência) → **Steps** (e-mails por dia) → **Enrollment** (contato inscrito) → **Send** (envio individual via SendGrid). 
- `EmailCadenceRule` permite ramificação entre cadências por evento (ex.: abriu/clicou) com delay/timeout.
- `EmailTemplate`, `EmailAudience`(+ junction), `EmailInboxMessage` (respostas inbound).
- Limites por conta: `monthlyEmailLimit`, `dailyEmailLimit`, `emailBatchSize`, `emailDelayMs`.
- Cron a cada 5 min processa a fila (ver server.ts). Plano original em [.lovable/email-module-plan.md](../../.lovable/email-module-plan.md).

## Prospecção / Extração
- Extrai estabelecimentos do Google Maps (RapidAPI). Salva em `ProspectingAudience` + `ProspectingAudienceLead`.
- Disparo em massa de WhatsApp via Chatwoot: `DispatchBatch` + `DispatchLog`.
- Cota mensal por conta rastreada em `ApiUsageLog` (`monthlyExtractionLimit`).
