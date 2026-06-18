# T-017 — Templates n8n pendentes (depende de T-013)

> **Status:** TODO — aguardando merge da branch do builder n8n (T-013).
> O builder vive em `tools/n8n-flow-builder/prompts/gallery.js` (array `PROMPT_GALLERY`).
> Quando T-013 entrar em `whitelabel/gleps-ia`, adicionar os 4 templates abaixo.

## Como adicionar

Editar `tools/n8n-flow-builder/prompts/gallery.js` e fazer `PROMPT_GALLERY.push(...)` com os 4 objetos. Cada template precisa de: `id`, `name`, `description`, `variables[]`, `classifier` (prompt), `responder` (prompt). Variáveis interpoláveis padrão: `{{company_name}}`, `{{specialty}}`, `{{doctor_name}}`, `{{contact.nome}}`, `{{appointment.valueCents}}`.

Validar com:
```sh
node -e "const fs=require('fs'); const vm=require('vm'); const ctx={window:{}}; vm.createContext(ctx); vm.runInContext(fs.readFileSync('tools/n8n-flow-builder/prompts/gallery.js','utf8'), ctx); console.log('templates:', ctx.window.PROMPT_GALLERY.length);"
```

---

## Template 1 — `agradecimento-fechamento`

- **Gatilho webhook:** `event=appointment.outcome AND outcome=fechou_tratamento` (enum interno: `CLOSED`)
- **Sequência:**
  - D+0: mensagem de boas-vindas + agradecimento do fechamento, citando `{{doctor_name}}` e `{{specialty}}`
  - D+7: pedido de indicação ("conhece alguém que precisa?")
  - D+30: convite para retorno/check-up
- **Variables:** `company_name`, `specialty`, `doctor_name`, `contact.nome`, `appointment.valueCents`
- **Classifier prompt:** classificar resposta em `aceitou_indicar | nao_aceitou | duvida_clinica | outro` para roteamento.
- **Responder prompt:** tom acolhedor, primeira pessoa do plural ("nós da {{company_name}}"), sem promessa de resultado clínico.

## Template 2 — `recuperacao-no-show`

- **Gatilho webhook:** `event=appointment.attendance AND attendanceStatus=falto` (enum: `NO_SHOW`)
- **Sequência:**
  - D+0: mensagem empática ("sentimos sua falta hoje"), sem cobrança
  - D+3: oferta concreta de reagendamento com 2 horários sugeridos
  - D+7: última tentativa, com canal alternativo (ligação)
- **Variables:** `company_name`, `doctor_name`, `contact.nome`
- **Classifier prompt:** classificar em `quer_reagendar | desistiu | sem_resposta | reclamacao` (priorizar reclamação para handoff humano).
- **Responder prompt:** evitar julgamento, oferecer caminho fácil de volta, nunca usar "você faltou".

## Template 3 — `nutricao-pos-orcamento`

- **Gatilho webhook:** `event=appointment.outcome AND outcome=vai_pensar` (enum: `CONSIDERING`)
- **Sequência:**
  - D+2: depoimento real de paciente da `{{specialty}}`
  - D+7: caso clínico (antes/depois ou explicação técnica leve)
  - D+15: oferta com condição especial (parcelamento, brinde de consulta de retorno)
  - D+30: última mensagem ("ainda está pensando? podemos ajudar")
- **Variables:** `company_name`, `specialty`, `doctor_name`, `contact.nome`, `appointment.valueCents`
- **Classifier prompt:** `quer_fechar | mais_duvidas | desistiu | preco_alto` — se `preco_alto`, roteia pra humano com flag de negociação.
- **Responder prompt:** consultivo, sem pressão, focar em valor antes de preço.

## Template 4 — `reagendamento`

- **Gatilho webhook:** `event=appointment.attendance AND attendanceStatus=reagendou` (enum: `RESCHEDULED`)
- **Sequência:**
  - D+0: confirmação do reagendamento + 3 opções de horário (via integração com `GET /calendar/availability`)
  - D+1 (se sem resposta): repetir opções com canal alternativo
- **Variables:** `company_name`, `doctor_name`, `contact.nome`, `appointment.suggestedSlots`
- **Classifier prompt:** `escolheu_horario | quer_outro | desistiu` — se `escolheu_horario`, dispara criação de novo `CalendarEvent` via API.
- **Responder prompt:** objetivo, listar horários em bullets, sempre confirmar timezone.

---

## Observações

- Todos os templates devem usar o webhook in do n8n configurado em `Account.n8nWebhookUrl` (T-013).
- Circuit breaker T-012 já cobre falhas de disparo.
- Idempotência: o backend (T-017 server-side) só dispara webhook em transição `NULL -> X`, então clique duplo não duplica execução do flow.
- Quando T-013 mergeado: abrir PR com os 4 templates e remover este TODO.
