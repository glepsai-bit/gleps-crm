# API HTTP — Enviar mensagens WhatsApp (IA externa / integrações)

Endpoint genérico para envio de mensagens WhatsApp via Evolution API a partir
de qualquer integração externa (agentes IA, n8n, ERPs como o Pacto, webhooks
de parceiros, etc).

Toda a lógica de resolução de conversa/contato/inbox + circuit breaker IA +
consent + rate-limit fica concentrada em `whatsappSendService` — o caller
externo precisa apenas autenticar com API key e mandar o payload mínimo.

---

## Autenticação

Gere uma API key no painel super-admin:

```
/super-admin/accounts/:id/api-keys
```

Use a chave em UMA das duas formas (a primeira que existir vence):

```
Authorization: Bearer glk_xxxxxxxxxxxxxxxx
```

ou

```
x-api-key: glk_xxxxxxxxxxxxxxxx
```

A chave precisa ter o scope `messages:write` (ou `*`). Chaves apenas de
leitura recebem **401/403** ao tentar disparar — evita exfiltração via key
de leitura.

A API key fica gravada em `metadata.apiKeyId` de cada mensagem para
auditoria.

---

## Endpoint

```
POST https://gleps-crm-v1k.dqnaqh.easypanel.host/api/integrations/whatsapp/send
Content-Type: application/json
```

> Em ambientes white-label próprios use o domínio configurado da conta
> (ex.: `https://crm.fitpark.com.br/api/integrations/whatsapp/send`).

---

## Body (schema)

| Campo            | Tipo                                | Obrigatório                       | Descrição                                                                                            |
| ---------------- | ----------------------------------- | --------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `conversationId` | `uuid`                              | XOR com `phone`                   | Quando a conversa já existe — o CRM resolve telefone + inbox automaticamente.                        |
| `phone`          | `string` (10–20)                    | XOR com `conversationId`          | E.164 ou só dígitos. Cria/recupera contato + conversa.                                               |
| `inboxId`        | `uuid`                              | Opcional (só usado com `phone`)   | Força inbox específico. Sem isso, cai no primeiro inbox WhatsApp ativo da conta.                     |
| `contactName`    | `string`                            | Opcional                          | Nome exibido quando o contato é criado pela primeira vez.                                            |
| `type`           | `'text' \| 'image' \| 'audio' \| 'document'` | sim                       | Tipo da mensagem.                                                                                    |
| `content`        | `string`                            | obrigatório se `type=text`        | Texto. Para `image` é usado como **caption** opcional. `audio` **não aceita** caption.               |
| `mediaUrl`       | `url`                               | XOR com `mediaBase64`             | URL pública da mídia (image/audio/document).                                                         |
| `mediaBase64`    | `string` (data-url ou base64 puro)  | XOR com `mediaUrl`                | Conteúdo da mídia inline. Útil quando não há hosting público.                                        |
| `mimeType`       | `string`                            | Opcional                          | Ex.: `image/jpeg`, `audio/ogg`, `application/pdf`.                                                   |
| `filename`       | `string`                            | Recomendado para `document`       | Nome exibido no chat do destinatário.                                                                |
| `sender_type`    | `'ai_bot' \| 'integration'`         | default `integration`             | `ai_bot` ativa o **circuit breaker IA** (bloqueia se humano já assumiu).                             |
| `metadata`       | `object`                            | Opcional                          | Qualquer JSON; vai parar em `message.metadata` (auditoria/correlação).                               |

### Regras de validação

- **Endereçamento**: exatamente um entre `conversationId` e `phone`.
- **`text`**: exige `content` não vazio.
- **`image` / `document`**: exige `mediaUrl` XOR `mediaBase64`.
- **`audio`**: exige `mediaUrl` XOR `mediaBase64`; ignora `content`.

---

## Exemplos

### 1) Texto

