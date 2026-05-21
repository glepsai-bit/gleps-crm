# 📧 Plano Arquitetural — Módulo de E-mails

## Visão Geral
Módulo de cadência de e-mails com assistente de IA, integrado ao funil do Kanban.
Permite criar sequências automatizadas (dia 1, 3, 7...) e gerar mensagens com IA.

---

## 1. ALTERAÇÕES NO BANCO DE DADOS

### 1.1 Novos campos na tabela `accounts`
```sql
ALTER TABLE accounts ADD COLUMN openai_api_key VARCHAR(500);
ALTER TABLE accounts ADD COLUMN sendgrid_api_key VARCHAR(500);
ALTER TABLE accounts ADD COLUMN sendgrid_from_email VARCHAR(255);
ALTER TABLE accounts ADD COLUMN sendgrid_from_name VARCHAR(255);
```

### 1.2 Nova tabela: `email_cadences`
Representa uma cadência (sequência de e-mails automáticos).
```
id               UUID PK
account_id       UUID FK -> accounts
name             VARCHAR(255) — ex: "Prospecção Clínicas"
description      TEXT?
target_stage_ids UUID[] — etapas do funil que ativam esta cadência
active           BOOLEAN default true
created_by       UUID FK -> users
created_at       TIMESTAMPTZ
updated_at       TIMESTAMPTZ
```

### 1.3 Nova tabela: `email_cadence_steps`
Cada passo da cadência (dia 1, dia 3, etc.).
```
id               UUID PK
cadence_id       UUID FK -> email_cadences
day_number       INT — dia do disparo (1, 3, 7, 14...)
subject          VARCHAR(500)
body_html        TEXT
body_text        TEXT?
active           BOOLEAN default true
ordem            INT default 0
created_at       TIMESTAMPTZ
updated_at       TIMESTAMPTZ
```

### 1.4 Nova tabela: `email_enrollments`
Vincula um contato a uma cadência ativa.
```
id               UUID PK
account_id       UUID FK -> accounts
cadence_id       UUID FK -> email_cadences
contact_id       UUID FK -> contacts
current_step     INT default 0 — índice do step atual
status           ENUM('active','paused','completed','unsubscribed','bounced')
enrolled_at      TIMESTAMPTZ
next_send_at     TIMESTAMPTZ? — próximo envio agendado
completed_at     TIMESTAMPTZ?
created_at       TIMESTAMPTZ
```

### 1.5 Nova tabela: `email_sends`
Log de cada e-mail enviado com status de tracking.
```
id               UUID PK
account_id       UUID FK -> accounts
enrollment_id    UUID FK -> email_enrollments
step_id          UUID FK -> email_cadence_steps
contact_id       UUID FK -> contacts
to_email         VARCHAR(255)
subject          VARCHAR(500)
sendgrid_message_id VARCHAR(255)?
status           ENUM('queued','sent','delivered','opened','clicked','bounced','failed','spam')
opened_at        TIMESTAMPTZ?
clicked_at       TIMESTAMPTZ?
bounced_at       TIMESTAMPTZ?
error_message    TEXT?
sent_at          TIMESTAMPTZ?
created_at       TIMESTAMPTZ
```

### 1.6 Nova tabela: `email_templates`
Templates reutilizáveis gerados pela IA ou manualmente.
```
id               UUID PK
account_id       UUID FK -> accounts
name             VARCHAR(255)
subject          VARCHAR(500)
body_html        TEXT
body_text        TEXT?
category         VARCHAR(100)? — ex: "apresentacao", "followup", "proposta"
created_by       UUID FK -> users
created_at       TIMESTAMPTZ
updated_at       TIMESTAMPTZ
```

---

## 2. BACKEND (Express)

### 2.1 Prisma Schema
Adicionar todos os models acima ao `schema.prisma`.

### 2.2 Novos arquivos

| Arquivo | Descrição |
|---------|-----------|
| `controllers/email.controller.ts` | CRUD cadências, steps, templates, enrollments |
| `services/email.service.ts` | Lógica de negócio de cadências |
| `services/sendgrid.service.ts` | Integração SendGrid (envio + webhooks) |
| `services/email-ai.service.ts` | Geração de mensagens com OpenAI |
| `routes/email.routes.ts` | Rotas do módulo |
| `controllers/email-webhook.controller.ts` | Webhook do SendGrid (tracking events) |

### 2.3 Rotas planejadas

```
# Cadências
GET    /api/email/cadences              — listar cadências
POST   /api/email/cadences              — criar cadência
PUT    /api/email/cadences/:id          — atualizar cadência
DELETE /api/email/cadences/:id          — deletar cadência

# Steps (dentro da cadência)
GET    /api/email/cadences/:id/steps    — listar steps
POST   /api/email/cadences/:id/steps   — criar step
PUT    /api/email/steps/:id            — atualizar step
DELETE /api/email/steps/:id            — deletar step

# Templates
GET    /api/email/templates             — listar templates
POST   /api/email/templates             — criar template
PUT    /api/email/templates/:id         — atualizar template
DELETE /api/email/templates/:id         — deletar template

# Enrollments
POST   /api/email/enroll                — inscrever contatos em cadência
POST   /api/email/unenroll              — remover contatos da cadência
GET    /api/email/enrollments           — listar inscrições

# Envios
GET    /api/email/sends                 — histórico de envios
GET    /api/email/sends/stats           — estatísticas de envio

# IA
POST   /api/email/ai/generate           — gerar mensagem com OpenAI

# Webhook SendGrid (público, sem JWT)
POST   /api/email/webhook/sendgrid      — receber eventos de tracking

# Teste de conexão
POST   /api/email/test-connection       — testar credenciais SendGrid
POST   /api/email/test-send             — enviar email teste
```

