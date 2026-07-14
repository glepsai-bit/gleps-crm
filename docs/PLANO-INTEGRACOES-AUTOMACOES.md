# Plano de Ação — Módulo de Integrações & Automações (GLEPS CRM)

> **Objetivo**: transformar a página `/admin/integracoes` num módulo de automação
> funcional e simples — nível Chatwoot, porém melhorado — onde o admin da conta
> gera credenciais e cria regras "quando X acontecer → dispara webhook" sem
> precisar de super_admin nem de chamadas manuais de API.
>
> Branch: `Variação-Principal` · Repo: `github.com/glepsai-bit/gleps-crm`

---

## 1. Diagnóstico (tudo confirmado no código, não é suposição)

### 1.1 🔴 CRÍTICO — `message.created` não é assinável pela UI
O backend **emite** `message.created` (`backend/src/services/message.service.ts:588`),
mas a lista de eventos do frontend (`src/services/webhooks.backend.service.ts:31-46`)
**não o inclui**. Resultado: **é impossível criar pela tela a automação principal**
("chegou mensagem → dispara a IA/n8n"). O backend aceita (o Zod é
`z.array(z.string())`, sem enum), mas a UI não oferece a opção.

### 1.2 🔴 CRÍTICO — 5 dos 7 eventos da UI são FANTASMAS
A UI oferece 7 eventos; **5 nunca são emitidos** pelo backend:

| Evento | Está na UI? | Backend emite? |
|---|---|---|
| `contact.created` | sim | **NÃO** |
| `contact.updated` | sim | **NÃO** |
| `sale.paid` | sim | **NÃO** |
| `conversation.created` | sim | **NÃO** |
| `conversation.resolved` | sim | **NÃO** |
| `campaign.completed` | sim | sim |
| `optout.created` | sim | sim |
| **`message.created`** | **NÃO** | **sim** |
| `sla.breached` | **NÃO** | sim |

O usuário assina e **nunca recebe nada** — sem nenhum erro/aviso.

### 1.3 🔴 CRÍTICO — Risco de LOOP INFINITO
`message.created` é emitido para **TODA** mensagem criada, inclusive as do
próprio bot (`senderType: 'ai_bot'`) e dos agentes. Sem filtro:

```
Cliente manda msg → webhook → IA responde
  → a resposta da IA gera message.created → webhook → IA responde a si mesma
    → ∞  (loop: queima créditos de LLM e spamma o cliente)
```

A assinatura de webhook **não tem filtros/condições** hoje
(`model WebhookSubscription` só tem `events[]`).

### 1.4 🟠 API Key só existe no painel de super_admin
O backend **já permite admin** criar chave
(`backend/src/routes/api-key.routes.ts` → `requireRole('super_admin','admin')`),
mas a única tela é `/super-admin/accounts/:accountId/api-keys`, inacessível ao
admin da conta. **Falta apenas a UI.** Formato da chave: `glk_<40 hex>`.

---

## 2. Estrutura final da página `/admin/integracoes`

Hoje são 4 abas: `Webhooks de Saída` · `Webhooks de Entrada` · `IA` · `Logs`.
Passa a ser **3 abas**, organizadas pelo modelo mental do operador:

```
Integrações
│
├─ 🔗 Automações
│    ├─ Regras            → "Quando [gatilho] + Se [condições] → Dispara webhook [URL]" + [Testar]
│    └─ Webhooks entrada  → handlers de entrada (conteúdo atual, sem mudança funcional)
│
├─ 🔑 Chaves de API
│    ├─ Chaves do CRM (você GERA)    → glk_xxx  [Gerar chave] · pro n8n/ERP acessarem nossos endpoints
│    └─ Provedores de IA (você COLA) → OpenAI / Anthropic · pro CRM consumir IA  (conteúdo da aba "IA" atual)
│
└─ 📜 Logs → auditoria das entregas (conteúdo atual, sem mudança)
```

> **Atenção de UX**: dentro de "Chaves de API" as duas seções são **opostas**
> (uma o CRM gera pra fora consumir; a outra o CRM consome de fora). Devem ter
> títulos e descrições explícitas pra não confundir.