```bash
curl -X POST https://gleps-crm-v1k.dqnaqh.easypanel.host/api/integrations/whatsapp/send \
  -H "Authorization: Bearer glk_demo_xxxxxxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{
    "phone": "5511999998888",
    "contactName": "Maria Silva",
    "type": "text",
    "content": "Olá Maria, sua aula está confirmada para amanhã às 18h."
  }'
```

### 2) Imagem (URL pública)

```bash
curl -X POST https://gleps-crm-v1k.dqnaqh.easypanel.host/api/integrations/whatsapp/send \
  -H "x-api-key: glk_demo_xxxxxxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{
    "conversationId": "8d2b8a51-2e7f-4f7e-9c1a-3b9c0b6f4a11",
    "type": "image",
    "mediaUrl": "https://cdn.fitpark.com.br/promo/junho-2026.jpg",
    "mimeType": "image/jpeg",
    "content": "Promo válida só até 30/06!"
  }'
```

### 3) Imagem (base64)

```bash
curl -X POST https://gleps-crm-v1k.dqnaqh.easypanel.host/api/integrations/whatsapp/send \
  -H "Authorization: Bearer glk_demo_xxxxxxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{
    "phone": "5511999998888",
    "type": "image",
    "mediaBase64": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAA...",
    "filename": "qr-aluno-12345.png",
    "content": "Seu QR de entrada"
  }'
```

### 4) Áudio (URL — voice note)

```bash
curl -X POST https://gleps-crm-v1k.dqnaqh.easypanel.host/api/integrations/whatsapp/send \
  -H "Authorization: Bearer glk_demo_xxxxxxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{
    "conversationId": "8d2b8a51-2e7f-4f7e-9c1a-3b9c0b6f4a11",
    "type": "audio",
    "mediaUrl": "https://cdn.fitpark.com.br/tts/lembrete-aula.ogg",
    "mimeType": "audio/ogg",
    "sender_type": "ai_bot"
  }'
```

### 5) Documento (PDF)

```bash
curl -X POST https://gleps-crm-v1k.dqnaqh.easypanel.host/api/integrations/whatsapp/send \
  -H "Authorization: Bearer glk_demo_xxxxxxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{
    "phone": "5511999998888",
    "type": "document",
    "mediaUrl": "https://cdn.fitpark.com.br/contratos/aluno-12345.pdf",
    "mimeType": "application/pdf",
    "filename": "Contrato-FitPark-12345.pdf",
    "metadata": { "contratoId": "12345", "origem": "pacto-sync" }
  }'
```

---

## Casos de uso

### 1) IA respondendo uma conversa existente

O agente IA já tem o `conversationId` (recebido via webhook de mensagem
recebida) e responde no thread:

```json
{
  "conversationId": "8d2b8a51-2e7f-4f7e-9c1a-3b9c0b6f4a11",
  "type": "text",
  "content": "Posso confirmar sua presença na aula das 18h?",
  "sender_type": "ai_bot"
}
```

> Se um humano já tiver assumido a conversa (`customAttributes.human_active = true`),
> o request retorna **409 / `AI_CIRCUIT_BREAKER_OPEN`** e a mensagem não é enviada
> — o agente IA deve respeitar e parar de falar.

### 2) Disparo para um número novo (cria conversa + contato)

```json
{
  "phone": "5511999998888",
  "contactName": "João Pedro",
  "type": "text",
  "content": "Oi João! Bem-vindo à FitPark. Aqui está seu link de matrícula: https://fp.link/x1Y"
}
```

O CRM:

1. Normaliza o telefone (regras BR).
2. Pega o primeiro inbox WhatsApp ativo da conta (ou `inboxId` informado).
3. Cria contato + conversa (ou reusa se já existia pelo `<digits>@s.whatsapp.net`).
4. Dispara via Evolution e retorna `messageId` + `conversationId`.

### 3) Marketing / transacional via integration

Quando o disparo NÃO vem de IA — boletim, lembrete, cobrança automática:

