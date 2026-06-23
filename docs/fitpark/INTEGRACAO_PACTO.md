# Integração Pacto → GLEPS CRM (FitPark) — T-022

Este documento descreve como conectar o sistema **Pacto** (gestão de academias) ao **GLEPS CRM** usando o n8n como ponte. A integração usa o handler `pacto_sync` do webhook inbound do CRM e gera **tags automáticas** que disparam cadências de WhatsApp e e-mail.

> **Resumo do fluxo:** n8n lê dados do Pacto → normaliza payload → assina HMAC → POST no webhook inbound do CRM → handler `pacto_sync` cria/atualiza contatos e aplica tags.

---

## 1. Visão geral da arquitetura

```
+--------+        +-----+        +---------------------------+
|  Pacto | <----> | n8n | -----> | GLEPS CRM (webhook inbound) |
+--------+        +-----+        +---------------------------+
                                       │
                                       v
                                  Contatos + Tags + Cadências
```

- O **Pacto** é a fonte de verdade dos alunos, contratos e check-ins.
- O **n8n** consulta a API do Pacto em schedule (ex: 9h diariamente) ou via webhook do próprio Pacto.
- Cada evento normalizado é enviado para `POST /api/integrations/inbound-receive/:accountId/:slug` com HMAC SHA-256 + anti-replay.
- O CRM mantém os contatos atualizados e dispara cadências baseadas nas tags geradas (`churn`, `frequente`, `renovacao-7d`, etc).

---

## 2. Configurar a inbound integration via UI

1. Logue no CRM como **admin da conta**.
2. Menu lateral → **Integrações** (`/admin/integracoes`).
3. Botão **Nova integração**.
4. Preencha:
   - **Slug:** `pacto-fitpark` (use apenas letras minúsculas, números e hífen, 2–80 chars).
   - **Handler:** `Sincronizar com Pacto (FitPark)` (`pacto_sync`).
   - **Secret:** gere com `openssl rand -hex 32` e cole. **Guarde** — não é exibido depois.
   - **Config (JSON):** pode deixar `{}` (sem opções por ora).
5. Após salvar, o painel exibirá a **Webhook URL**, no formato:
   ```
   https://crm.fitpark.com.br/api/integrations/inbound-receive/<ACCOUNT_ID>/pacto-fitpark
   ```
6. Copie a URL e o secret — vão para as **Credentials/Variables** do n8n.

> **Importante:** integrações sem secret são bloqueadas em runtime (retornam 401). Sempre configure um secret forte.

---

## 3. Estrutura de payload esperada

Todo evento Pacto é enviado com o shape:

```json
{
  "event": "<tipo>",
  "data": { ... }
}
```

Os eventos suportados são descritos abaixo.

### 3.1 `student.created` / `student.updated`

Upsert de aluno no CRM (cria se não existir, atualiza se existir — lookup priorizado por telefone, fallback por email).

```json
{
  "event": "student.updated",
  "data": {
    "nome": "Maria Souza",
    "telefone": "+5511999998888",
    "email": "maria@example.com",
    "matricula": "ALN-00123",
    "plano": "Premium Anual",
    "dataNascimento": "1992-04-15",
    "status": "ativo"
  }
}
```

- **Obrigatório:** `telefone` **ou** `email` (precisa de ao menos um identificador).
- **Origem do contato no CRM:** `integration`.
- `matricula`/`plano`/`dataNascimento`/`status` são aceitos no payload (e logados), mas **ainda não persistidos** porque o schema atual de `Contact` não tem `customAttributes`. Próxima evolução do schema vai armazenar isso.

### 3.2 `student.churned`

Aluno cancelou. Aplica a tag **`churn`** no contato.

```json
{
  "event": "student.churned",
  "data": {
    "telefone": "+5511999998888",
    "matricula": "ALN-00123"
  }
}
```

- Lookup do contato é por **telefone** (matrícula é aceita mas não buscável no schema atual).
- Se o contato não for encontrado, retorna 404.
- A tag `churn` deve **existir previamente** no CRM (Tags → Nova → slug `churn`). Senão o handler retorna 404 de tag.

### 3.3 `checkin.created`

Aluno fez check-in na academia. Aplica `frequente` e **best-effort remove** `frio` e `churn`.

