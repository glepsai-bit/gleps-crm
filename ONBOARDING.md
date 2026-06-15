# 🚀 Onboarding de Cliente — Runbook Completo

> Guia de **entrada de um novo cliente** no GLEPS CRM + Chatwoot + n8n (IA).
> Siga as fases **na ordem**. Marque os `[ ]` conforme executa.
> ⏱️ ~30–45 min por cliente.

---

## 🧠 Modelo mental (leia uma vez — evita 90% da confusão)

Existem **4 comunicações**, em **3 lugares diferentes de configuração**:

```
                    ┌──────────────────────────────────────────┐
   (1) n8n  ──────▶ │  Chatwoot API  (postar msg, ler dados)    │
       configurado no FORM de credenciais (config1)
                    └──────────────────────────────────────────┘
   (2) n8n  ──────▶  Backend /api/chatwoot/log-resolution
       (loga resolução) — usa Backend URL + Webhook secret (FORM)

   (3) Chatwoot ──▶  Backend /api/chatwoot/webhook   ← ENTRADA
       configurado em: Chatwoot → Integrations → Webhooks
       (payload PADRÃO: message_created / conversation_updated / status_changed)

   (4) Chatwoot ──▶  n8n (gatilho da IA)             ← ENTRADA
       configurado em: Chatwoot → Automação (regras)
       (payload AUTOMAÇÃO: body.messages[0], body.custom_attributes)
```

**Regras de ouro:**
1. **(3) e (4) são lugares DIFERENTES** — backend vai em *Integrations → Webhooks*; n8n vai em *Automação*. Formatos de payload diferentes, não dá pra trocar.
2. **O agente da IA NUNCA é importado no CRM.** É isso que separa IA de humano.
3. O **"Webhook secret"** do form é pro item (2) (n8n→backend), **não** é o webhook (3).

---

## 📋 Ficha do cliente (preencha antes de começar)

| Campo | Onde usa | Valor do cliente |
|---|---|---|
| `chatwoot_url` (URL da instância) | CRM + Form n8n | `https://atendimento.________` |
| `chatwoot_account_id` | CRM + Form n8n | `____` |
| **API Token Chatwoot** (admin da conta) | CRM (integração) | `____________` |
| **Token do agente IA** | Form n8n (`chatwoot_token`) | `____________` |
| **Backend URL** | Form n8n + montar webhook | `https://goodleads.mychooice.com` *(fixo)* |
| `CHATWOOT_WEBHOOK_SECRET` | Form n8n (Webhook secret) | `____________` |
| `mcp_endpoint` (Google Calendar) | Form n8n | `https://hook._____/mcp/____` |
| Evolution URL / key / instance | Form n8n | `____ / ____ / Amanda` |
| **URL do webhook do n8n** | Chatwoot → Automação | `https://n8n._____/webhook/____` |

---

## FASE 1 — Chatwoot (base de comunicação)

- [ ] **1.1** Conectar a **inbox de WhatsApp** do cliente.
- [ ] **1.2** Garantir que os **agentes humanos** existem e estão **na inbox**.
- [ ] **1.3** Criar o **agente dedicado da IA**:
  - `Settings → Agents → Add Agent`
  - Nome **padronizado**: `Assistente IA` *(use SEMPRE o mesmo nome em todos os clientes)*
  - E-mail dedicado · Papel: **Agent**
  - Adicionar **à(s) inbox(es)** que ele vai atender
  - Logado como ele: **Profile Settings → Access Token** → copiar → vai no Form (`chatwoot_token`)
  - ❌ **NÃO** adicionar a nenhum **Team** · ❌ **NÃO** importar no CRM

> ⚠️ **Por que não importar no CRM:** o backend identifica humano vs IA pelo `sender.id`. Se a IA for usuária do CRM, ela seria vista como humano e se autodesligaria.

---

## FASE 2 — CRM (logado como **super admin**)

- [ ] **2.1** `Contas → Nova Conta` → nome do cliente, status **active**.
- [ ] **2.2** Ativar **Chatwoot** → preencher `URL` + `Account ID` + `API Token` → **Testar Conexão** (tem que ficar **verde**).
- [ ] **2.3** **Importar Agentes** → criar os usuários do CRM a partir dos **agentes HUMANOS** (definir senha / role / permissões).
  - ❌ **Pular o agente da IA** na importação.
- [ ] **2.4** Confirmar que um humano importado **consegue logar** no CRM.

---

## FASE 3 — Webhook do Chatwoot → **Backend** (Integrations → Webhooks)

> Esse é o que liga: **detecção de humano**, **limpeza na reabertura** e **métricas**.

- [ ] **3.1** Chatwoot → `Settings → Integrations → Webhooks → Adicionar novo webhook`.
- [ ] **3.2** **URL do Webhook:**
  ```
  https://goodleads.mychooice.com/api/chatwoot/webhook
  ```
  *(Backend URL + `/api/chatwoot/webhook`)*