```json
{
  "phone": "5511999998888",
  "type": "document",
  "mediaUrl": "https://cdn.fitpark.com.br/boletos/jun-2026/12345.pdf",
  "filename": "Boleto-Junho-2026.pdf",
  "sender_type": "integration",
  "metadata": { "campanha": "boleto-mensal", "competencia": "2026-06" }
}
```

`sender_type=integration` **não** dispara o circuit breaker IA — disparos
transacionais continuam mesmo se um humano estiver no atendimento.

---

## Respostas

### 200 — `sent`

```json
{
  "messageId": "f9d3e9a4-9f12-4f1b-8a2d-2b0c4e6a9e5e",
  "conversationId": "8d2b8a51-2e7f-4f7e-9c1a-3b9c0b6f4a11",
  "status": "sent",
  "externalId": "ABCD1234FEDCBA",
  "deliveredAt": "2026-06-25T14:32:10.512Z",
  "contactId": "1d4a7e22-1234-4abc-9def-aaaaaaaaaaaa"
}
```

### 200 — `failed` (mensagem persistida, dispatch quebrou)

```json
{
  "messageId": "f9d3e9a4-9f12-4f1b-8a2d-2b0c4e6a9e5e",
  "conversationId": "8d2b8a51-2e7f-4f7e-9c1a-3b9c0b6f4a11",
  "status": "failed",
  "externalId": null,
  "deliveredAt": null,
  "contactId": "1d4a7e22-1234-4abc-9def-aaaaaaaaaaaa",
  "error": {
    "code": "EVOLUTION_DISPATCH_FAILED",
    "message": "connection refused"
  }
}
```

> A mensagem **fica gravada** em status `failed` — pode ser re-tentada via
> `POST /api/messages/:id/retry` sem duplicar.

### 400 — Validação

```json
{
  "error": "ValidationError",
  "message": "Payload inválido",
  "details": { "issues": [ ... Zod ... ] }
}
```

### 401 — Autenticação

```json
{ "error": "UnauthorizedError", "message": "API key inválida ou revogada" }
```

### 403 — Scope insuficiente / opt-out / rate-limit

| Código                  | Quando                                                                                |
| ----------------------- | ------------------------------------------------------------------------------------- |
| `MISSING_SCOPE`         | API key sem `messages:write`                                                          |
| `CONTACT_OPTED_OUT`     | Contato pediu para não receber (envia `STOP/PARAR`)                                   |
| `CONSENT_REQUIRED`      | Política da conta exige opt-in explícito e o contato ainda não consentiu              |
| `RATE_LIMIT_EXCEEDED`   | Burst por telefone normalizado — retornado com `waitMs`                               |

### 409 — Conflito de circuit breaker

```json
{
  "error": "ConflictError",
  "message": "Circuit breaker IA aberto — humano assumiu o atendimento",
  "details": { "code": "AI_CIRCUIT_BREAKER_OPEN" }
}
```

Aplica-se apenas quando `sender_type=ai_bot`. Use `sender_type=integration`
para fluxos transacionais que devem ignorar essa proteção.

### 422 — Negócio

| Código                  | Quando                                                                                |
| ----------------------- | ------------------------------------------------------------------------------------- |
| `NO_WHATSAPP_INBOX`     | Conta não tem nenhum inbox WhatsApp ativo configurado                                 |
| `CHANNEL_NOT_SUPPORTED` | A conversa/inbox alvo não é WhatsApp                                                  |

---

## Disparos em massa — `/campaigns/*`

> Contrato mantido da API antiga de campanhas (`whatsapp-campaign`, apagado em
> 10/10/2026). Por baixo, cada `send-batch` vira um **disparo** do motor
> único (`docs/DISPAROS.md`): rodízio entre números aquecidos, ritmo 20–60 s,
> janela 08h–20h no fuso da conta, opt-out/duplicados/inválidos fora já na
> criação, respostas atendidas pelo agente de IA do inbox. O que o motor decide
> sozinho **não é mais configurável por request** — ver `delaySeconds` abaixo.