```json
{
  "event": "checkin.created",
  "data": {
    "telefone": "+5511999998888",
    "matricula": "ALN-00123",
    "checkinAt": "2026-06-23T07:42:00-03:00"
  }
}
```

- A remoção de `frio`/`churn` é tolerante a falhas: se a tag não existir ou não estiver aplicada, o evento ainda é considerado bem-sucedido. Isso evita que um aluno fazendo check-in pela primeira vez quebre o fluxo.

### 3.4 `contract.expiring`

Contrato perto de vencer. Aplica `renovacao-{dias}d` (ex: `renovacao-7d`, `renovacao-30d`).

```json
{
  "event": "contract.expiring",
  "data": {
    "telefone": "+5511999998888",
    "matricula": "ALN-00123",
    "daysUntilExpiry": 7
  }
}
```

- `daysUntilExpiry` deve ser número >= 0 (frações são truncadas).
- Crie previamente as tags que você pretende disparar (`renovacao-7d`, `renovacao-30d`, etc).

### 3.5 Qualquer outro `event`

Retorna **400 Validation Error** com mensagem clara listando os eventos permitidos.

---

## 4. Tags do CRM geradas automaticamente

| Evento Pacto         | Tag aplicada       | Tags removidas (best-effort) | Uso típico em cadência                             |
|----------------------|--------------------|------------------------------|----------------------------------------------------|
| `student.churned`    | `churn`            | —                            | Win-back: ofertas, pesquisa de saída               |
| `checkin.created`    | `frequente`        | `frio`, `churn`              | Engajamento positivo, indicações                    |
| `contract.expiring`  | `renovacao-{N}d`   | —                            | Cadência de renovação (7d antes, 30d antes...)     |
| `student.*`          | (nenhuma — apenas upsert do contato)                                                                                  |

**Pré-requisito:** crie as tags no CRM em **Configurações → Tags** antes de ativar o fluxo n8n. O handler não cria tags inexistentes — retorna 404. (Decisão consciente: evita poluição da taxonomia se o n8n mandar algo errado.)

---

## 5. Importar o template n8n

1. No n8n, **Workflows → Import from File**.
2. Selecione `backend/docs/n8n/pacto-sync-template.json` deste repo.
3. Configure as **Environment Variables** (ou Credentials, conforme sua organização):

   | Variável                  | Exemplo                                                      |
   |---------------------------|--------------------------------------------------------------|
   | `GLEPS_BASE_URL`          | `https://crm.fitpark.com.br/api`                             |
   | `GLEPS_ACCOUNT_ID`        | UUID da conta no CRM                                         |
   | `GLEPS_WEBHOOK_SLUG`      | `pacto-fitpark`                                              |
   | `GLEPS_WEBHOOK_SECRET`    | (o secret gerado no passo 2)                                 |
   | `PACTO_BASE_URL`          | `https://pacto-api.example.com`                              |
   | `PACTO_TOKEN`             | Token Bearer do Pacto                                        |

4. Revise os 4 ramos do fluxo (alunos ativos, check-ins, contratos, cancelamentos). Cada um termina em um POST autenticado para o webhook do CRM.
5. Ative o workflow. O Schedule Trigger roda diariamente às 9h (timezone `America/Sao_Paulo`).

> Para Pacto que oferece webhooks próprios (ex: cancelamento em tempo real), você pode substituir o ramo do schedule por um **Webhook Trigger** do n8n e cair direto no `Map → payload churn`.

---

## 6. HMAC: gerar secret e assinar requests

### 6.1 Gerar o secret

```sh
openssl rand -hex 32
# → 64 hex chars, ex: 9c4f2a3b...
```

Cole no campo **Secret** ao criar a integração inbound no CRM. Guarde com cuidado — não há endpoint que revele de volta.

### 6.2 Assinatura (algoritmo)

Para **cada request**:

1. Pegue o timestamp atual em **epoch ms** (ou ISO-8601 — o servidor aceita ambos):
   ```js
   const ts = String(Date.now()); // ex: "1719158400000"
   ```
2. Capture o **raw body** que vai sair na request — não re-serialize depois!
   ```js
   const body = JSON.stringify(payload);
   ```