- [ ] **3.3** **Nome:** `Backend GoodLeads`
- [ ] **3.4** Marcar os **eventos** (obrigatórios):
  - ✅ **Mensagem criada** (`message_created`)
  - ✅ **Conversa Atualizada** (`conversation_updated`)
  - ✅ **Status de conversa alterado** (`conversation_status_changed`)
  - *(opcionais p/ sync: `conversation_created`, `contact_created`, `contact_updated`)*
- [ ] **3.5** **Criar webhook.**

> Não precisa de token aqui — o backend identifica o cliente pelo `account.id` do payload.

---

## FASE 4 — Gatilho do Chatwoot → **n8n** (Automação)

> Esse é o que faz a **IA responder**. Lugar **diferente** da Fase 3.

- [ ] **4.1** Chatwoot → `Automação` → recriar as regras que **enviam webhook pro n8n** (replicar o template das 3 regras), apontando pra **URL do webhook do n8n deste cliente**:
  - **Mensagem nova** (gatilho principal da IA)
  - **Resolução** (status → resolvido)
  - **Reabertura** (resolvido → aberto) *(opcional p/ o n8n; a limpeza já é feita pelo backend na Fase 3)*
- [ ] **4.2** Deixar **ativas** as que o fluxo usa.

---

## FASE 5 — n8n (importar o fluxo + credenciais)

- [ ] **5.1** **Importar** o JSON do fluxo (versão com o **circuit breaker corrigido** — lê `$json.body.custom_attributes`).
- [ ] **5.2** Preencher o **Form "Credenciais e integrações"** (vira o `config1`):
  - `URL da instância Chatwoot` · `Account ID`
  - **`API Token Chatwoot` = Access Token do agente IA** ⬅️ *(o pulo do gato)*
  - `Backend URL` = `https://goodleads.mychooice.com` (fixo)
  - `Webhook secret do backend` = `CHATWOOT_WEBHOOK_SECRET` do `.env`
  - `MCP endpoint` · `Evolution URL/key/instance` · `Debounce` (20s)
- [ ] **5.3** No node de **seleção de agente** (round-robin), excluir a IA **por nome** (mesmo código em todo cliente):
  ```js
  const onlineAgents = agents.filter(
    a => a.availability_status === 'online' && !/assistente ia|bot/i.test(a.name)
  );
  ```
- [ ] **5.4** **Ativar** o fluxo · **desativar** versão antiga.

---

## ✅ FASE 6 — Validação (smoke do cliente — 5 checks)

- [ ] **6.1** Mandar msg de teste pelo WhatsApp → **IA responde** e aparece como **"Assistente IA"**. *(token certo + `ai_responded`)*
- [ ] **6.2** Um **humano responde sem clicar "Assumir"** → na próxima msg a **IA cala** (sinal de que `human_active` foi setado). *(prova a Fase 3 + agente dedicado)*
- [ ] **6.3** **Humano resolve** a conversa → conta como **humano** em "Resolução (Quem Fechou)".
- [ ] **6.4** **Reabrir** (cliente manda msg depois de resolvida) → atributos limpos, **IA volta**.
- [ ] **6.5** Dashboard: **Atendimento ao Vivo** separa IA × humano · **Eficiência da IA** ≠ `% IA` · **Backlog "Não atribuídas"** aparece se houver conversa sem dono.

---

## 🔧 Troubleshooting (sintoma → causa → fix)

| Sintoma | Causa provável | Fix |
|---|---|---|
| IA responde, mas some/erra como humano | Agente da IA **foi importado no CRM** | Remover do CRM (ou usar agente dedicado fora do CRM) |
| IA não para quando humano responde | Falta o **webhook da Fase 3** (Integrations→Webhooks) | Criar o webhook do backend com os 3 eventos |
| IA "se desliga sozinha" | IA postando com **identidade de agente humano** | Usar o **token do agente dedicado** no Form |
| Reabertura não limpa atributos | Webhook do backend sem `conversation_updated` | Marcar o evento na Fase 3 |
| IA recebe transferência | IA num **Team** / sem filtro por nome | Tirar de Teams + filtro `!/assistente ia|bot/i` |
| n8n não dispara | Regra de **Automação** ausente/inativa ou URL errada | Conferir Fase 4 (Automação → n8n) |
| n8n recebe payload mas quebra | Apontou n8n pra **Integrations→Webhooks** (formato errado) | n8n vai em **Automação**, não em Webhooks |

---

## 📌 Resumo executável (cola rápida)

1. **Chatwoot:** WhatsApp na inbox · agentes humanos · **agente IA dedicado** (Add Agent, à inbox, pega token, **fora de Team e fora do CRM**).
2. **CRM:** Nova Conta → ativar Chatwoot (Testar = verde) → **Importar só os humanos**.
3. **Integrations → Webhooks:** `{backend}/api/chatwoot/webhook` + 3 eventos.
4. **Automação:** regras → webhook do **n8n** (mensagem nova etc.).
5. **n8n:** importar fluxo → Form (token da IA!) → filtro de agente por nome → ativar.
6. **Smoke:** 5 checks da Fase 6.

> **Trabalho recorrente por cliente** = criar o agente IA (nome padrão) + apontar o token no n8n + os 2 webhooks (backend em Integrations, n8n em Automação). O resto (detecção IA×humano) é automático.