| Método | Rota | Scope |
| ------ | ---- | ----- |
| `POST` | `/api/integrations/whatsapp/campaigns/send-batch` | `campaigns:write` |
| `POST` | `/api/integrations/whatsapp/campaigns/send-single` | `campaigns:write` ou `messages:write` |
| `GET`  | `/api/integrations/whatsapp/campaigns/batches` | `campaigns:read` ou `campaigns:write` |
| `GET`  | `/api/integrations/whatsapp/campaigns/batches/:id` | `campaigns:read` ou `campaigns:write` |

### `POST /campaigns/send-batch`

| Campo              | Tipo                                           | Obrigatório                | Descrição                                                                                       |
| ------------------ | ---------------------------------------------- | -------------------------- | ----------------------------------------------------------------------------------------------- |
| `contactIds`       | `string[]` (até 1000)                          | XOR/AND com `phones`       | Contatos da conta. Ids de outra conta são **ignorados** (não dão erro).                        |
| `phones`           | `(string \| {phone, name?, variables?})[]` (até 1000) | XOR/AND com `contactIds` | `phone` só dígitos (10–15). `variables` são por destinatário (`{{valor}}`, `{{dias}}`…).   |
| `content`          | `string`                                       | XOR com `templateId`       | Texto. Aceita `{{nome}}`, `{{primeiro_nome}}`, `{{empresa}}` + as variáveis enviadas. `message` é alias. |
| `templateId`       | `uuid`                                         | XOR com `content`          | Mensagem salva da conta (404 se não existir).                                                   |
| `defaultVariables` | `object`                                       | Opcional                   | Variáveis para todos os destinatários (as de cada `phones[i].variables` têm prioridade).       |
| `scheduledAt`      | ISO 8601                                       | Opcional                   | **Precisa ser futuro** (senão 400). Ausente = começa agora (dentro da janela 08h–20h).          |
| `delaySeconds`     | `int`                                          | Opcional                   | **Aceito e IGNORADO.** O ritmo é fixo: 20–60 s entre envios, por número.                        |
| `triggerName`      | `string` (≤120)                                | Opcional                   | Nome do disparo na tela e filtro em `GET /batches`.                                             |
| `campaignType`     | `string` (≤80)                                 | Opcional                   | Classificação livre; volta em `metadata.campaign_type` e filtra em `GET /batches`.              |
| `inboxId`          | `uuid`                                         | Opcional                   | Número (inbox WhatsApp) que dispara. Sem isso: a **primeira inbox WhatsApp conectada** da conta. |
| `metadata`         | `object`                                       | Opcional                   | Qualquer JSON; volta em `metadata` do lote. `metadata.campaign_type` também vale como `campaignType`. |
| `source`           | `'api' \| 'n8n' \| 'integration'`              | Opcional (default `api`)   | Origem gravada no disparo.                                                                      |

```bash
curl -X POST https://gleps-crm-v1k.dqnaqh.easypanel.host/api/integrations/whatsapp/campaigns/send-batch \
  -H "x-api-key: glk_demo_xxxxxxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{
    "phones": [
      { "phone": "5511999998888", "name": "Maria", "variables": { "dias": "3" } },
      "5511977776666"
    ],
    "content": "Oi {{primeiro_nome}}, seu plano vence em {{dias}} dias. Quer renovar?",
    "triggerName": "renovacao",
    "campaignType": "retencao",
    "scheduledAt": "2026-10-11T09:00:00-03:00",
    "metadata": { "competencia": "2026-10" }
  }'
```

**201**

```json
{ "data": { "batchId": "0d2b8a51-2e7f-4f7e-9c1a-3b9c0b6f4a11", "totalContacts": 2, "scheduled": true } }
```

`batchId` é o id do disparo (aparece em `/admin/disparos`). `totalContacts`
conta tudo que entrou (inclusive os que o motor pulou por opt-out, repetição ou
telefone inválido); `scheduled` é `true` quando `scheduledAt` ficou no futuro.