3. Assine `${ts}.${body}` com HMAC-SHA-256 hex usando o secret:
   ```js
   const crypto = require('crypto');
   const sig = crypto
     .createHmac('sha256', SECRET)
     .update(ts)
     .update('.')
     .update(body)
     .digest('hex');
   ```
4. Envie os headers:
   ```http
   POST /api/integrations/inbound-receive/<ACCOUNT_ID>/pacto-fitpark
   Content-Type: application/json
   X-Webhook-Timestamp: 1719158400000
   X-Webhook-Signature: <sig>

   <body exatamente como assinado>
   ```

> **Atenção:** qualquer re-serialização do JSON (mudança de espaços, ordem de chaves, escapes Unicode) muda os bytes e quebra a verificação. Sempre envie **o mesmo `body` string que foi assinado**. No n8n use **Body Type: Raw / JSON String**, não o builder de objetos.

### 6.3 Janela anti-replay (±5 minutos)

- O servidor exige que `|Date.now() - tsMs| < 5 * 60 * 1000`. Fora dessa janela retorna **401**.
- Mantenha o clock do n8n sincronizado via NTP.
- Reassine a cada request — **nunca reaproveite assinatura** de um body anterior.

### 6.4 Códigos de erro comuns

| HTTP | Razão                                                                 |
|------|-----------------------------------------------------------------------|
| 401  | Integration sem secret configurado / header timestamp ausente / fora da janela ±5min / HMAC inválido |
| 400  | Header `x-webhook-signature` ausente / payload não-objeto / evento Pacto desconhecido / campos obrigatórios faltando |
| 404  | Integração inexistente ou inativa / contato não encontrado / tag não encontrada |
| 409  | Conflito de identidade (telefone e email apontam para contatos diferentes) |

---

## 7. Smoke test manual

Após configurar tudo, valide via `curl`:

```sh
SECRET="<o secret configurado>"
URL="https://crm.fitpark.com.br/api/integrations/inbound-receive/<ACCOUNT_ID>/pacto-fitpark"

BODY='{"event":"student.created","data":{"nome":"Teste Pacto","telefone":"+5511900000000","matricula":"TST-001","plano":"Mensal"}}'
TS=$(node -e 'console.log(Date.now())')
SIG=$(node -e "const c=require('crypto');console.log(c.createHmac('sha256',process.env.SECRET).update(process.env.TS).update('.').update(process.env.BODY).digest('hex'))" \
  TS=$TS BODY="$BODY" SECRET=$SECRET)

curl -i -X POST "$URL" \
  -H "Content-Type: application/json" \
  -H "X-Webhook-Timestamp: $TS" \
  -H "X-Webhook-Signature: $SIG" \
  --data "$BODY"
```

Esperado: **200 OK** + corpo JSON com `{ "handled": true, "result": { "event": "student.created", "action": "contact_created", "contactId": "...", "details": {...} } }`. Confirme no CRM que o contato apareceu em **Leads** com origem `integration`.

---

## 8. Operação e troubleshooting

- **Logs do CRM:** filtrar por `[inbound-integration]`. Cada handler emite `pacto_sync handled` com `event`, `action`, `contactId`.
- **Logs do n8n:** revise o nó `POST GLEPS (*)` para resposta HTTP. 401/400 = quase sempre HMAC/timestamp; 404 = tag/contato faltando.
- **Reprocessamento:** o handler é idempotente para upsert (mesmo `student.updated` várias vezes não duplica contato). Para `tag_apply` o `applyTag` interno já é tolerante a tag duplicada.
- **Multi-tenancy:** cada conta tem seu próprio slug + secret. Nunca reaproveite secret entre contas.
- **Compliance LGPD:** dados de contato vindos do Pacto são tratados como base própria do cliente; o opt-in WhatsApp continua sendo registrado pelo fluxo padrão do CRM (`whatsapp_consents`).

---

## 9. Próximos passos (T-022 follow-ups)

- Adicionar `Contact.customAttributes` jsonb ao schema pra persistir `matricula`, `plano`, `dataNascimento` vindos do Pacto.
- Permitir lookup por `matricula` (índice em `customAttributes->>'matricula'`).
- Webhook Trigger no n8n para eventos em tempo real do Pacto (cancelamento, primeiro check-in).
- Dashboard FitPark com KPIs: alunos ativos, MRR, churn rate mensal, % de check-ins por aluno.