### 2.4 Worker/Cron de processamento
O backend precisa de um job que roda periodicamente (a cada 5 min):
1. Buscar `email_enrollments` com `status = 'active'` e `next_send_at <= now()`
2. Para cada enrollment, buscar o step correspondente ao `current_step`
3. Enviar e-mail via SendGrid
4. Atualizar `current_step`, calcular próximo `next_send_at`
5. Se foi o último step, marcar como `completed`

### 2.5 SendGrid Webhook Events
O webhook recebe eventos como:
- `delivered` → status = 'delivered'
- `open` → status = 'opened', opened_at = now()
- `click` → status = 'clicked', clicked_at = now()
- `bounce` → status = 'bounced', bounced_at = now()
- `spamreport` → status = 'spam'

---

## 3. FRONTEND

### 3.1 Nova rota
`/admin/emails` → `AdminEmailsPage.tsx`

### 3.2 Permissão
Adicionar `'emails'` ao sistema de permissões.

### 3.3 Componentes

```
src/components/emails/
├── CadenceList.tsx          — lista de cadências com cards
├── CadenceEditor.tsx        — criar/editar cadência e seus steps
├── CadenceStepCard.tsx      — card visual de cada step (Dia 1, Dia 3...)
├── EmailTemplateList.tsx    — biblioteca de templates
├── EmailTemplateEditor.tsx  — editor de template
├── EmailAIAssistant.tsx     — painel lateral com assistente IA
├── EmailFunnelView.tsx      — funil de leads com contagens por etapa
├── EmailLeadsList.tsx       — lista de leads por etapa selecionada
├── EmailSendsHistory.tsx    — histórico de envios com status
├── EmailStatsCards.tsx      — KPIs (enviados, abertos, clicados, bounced)
├── EmailPreview.tsx         — prévia do email antes de enviar
├── index.ts                 — barrel exports
```

### 3.4 Layout da página (baseado na imagem)
```
┌──────────────────────────────────────────────────────────┐
│ E-mails — Cadência automática com assistência de IA      │
│                                          [+ Nova Cadência]│
├──────────────────────────────────────────────────────────┤
│                                                          │
│ ┌── Cadência de Disparo ──────────────────────────────┐  │
│ │ [Dia 1] → [Dia 3] → [Dia 7] → [Dia 14]  [Editar]  │  │
│ └─────────────────────────────────────────────────────┘  │
│                                                          │
│ ┌── Funil de Leads ───────────────┐ ┌── Assistente IA ─┐│
│ │ [Novo Lead 24] [Em Contato 11] │ │ Prévia do Email  ││
│ │ [Respondeu 7] [Sem Resp 18]    │ │ Para: [Lead]     ││
│ │                                 │ │ Assunto: ...     ││
│ │ ● Novo Lead (24)               │ │ Body: ...        ││
│ │  - Roberto Lima                │ │                  ││
│ │  - Ana Costa                   │ │ [Sugestões]      ││
│ │  - Carlos Melo                 │ │ [Gerar]          ││
│ │  + 21 mais leads               │ │ [Enviar Email]   ││
│ │                                 │ │                  ││
│ │ Respostas pré-definidas:       │ │                  ││
│ │ ✉ Apresentação inicial        │ └──────────────────┘│
│ │ ✉ Follow-up automático        │                     │
│ └─────────────────────────────────┘                     │
└──────────────────────────────────────────────────────────┘
```

---

## 4. CREDENCIAIS NA CONTA

### 4.1 Account Detail Page (Super Admin)
Adicionar seção **"Integração OpenAI"** ANTES da seção Chatwoot:
- Toggle de ativação
- Campo: `openai_api_key` (masked)

Adicionar seção **"Integração SendGrid"** DEPOIS de OpenAI:
- Toggle de ativação  
- Campo: `sendgrid_api_key` (masked)
- Campo: `sendgrid_from_email`
- Campo: `sendgrid_from_name`
- Botão: "Testar Conexão"

### 4.2 Ordem visual das integrações:
1. Google Calendar
2. **OpenAI** ← NOVO
3. **SendGrid** ← NOVO
4. Chatwoot

---

## 5. VARIÁVEIS DE AMBIENTE (docker-compose)

```yaml
# Não é necessário — as chaves são por conta (multi-tenant)
# Cada account armazena suas próprias chaves no banco
```

---

## 6. ORDEM DE IMPLEMENTAÇÃO

1. **Migration Prisma** — novos campos em accounts + novas tabelas
2. **Backend Services** — SendGrid, Email AI, Email CRUD
3. **Backend Routes** — Rotas + controller
4. **Account Detail** — Campos OpenAI + SendGrid no frontend
5. **Frontend Page** — AdminEmailsPage com componentes
6. **Worker de Cadência** — Job de processamento automático
7. **Webhook SendGrid** — Tracking de aberturas/cliques

---

## 7. DEPENDÊNCIAS NPM

### Backend
- `@sendgrid/mail` — SDK oficial SendGrid
- `openai` — SDK oficial OpenAI (já pode estar disponível)

### Frontend
- Nenhuma dependência nova necessária

---

## 8. NOTAS TÉCNICAS

- **Multi-tenant**: Cada conta tem suas próprias chaves de SendGrid e OpenAI
- **Segurança**: Chaves armazenadas no DB, nunca expostas ao frontend
- **Rate limiting**: Respeitar limites do SendGrid (100/dia free tier)
- **Variáveis no template**: Suporte a `{nome}`, `{empresa}` nos corpos de email
- **Cadência inteligente**: Se lead mudar de etapa no Kanban, a cadência pode ser pausada/alterada automaticamente