Erros: **400** payload inválido / `scheduledAt` no passado / nenhum
destinatário válido ("Ninguém para receber…"); **401** chave inválida;
**403** chave sem `campaigns:write`; **404** `templateId` inexistente;
**422 `NO_WHATSAPP_INBOX`** conta sem inbox WhatsApp conectada.

### `GET /campaigns/batches`

Query: `status` (`scheduled | running | paused | completed | cancelled`),
`source`, `triggerName`, `campaignType`, `fromDate`, `toDate`, `q`,
`limit` (≤500, default 200), `offset`. `status`/`source`/`campaignType`
aceitam repetição (`?status=running&status=paused`). Disparos criados pela
tela não carregam `source` (saem como `manual`) e não casam com o filtro
`source`.

```json
{
  "data": [
    {
      "id": "0d2b8a51-…",
      "accountId": "…",
      "keyword": null,
      "location": null,
      "totalContacts": 2,
      "sentCount": 1,
      "failedCount": 0,
      "status": "running",
      "delaySeconds": null,
      "startedAt": "2026-10-11T12:00:00.000Z",
      "completedAt": null,
      "createdAt": "2026-10-10T20:01:11.000Z",
      "scheduledAt": "2026-10-11T12:00:00.000Z",
      "source": "api",
      "triggerName": "renovacao",
      "metadata": { "competencia": "2026-10", "campaign_type": "retencao", "name": "renovacao", "respondedCount": 0, "optOutCount": 0, "skippedCount": 0, "inboxIds": ["…"] },
      "templateId": null,
      "inboxId": null
    }
  ]
}
```

`delaySeconds` é sempre `null` (ritmo fixo) e `inboxId` sempre `null` (os
números do disparo estão em `metadata.inboxIds`). Status do lote:
`agendado→scheduled`, `enviando→running`, `pausado→paused`,
`concluido→completed`, `cancelado→cancelled`.

### `GET /campaigns/batches/:id`

Mesmo objeto acima + `logs`: um por destinatário (até 2000), com
`contactName`, `phone` (normalizado `55DDD9XXXXXXXX`), `inboxName`,
`status`, `errorMessage`, `sentAt`, `createdAt`. Status do envio:
`pendente/enviando→pending`, `enviada/entregue/lida/respondeu→sent`,
`falhou→failed`, `cancelado→cancelled`, `pulado_optout→blocked_optout`,
`pulado_invalido→skipped_invalid_phone`, `pulado_duplicado→skipped_duplicate`.
**404** quando o id é de outra conta.

### `POST /campaigns/send-single`

Uma mensagem de **texto, agora**, pelo mesmo caminho do `/send` (consentimento,
limite por telefone, conversa no Chat) — não cria disparo. Body:
`contactId` ou `phone`, `content` ou `templateId`, `variables?`,
`contactName?`, `inboxId?`, `triggerName?`, `metadata?`.

```json
{ "data": { "batchId": null, "messageId": "…", "conversationId": "…", "contactId": "…", "status": "sent" } }
```

`status` é `sent` ou `failed` (com `error`: mensagem). Para mídia use `/send`.

---

## n8n — Template pronto

Um workflow exemplo (Webhook trigger → Set/normalize → HTTP Request) está
em:

```
backend/docs/n8n/whatsapp-send-template.json
```

Importe no n8n (`Workflows → Import from File`), configure as variáveis de
ambiente abaixo e ative:

| Variável         | Exemplo                                                              |
| ---------------- | -------------------------------------------------------------------- |
| `GLEPS_BASE_URL` | `https://gleps-crm-v1k.dqnaqh.easypanel.host/api`                    |
| `GLEPS_API_KEY`  | `glk_xxxxxxxxxxxxxxxx` (com scope `messages:write`)                  |

O fluxo aceita o seguinte payload no webhook trigger e repassa para o
endpoint oficial:

```json
{
  "phone": "5511999998888",
  "type": "text",
  "content": "mensagem"
}
```

Use o webhook do n8n como camada de tradução quando o sistema-origem (IA
externa, ERP) não consegue chamar a API HTTP do GLEPS diretamente.