---

## 3. Backend — o que criar/alterar

### 3.1 Migration `0054_add_webhook_filters` (aditiva, idempotente)

```sql
-- Filtros/condições por assinatura. Sem isso, message.created dispara para
-- as mensagens do proprio bot e cria loop infinito da IA respondendo a si mesma.
ALTER TABLE "webhook_subscriptions"
  ADD COLUMN IF NOT EXISTS "filters" JSONB NOT NULL DEFAULT '{}'::jsonb;
```

**`schema.prisma`** → `model WebhookSubscription`:
```prisma
  filters        Json      @default("{}")
```

Shape do `filters` (validar com Zod no controller):
```ts
{
  senderTypes?: ('customer' | 'agent' | 'ai_bot' | 'system' | 'integration')[],
  excludePrivate?: boolean,   // ignora notas internas
  inboxIds?: string[],        // só destes inboxes
}
```

### 3.2 Catálogo único de eventos (fonte da verdade)

Criar `backend/src/config/webhook-events.ts`:

```ts
export const WEBHOOK_EVENTS = [
  { value: 'message.created',       label: 'Mensagem recebida',    group: 'Atendimento' },
  { value: 'conversation.created',  label: 'Conversa criada',      group: 'Atendimento' },
  { value: 'conversation.resolved', label: 'Conversa resolvida',   group: 'Atendimento' },
  { value: 'contact.created',       label: 'Contato criado',       group: 'CRM' },
  { value: 'contact.updated',       label: 'Contato atualizado',   group: 'CRM' },
  { value: 'sale.paid',             label: 'Venda paga',           group: 'Vendas' },
  { value: 'sla.breached',          label: 'SLA estourado',        group: 'Atendimento' },
  { value: 'optout.created',        label: 'Opt-out recebido',     group: 'WhatsApp' },
  { value: 'campaign.completed',    label: 'Campanha concluída',   group: 'WhatsApp' },
  { value: 'campaign.cancelled',    label: 'Campanha cancelada',   group: 'WhatsApp' },
] as const;

export type WebhookEventValue = typeof WEBHOOK_EVENTS[number]['value'];
export const WEBHOOK_EVENT_VALUES = WEBHOOK_EVENTS.map(e => e.value);
```

- `webhook-outbound.controller.ts`: trocar `z.array(z.string())` por
  `z.array(z.enum(WEBHOOK_EVENT_VALUES))` — impede assinar evento inexistente.
- O frontend consome a MESMA lista (ver 4.1), acabando com a divergência.

### 3.3 Emitir os eventos que hoje são FANTASMAS

Adicionar `webhookOutboundService.emit(...)` — sempre **fire-and-forget**
(`.catch(() => …)`, nunca bloquear/lançar), seguindo o padrão já usado em
`message.service.ts:587`:

| Evento | Onde emitir | Payload mínimo |
|---|---|---|
| `conversation.created` | `conversation.service.ts` → após criar conversa (inclusive em `findOrCreateForCustomer`) | `{ id, contactId, inboxId, status, createdAt }` |
| `conversation.resolved` | `conversation.service.ts` → no `resolve()` | `{ id, contactId, resolvedBy, outcome, resolvedAt }` |
| `contact.created` | `contact.service.ts` → `create()` **e** `conversation.service.resolveOrCreateContact` (contato criado pelo webhook) | `{ id, nome, telefone, email, origem, createdAt }` |
| `contact.updated` | `contact.service.ts` → `update()` | `{ id, nome, telefone, email, updatedAt }` |
| `sale.paid` | `sale.service.ts` → quando `status` vira `paid` | `{ id, contactId, valor, paidAt }` |

### 3.4 Aplicar os filtros no `emit`

Em `backend/src/services/webhook-outbound.service.ts`, no `emit(accountId, eventType, payload)`:
depois de buscar as assinaturas que têm o evento, **filtrar** cada uma antes de
enfileirar a entrega:

```ts
function matchesFilters(eventType: string, payload: any, filters: any): boolean {
  if (!filters || Object.keys(filters).length === 0) return true;

  // Só se aplica a eventos de mensagem
  if (eventType === 'message.created') {
    if (Array.isArray(filters.senderTypes) && filters.senderTypes.length > 0) {
      if (!filters.senderTypes.includes(payload.senderType)) return false;
    }
    if (filters.excludePrivate === true && payload.isPrivate === true) return false;
  }

  if (Array.isArray(filters.inboxIds) && filters.inboxIds.length > 0) {
    if (payload.inboxId && !filters.inboxIds.includes(payload.inboxId)) return false;
  }

  return true;
}
```

> **Anti-loop**: a UI cria a regra com `senderTypes: ['customer']` e
> `excludePrivate: true` **ligados por padrão**. Assim a resposta da própria IA
> (`ai_bot`) nunca re-dispara o webhook.

### 3.5 Sem mudança necessária em API Keys
`POST/GET/DELETE /api/api-keys/...` já aceitam `admin`. **Só falta a UI.**

---

## 4. Frontend — o que criar/alterar

### 4.1 `src/services/webhooks.backend.service.ts`
- Substituir a lista hardcoded `WEBHOOK_EVENTS` pela lista **completa e correta**
  (espelho de `backend/src/config/webhook-events.ts`), incluindo
  **`message.created`** ⭐, `sla.breached` e `campaign.cancelled`.
- Adicionar `filters` no tipo `WebhookSubscription` / `CreateWebhookInput`.

### 4.2 `src/services/api-keys.backend.service.ts` (**novo**)
Cliente para `/api/api-keys`:
- `listApiKeys(accountId)` → `GET /api/api-keys/accounts/:accountId`
- `createApiKey(accountId, { name })` → `POST` (retorna a chave em **plaintext UMA VEZ**)
- `revokeApiKey(id)` → `DELETE /api/api-keys/:id`

### 4.3 `src/pages/admin/AdminIntegracoesPage.tsx` — reestruturar em 3 abas

**Aba "Automações"**
- Renomeia a atual "Webhooks de Saída"; mantém toda a lógica de CRUD já existente.
- Formulário no formato **Quando / Se / Então**:
  - **Quando**: multi-select de eventos (agrupados por `group`), com
    `message.created` em destaque.
  - **Se (condições)** — só aparece quando `message.created` estiver marcado:
    - ☑️ **Apenas mensagens de clientes** (`senderTypes: ['customer']`) — **default LIGADO**
      · texto de ajuda: *"Impede que a resposta da própria IA dispare a automação de novo (loop)."*
    - ☑️ **Ignorar notas internas** (`excludePrivate: true`) — **default LIGADO**
    - ☐ **Apenas destes inboxes** (`inboxIds[]`) — multi-select opcional
  - **Então**: `URL do webhook` (campo já existente) + `active`
- Botão **"Testar conexão"** por regra → `POST /api/webhooks/:id/test` (**já existe no backend**);
  mostrar status/latência da resposta.
- Ao criar, exibir o **secret** (HMAC) uma única vez, com botão **Copiar**.
- Sub-seção **"Webhooks de entrada"** (o conteúdo da aba `entrada` atual) dentro
  desta mesma aba.

**Aba "Chaves de API"** (nova)
- Seção **"Chaves do CRM"**:
  - Título/descrição: *"Gere uma chave para que sistemas externos (n8n, ERP) acessem os endpoints do CRM."*
  - Tabela: nome, prefixo (`glk_xxxxxxx…`), criada em, último uso, [Revogar]
  - Botão **"Gerar chave"** → dialog com nome → mostra a chave **em plaintext uma única vez**,
    com botão **Copiar** e aviso *"guarde agora, não será exibida novamente"*.
- Seção **"Provedores de IA"**:
  - Move **integralmente** o componente `AbaIA` atual (OpenAI/Anthropic).
  - Título/descrição: *"Cole a chave do provedor para o CRM consumir IA."*

