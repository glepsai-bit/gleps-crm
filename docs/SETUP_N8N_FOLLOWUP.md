# Setup n8n — Follow-up de Comparecimento (Gleps IA)

Fluxo: `docs/n8n_followup_comparecimento.json` (T-020c Sprint 2).

Recebe webhook do CRM no evento `appointment.attendance` e dispara mensagem WhatsApp via Evolution API conforme o `attendanceStatus` (`ATTENDED` / `NO_SHOW` / `RESCHEDULED`).

---

## 1. Importar no n8n

1. n8n da iGreen -> **Workflows** -> **Import from File**.
2. Selecione `n8n_followup_comparecimento.json`.
3. Salve. **Nao ative ainda**.

## 2. Configurar variaveis de ambiente do n8n

No host do n8n (EasyPanel/docker), exporte as variaveis abaixo (ou ajuste o node `config1` direto se preferir hardcode):

```env
EVOLUTION_API_URL=https://evolution.igreen.com.br
EVOLUTION_INSTANCE=gleps
EVOLUTION_API_KEY=<apikey-evolution-da-iGreen>
BACKEND_URL=https://crm.gleps.com.br
GLEPS_WEBHOOK_SECRET=<mesmo-secret-cadastrado-no-painel-Gleps>
```

> O nome `EVOLUTION_*` ja eh o padrao em outros fluxos da iGreen; provavelmente ja existe. So conferir.

Apos setar, reinicie o container n8n (necessario pro `$env` enxergar).

## 3. Pegar a URL do webhook

1. Abra o workflow importado.
2. Clique no node **Webhook CRM**.
3. Copie a **Production URL** (algo como `https://n8n.igreen.com.br/webhook/followup-comparecimento`).
4. **Ative o workflow** (toggle no canto superior direito) — sem ativar, o n8n so expõe a URL de teste.

## 4. Colar no painel Gleps

CRM -> **Integracoes** -> **n8n Webhook URL** -> cole a URL acima -> Salvar.

Se for usar HMAC, gere um secret (`openssl rand -hex 32`), salve em **n8n Webhook Secret** no painel **e** em `GLEPS_WEBHOOK_SECRET` no n8n. Deixar ambos vazios desativa a validacao (o node `Validate HMAC` ignora quando secret nao esta setado).

## 5. Testar

### Opcao A — curl direto no n8n

```bash
curl -X POST https://n8n.igreen.com.br/webhook/followup-comparecimento \
  -H "Content-Type: application/json" \
  -d '{
    "event":"appointment.attendance",
    "accountId":"acc-teste",
    "appointmentId":"appt-teste",
    "contactId":"c-teste",
    "contact":{"id":"c-teste","nome":"Joao Teste","telefone":"5511999990000","email":"j@t.com"},
    "appointment":{"id":"appt-teste","title":"Consulta","startTime":"2026-06-18T14:00:00Z","endTime":"2026-06-18T15:00:00Z","status":"DONE","attendanceStatus":"NO_SHOW","attendanceMarkedAt":"2026-06-18T15:05:00Z","outcome":null,"outcomeValue":null,"outcomeNotes":null,"outcomeMarkedAt":null},
    "account":{"id":"acc-teste","nome":"Conta Teste"},
    "actor":{"userId":"u1","name":"QA"},
    "timestamp":"2026-06-18T15:05:01Z"
  }'
```

Espera: 200 OK imediato + mensagem chega no numero `5511999990000` na branch NO_SHOW.

### Opcao B — pelo CRM

1. Crie um agendamento de teste pra um contato com seu numero.
2. Marque como **Nao compareceu** (ou Compareceu / Remarcado).
3. Confira: (a) execucao verde no n8n, (b) mensagem chega no WhatsApp.

## 6. Observabilidade

- n8n -> **Executions** mostra cada disparo. Falha na Evolution aparece em vermelho com payload do erro.
- O node **Log to Backend (opt)** posta em `POST /api/n8n/followup-log` (endpoint opcional — se nao existir, `ignoreResponseCode:true` evita marcar o run como erro).

## 7. Branches e mensagens

| attendanceStatus | Mensagem |
|---|---|
| ATTENDED | "Foi um prazer te receber hoje, {nome}! 💜 Qualquer duvida sobre o que conversamos, e so chamar." |
| NO_SHOW | "Oi {nome}, vi que nao conseguiu vir hoje. Aconteceu algo? Quer que eu te ajude a remarcar pra outro dia? 💜" |
| RESCHEDULED | "Sem problema {nome}! Confirmamos sua remarcacao. Quando confirmar a nova data, te aviso aqui. 💜" |
| outros | Fallback (output 3 do Switch) — nao envia nada. |

Pra editar, abra o node `Msg ATTENDED` / `Msg NO_SHOW` / `Msg RESCHEDULED` e altere o campo `message`.

## 8. Troubleshooting

- **400 do CRM ao salvar URL**: garantir https e que o workflow esta ativo (n8n responde 404 em workflows inativos).
- **Mensagem nao chega**: cheque `EVOLUTION_API_KEY` e se a instancia `EVOLUTION_INSTANCE` esta conectada no Evolution Manager.
- **HMAC invalido**: secret no painel Gleps diferente do `GLEPS_WEBHOOK_SECRET` no n8n. Ou deixe ambos vazios pra desativar.
- **Telefone sem 55**: o backend ja envia E.164 sem `+`; se necessario, normalize no node `Msg *` antes de mandar pra Evolution.