**Aba "Logs"**
- Sem mudanças (auditoria das entregas).

**Remover** a aba `IA` isolada (o conteúdo migra para "Chaves de API").

### 4.4 Guia rápido na aba Automações (opcional, alto valor)
Um card colapsável **"Como conectar o n8n"** com os 3 passos:
1. Gere a chave em **Chaves de API** → `GLEPS_API_KEY`
2. Crie a regra *Mensagem recebida (só clientes)* apontando pra URL do n8n → copie o **secret** → `GLEPS_WEBHOOK_SECRET`
3. Clique **Testar conexão**

---

## 5. Critérios de validação (não commitar sem isso)

**Automatizado**
- [ ] `tsc --noEmit` limpo (backend e frontend)
- [ ] `vitest` backend verde (suite completa)
- [ ] `vitest` frontend verde
- [ ] Migration `0054` aplicada no DB de teste

**Funcional (em produção, após rebuild)**
- [ ] Gerar uma API key pela UI (como **admin**, não super_admin) → chave `glk_` exibida uma vez
- [ ] Criar automação: **Mensagem recebida** + *só clientes* + URL do n8n
- [ ] Clicar **Testar conexão** → n8n responde **200**
- [ ] Cliente envia msg no WhatsApp → webhook dispara **1×** (verificar em Logs)
- [ ] **IA responde** → **NÃO** dispara webhook de novo (**anti-loop confirmado**) ← *o teste mais importante*
- [ ] Criar/resolver conversa, criar contato, marcar venda paga → os respectivos
      eventos aparecem em **Logs** (prova que os "eventos fantasma" agora existem)

---

## 6. Riscos e cuidados

- **Migration**: puramente aditiva (`ADD COLUMN IF NOT EXISTS`, com default `'{}'`).
  Sem impacto em dados existentes. Assinaturas antigas ficam com `filters = {}`
  (= sem filtro = comportamento atual preservado).
- **Emits novos**: sempre **fire-and-forget** com `.catch()`. Se o webhook falhar,
  **nunca** pode quebrar o fluxo de negócio (criar contato, resolver conversa, pagar venda).
- **Retrocompatibilidade**: assinaturas já criadas continuam funcionando; os
  eventos que elas assinam (fantasmas) passam a **de fato** disparar — avisar o
  usuário disso, pois é uma mudança de comportamento (agora vão receber tráfego).
- **Enum de eventos**: ao trocar `z.string()` por `z.enum(...)`, assinaturas com
  eventos inválidos legados podem falhar na edição. Fazer uma limpeza/migração
  suave ou aceitar valores desconhecidos no *update* (validar só no *create*).

---

## 7. Resumo do que será entregue

**Backend**
- `backend/prisma/migrations/0054_add_webhook_filters/migration.sql` *(novo)*
- `backend/prisma/schema.prisma` — campo `filters` em `WebhookSubscription`
- `backend/src/config/webhook-events.ts` *(novo — catálogo único)*
- `backend/src/services/webhook-outbound.service.ts` — aplicar filtros no `emit`
- `backend/src/controllers/webhook-outbound.controller.ts` — validar `filters` + enum de eventos
- `backend/src/services/conversation.service.ts` — emitir `conversation.created` / `conversation.resolved` / `contact.created`
- `backend/src/services/contact.service.ts` — emitir `contact.created` / `contact.updated`
- `backend/src/services/sale.service.ts` — emitir `sale.paid`

**Frontend**
- `src/services/webhooks.backend.service.ts` — lista de eventos correta + `filters`
- `src/services/api-keys.backend.service.ts` *(novo)*
- `src/pages/admin/AdminIntegracoesPage.tsx` — 3 abas (Automações · Chaves de API · Logs),
  formulário Quando/Se/Então, condições anti-loop, botão Testar, geração de API key

**Resultado para o usuário**: abre **Integrações** → gera a chave (1 clique) →
cria a regra *"Mensagem recebida (só clientes) → webhook do n8n"* → clica
**Testar** → **pronto**. Sem super_admin, sem curl, sem loop.
