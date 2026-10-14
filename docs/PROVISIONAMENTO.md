# Provisionamento de agente — contrato da plataforma (API) — spec v1.1

> 14/10/2026. Este documento é o contrato entre o **kit do operador** (outra
> pasta; só fala com a plataforma por HTTP) e o **GLEPS CRM**. Quem lê não vê
> o código. Código, para quem vê: `backend/src/services/provisionar.service.ts`
> (costura), `provisionar/spec.ts` (zod), `provisionar/prompt.ts` (prompt por
> seções), `provisionar/template-fluxo.ts` (grafo), `provisionar/conversas-teste.ts`
> (bateria), `controllers/provisionar.controller.ts`, `routes/provisionar.routes.ts`,
> `ai/modelos.ts` (validação de modelo), `utils/segredos.ts` (máscara),
> migrations `0075_agente_spec` e `0076_agente_raciocinio`.

## Changelog

**v1.1 — 14/10/2026 (ETAPA G, correções do piloto "Sofia").** Spec **aditivo**: todo
campo novo tem default e um spec v1 continua aceito sem mudança (`"versao": 1` ou `1.1`).
- **Segurança**: nenhuma leitura de conta (`GET /accounts`, `GET /accounts/:id`, `/auth/me`…)
  devolve chave em texto puro — vem `••••` + 4 últimos; `temChaveOpenai`/`temChaveAnthropic`
  dizem se existe. Mandar o valor mascarado de volta no PUT é ignorado (seção 11).
- **Spec**: `agente.papel` (sdr | recepcao | suporte), `agente.raciocinio`, bloco `vendas`
  (só sdr) → seção **COMO VENDER**; `servicos[].unidade` e `servicos[].agendavel` (teto 200;
  só o agendável vira serviço de agenda; todos entram no **CATÁLOGO**); `followup.tentativas`
  (um intervalo por toque, ≤ 5), `followup.janela`, `followup.mensagens` — `aposHoras`/
  `maxTentativas` seguem aceitos e viram tentativas iguais.
- **Modelo**: padrão do provisionamento é **`gpt-4.1`**; `agente.model` é **validado** com a
  chave da conta antes de criar (400 "Modelo X não existe ou a chave não tem acesso"); modelos
  de raciocínio (gpt-5*, o-series) aceitam `agente.raciocinio` (seção 9).
- **Prompt**: identidade sem "atendente virtual" (só confirma que é IA se perguntarem);
  `apresentacao` é inspiração, não frase a repetir; proibido "vou confirmar com a equipe" sem
  transferir; ao transferir o agente escreve 1–2 frases de orientação, **enviadas antes** da
  transferência (a mensagem fixa só sai se ele não escrever nada).
- **Fluxo**: o bloco "Avisar o lead" saiu — o aviso sai do próprio "Atender com IA"
  (`enviarTextoAoTransferir`); follow-up com um toque por intervalo, dentro da janela.
- **Agenda/motor** (dev-G1): reserva pendente guardada na conversa (`agendar` sem `ref`,
  ou direto por horário); `consultar_horarios` aceita dia/período/horário desejado e espalha
  as opções; teto de 8 ferramentas por mensagem; simulador sequencial com calendário em
  memória e `toolCalls` detalhados.
- **Rotas novas**: `GET /agente/:id` enriquecido (prompt, agenda, serviços, usuários, inboxes,
  ia); `GET /conta/:accountId` e `PUT /conta/:accountId/ia` para o kit não precisar logar
  com usuário da conta (6.8–6.9).

**v1 — 11/10/2026.** Primeira versão.

## 1. Fluxo de trabalho

```
briefing com o cliente  →  spec (JSON v1)  →  POST /agente (sombra)  →  POST /simular
      ↑                                                                      │
      └──────────── ajusta o spec e PUT /agente (versão N+1) ◄───────────────┘
                                                                             │ relatório ok
                                                                             ▼
                                                   POST /publicar { status: "active" }
```

1. **Briefing → spec.** O operador transforma o que ouviu do cliente no JSON da seção 3.
2. **POST /agente** cria (201) ou atualiza (200) tudo na conta do cliente e deixa o
   fluxo em **shadow** (roda e registra, mas não envia nem muda nada).
3. **POST /simular** roda conversas em sombra contra o agente de verdade (gasta
   token da conta; não grava nada) e devolve um relatório por turno. Comece pela
   bateria fixa de `GET /conversas-teste/:segmento`.
4. Ajustou? **PUT /agente/:id** re-provisiona (versão N+1). Piorou? **POST /reverter**.
5. Relatório aceitável → **POST /publicar { status: "active" }**. O fluxo passa a
   responder leads de verdade. Só um fluxo fica `active` por conta: os outros voltam
   para `draft`.

Tudo é **super admin**: JWT de `role: super_admin`. Admin comum da conta recebe 403.

### 1.1 Pré-requisitos (antes do primeiro POST)

- **URL base é a do ambiente** (ex.: `https://360.gleps.com.br/api` em produção,
  `http://localhost:3000/api` local). Nos exemplos: `$API`.
- **Super admin da instalação**: o e-mail/senha são os cadastrados naquele ambiente
  (`superadmin@gleps.com` abaixo é ilustrativo). `data.user.role` do login tem que ser `super_admin`.
- **A conta já existe** (criada em `/admin/accounts` ou `POST /accounts`). O `accountId` é obtido
  por `GET /accounts` (passo 2 do roteiro).
- **A conta tem chave de IA (OpenAI ou Anthropic)** — o kit grava pelo super admin com
  `PUT /admin/provisionar/conta/:accountId/ia` (6.9; derruba o cache na hora), ou o admin da
  conta em *Administração → Integrações*. Sem chave, o POST já falha no primeiro passo com
  **409 `IA_SEM_CHAVE`**; `/simular` e `/publicar active` também. Chave salva pela tela entra
  num cache de ~**60 s**. Base de conhecimento só indexa com chave **OpenAI** (embeddings);
  só Anthropic → agente roda, base fica pendente (vem como aviso).
- **O modelo existe para essa chave**: `agente.model` (padrão `gpt-4.1`) é conferido na lista
  de modelos do provider antes de criar qualquer coisa — **400** se não existir ou a chave não
  alcançar (seção 9). `GET /admin/provisionar/conta/:accountId` (6.8) mostra o estado da IA.
- Os **profissionais da agenda** precisam existir como usuários **ativos** da conta com o mesmo
  e-mail do spec (senão viram aviso e a agenda do agente fica desligada).

### 1.2 Roteiro completo em curl

```sh
API=https://360.gleps.com.br/api          # a URL do ambiente
SPEC=spec-clinica.json                     # só o spec (seção 3), sem envelope

# 1. login do super admin → token
TOKEN=$(curl -s -X POST $API/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"superadmin@gleps.com","password":"…"}' | jq -r '.data.token')

# 2. accountId pelo nome da conta (busca parcial, sem distinguir maiúsculas)
curl -s "$API/accounts?search=Vida%20Plena" -H "Authorization: Bearer $TOKEN" \
  | jq -r '.data[] | "\(.id)\t\(.nome)\t\(.status)"'
ACCOUNT_ID=$(curl -s "$API/accounts?search=Vida%20Plena" -H "Authorization: Bearer $TOKEN" \
  | jq -r '.data[0].id')

# 2b. (v1.1) o que a conta tem — chave de IA (mascarada), usuários, inboxes, agentes
curl -s $API/admin/provisionar/conta/$ACCOUNT_ID -H "Authorization: Bearer $TOKEN" | jq '.data.ia, .data.usuarios, .data.inboxes'
# 2c. (v1.1) sem chave? gravar pelo super admin (model opcional, só conferido)
curl -s -X PUT $API/admin/provisionar/conta/$ACCOUNT_ID/ia -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"provider":"openai","apiKey":"sk-…","model":"gpt-4.1"}' | jq '.data.ia'

# 3. provisionar: envelope { accountId, spec } montado a partir do arquivo
jq -n --arg a "$ACCOUNT_ID" --slurpfile s $SPEC '{accountId: $a, spec: $s[0]}' \
  | curl -s -X POST $API/admin/provisionar/agente -H "Authorization: Bearer $TOKEN" \
      -H 'Content-Type: application/json' -d @- | tee resposta.json | jq '.data'
AGENT=$(jq -r '.data.agentId' resposta.json)
jq -r '.data.avisos[]' resposta.json        # leia os avisos antes de seguir

# 4. conferir o que ficou gravado (spec, fluxo, versões)
curl -s $API/admin/provisionar/agente/$AGENT -H "Authorization: Bearer $TOKEN" | jq '.data'

# 5. simular com a bateria do segmento (gasta token da conta; não grava nada)
curl -s "$API/admin/provisionar/conversas-teste/clinica" -H "Authorization: Bearer $TOKEN" \
  | jq '{conversas: [.data[] | {nome, mensagens}]}' > bateria.json
curl -s -X POST $API/admin/provisionar/agente/$AGENT/simular -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d @bateria.json | tee simulacao.json | jq '.data.resumo'
jq '.data.conversas[] | {nome, transferiu, agendou, erro, turnos: [.turnos[] | {lead, resposta, rota, toolCalls}]}' simulacao.json

# 6. ajustou o spec? re-provisionar (versão N+1) — envelope { spec }
jq -n --slurpfile s $SPEC '{spec: $s[0]}' \
  | curl -s -X PUT $API/admin/provisionar/agente/$AGENT -H "Authorization: Bearer $TOKEN" \
      -H 'Content-Type: application/json' -d @- | jq '.data'

# 7. piorou? voltar para a versão 1 (gera uma versão nova, cópia da 1)
curl -s -X POST $API/admin/provisionar/agente/$AGENT/reverter -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"versao":1}' | jq '.data'

# 8. relatório ok → ligar de verdade (ou "shadow" para só observar)
curl -s -X POST $API/admin/provisionar/agente/$AGENT/publicar -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"status":"active"}' | jq '.data'
```

## 2. O que o provisionamento cria (ou atualiza) na conta

| # | Objeto | Como acha o que já existe | O que grava |
|---|--------|---------------------------|-------------|
| 1 | Base de conhecimento `"<negocio.nome> — base da <agente.nome>"` | base ligada ao agente, senão pelo nome | `businessContext` = sobre + endereço + contato (≤ 4000 chars; entra em TODO prompt). Documentos marcados `sourceRef: "provisionamento"`: **"Sobre o negócio"** (sobre, endereço, contato, diferenciais, catálogo com unidade, links), um por `conhecimento.textos[]` (título = `titulo`), **"Perguntas frequentes"** (um doc, pares `P: …\nR: …` separados por linha em branco — o chunker quebra por parágrafo, então cada pergunta vira um trecho). Doc do provisionamento que saiu do spec é apagado; doc subido à mão pelo admin fica. Conteúdo novo volta para a fila de indexação (worker, assíncrono). |
| 2 | Serviços (`products`) | por nome, sem distinguir maiúsculas | **Só os itens agendáveis** (`agendavel` ≠ false e com `duracaoMinutos`): `duracaoMinutos`, `valorPadrao`, `ativo: true`. Plano mensal, pacote e item sem duração ficam só no CATÁLOGO do prompt. Nunca duplica. |
| 3 | Etapas do funil (`tags type=stage`) | por nome, no funil padrão da conta (cria "Funil Principal" + Fechado/Perdido se a conta não tiver funil) | cria as de `funil.*` que faltam, **antes** das fixas Fechado/Perdido. Etapa com o mesmo nome que já existe é **reaproveitada na posição em que está** (não é movida nem renomeada); só as novas entram antes de Fechado/Perdido. |
| 4 | Agenda (se `agenda.ativo`) | — | `agenda_configuracao`: antecedência (`antecedenciaMinimaHoras` × 60) e `etapaAoAgendar` (slug da etapa). `agenda_profissionais`: um por e-mail que tenha usuário **ativo** na conta, com os `horarios` do spec. E-mail sem usuário → **aviso**, não erro. `agenda.fuso` diferente do fuso da conta → a conta muda de fuso (aviso). |
| 5 | Agente (`ai_agents`) | por `agentId` do corpo, senão por `agente.nome` na conta | `role: responder`, `systemPrompt` por seções (seção 4), `provider`, `model` (**padrão `gpt-4.1`** na OpenAI; validado antes — seção 9), `raciocinio` (`reasoning_effort`, só modelos que aceitam), `temperature` (padrão 0,5), `tools: ["lembrar","buscar_conhecimento"]`, `outputSchema` com `rota ∈ {respondeu, humano}` + `resumo`, `memoryFields` = `triagem.camposMemoria` (escopo `memoria`), `agenda: { ativo, profissionalIds, produtoIds }` (ou `null` se não houver profissional/serviço agendável — aviso), `knowledgeBaseId`, `spec` (normalizado, v1.1), `spec_versao`. |
| 6 | Fluxo `"Atendimento — <agente.nome>"` | pelo `flow_id` da última versão, senão pelo nome | grafo da seção 5. **Criado em `shadow`**; ao atualizar, **mantém id e status** (se estiver `draft`, aviso). `inboxIds` do spec ou `null` (= todas as inboxes da conta). |
| 7 | Versão (`agent_spec_versions`) | — | `versao` = anterior + 1, o `spec` inteiro, `flow_id`, `criado_por`. |
| 8 | Auditoria (`events`) | — | `agente.provisionado` \| `agente.atualizado` \| `agente.revertido` \| `agente.publicado`, `entityType: ai_agent`. |

**Idempotente por agente, não atômico.** Cada passo reencontra o que já existe e
atualiza; se um POST falhar no meio, repita o mesmo POST — ele conserta. Nunca
duplica agente, fluxo, base, serviço ou etapa.

## 3. O spec (versão 1.1 — v1 continua aceito)

Zod completo com mensagens em português. Tudo que não está marcado *obrigatório*
tem default. Strings são `trim()`adas. Campos marcados **v1.1** são novos; omitidos,
o comportamento é o da v1.

```jsonc
{
  "versao": 1.1,                                 // obrigatório: 1, 1.1 ou "1.1" (campos novos valem nos dois)
  "negocio": {
    "nome": "Clínica Vida Plena",                // obrigatório, ≤ 120
    "segmento": "clinica",                       // obrigatório: clinica | estetica | academia | servicos | outro
    "sobre": "texto livre",                      // obrigatório, ≤ 8000 — vira businessContext e o doc "Sobre o negócio"
    "endereco": "opcional ≤ 300",
    "contato": "opcional ≤ 300",
    "diferenciais": ["≤ 20 itens, ≤ 200 cada"]
  },
  "agente": {
    "nome": "Bia",                               // obrigatório, ≤ 60 — é a chave de idempotência na conta
    "tom": "acolhedor",                          // obrigatório: acolhedor | direto | formal | descontraido
    "papel": "recepcao",                         // v1.1: sdr | recepcao | suporte (padrão recepcao). sdr liga a seção COMO VENDER
    "apresentacao": "opcional ≤ 300 — INSPIRAÇÃO para a 1ª mensagem, não frase a repetir",
    "provider": "openai",                        // opcional: openai | anthropic. Omitido = o que a conta tem chave (OpenAI primeiro)
    "model": "gpt-4.1",                          // opcional ≤ 80. Omitido = gpt-4.1 (OpenAI) / padrão do provider (Anthropic). VALIDADO com a chave (400)
    "raciocinio": "low",                         // v1.1, opcional: minimal | low | medium | high — só modelos de raciocínio (gpt-5*, o*); os outros ignoram
    "temperatura": 0.5                           // opcional 0–2 (padrão 0.5; modelos de raciocínio ignoram)
  },
  "vendas": {                                    // v1.1, opcional — SÓ com agente.papel = "sdr" (400 caso contrário)
    "objetivo": "agendar avaliacao",             // agendar avaliacao | fechar | qualificar (padrão agendar avaliacao)
    "roteiro": ["≤ 12 etapas, ≤ 300 cada"],      // numeradas no prompt; sem roteiro → roteiro padrão de 4 passos
    "objecoes": [{ "objecao": "Está caro", "resposta": "≤ 600" }],   // ≤ 20; tabela no prompt
    "gatilhos": ["≤ 12 — quando oferecer"],
    "fechamento": "opcional ≤ 500"
  },
  "servicos": [                                  // ≤ 200 — o CATÁLOGO inteiro (prompt); só o agendável vira serviço de agenda
    { "nome": "Avaliação", "duracaoMinutos": 30, "valorPadrao": 0, "unidade": "avaliacao", "descricao": "opcional ≤ 600" },
    { "nome": "Plano mensal", "valorPadrao": 390, "unidade": "mes", "agendavel": false }
    // duracaoMinutos: inteiro 5–600, OPCIONAL (v1.1); valorPadrao ≥ 0: ausente/null = "valor sob consulta" (o agente não inventa), 0 = "gratuito" (o Product nasce com 0 nos dois casos)
    // unidade (v1.1): sessao | mes | pacote | unidade | hora | avaliacao — o prompt diz "R$ X por mês"; sem unidade, só o valor
    // agendavel (v1.1): padrão true quando tem duração; true sem duração → 400
  ],
  "agenda": {                                    // padrão { ativo: false }
    "ativo": true,
    "fuso": "America/Sao_Paulo",                 // IANA; muda o fuso da CONTA se diferente
    "horarios": [{ "dias": [1,2,3,4,5], "inicio": "08:00", "fim": "18:00" }],   // ≤ 14 faixas; dias 0=dom … 6=sáb; HH:MM; fim > inicio
    "profissionais": [{ "email": "usuario-da-conta@x.com" }],                    // ≤ 50; precisa ser usuário ATIVO da conta
    "antecedenciaMinimaHoras": 2                 // 0–168 (padrão 2)
  },
  "triagem": {
    "perguntas": ["≤ 12, ≤ 200 cada"],
    "camposMemoria": [{ "chave": "motivo", "descricao": "motivo do contato" }]  // ≤ 40; chave /^[a-z][a-z0-9_]{1,48}$/
  },
  "regras": {
    "nuncaResponder": ["≤ 30"], "sempreTransferir": ["≤ 30"], "limites": ["≤ 30, ≤ 300 cada"],
    "linksUteis": [{ "rotulo": "Instagram", "url": "https://…" }]                 // ≤ 20; url completa
  },
  "funil": { "etapaAoAtender": "Em atendimento", "etapaAoAgendar": "Agendado", "etapaAoTransferir": "Com humano" },  // padrões
  "transferencia": { "mensagemAoCliente": "Vou chamar alguém da equipe para te ajudar, um instante." },         // ≤ 500 — só sai se o agente não escrever a orientação
  "followup": {
    "ativo": false,
    "tentativas": ["2h", "1d", "3d"],            // v1.1: um intervalo por toque ("Nh" ou "Nd", 1h–30d), ≤ 5. Substitui aposHoras/maxTentativas
    "janela": { "inicio": "09:00", "fim": "19:00" },   // v1.1, opcional (padrão 08:00–20:00) — nos dias de expediente da agenda (ou seg–sex)
    "mensagens": ["toque 1", "toque 2", "toque 3"],    // v1.1, opcional ≤ 5 × 500: referência por toque; sem → `mensagem` para todos
    "mensagem": "Oi {{nome}}, ficou alguma dúvida? Posso ajudar.",
    "aposHoras": 24, "maxTentativas": 2          // v1 (compatibilidade): sem `tentativas`, viram maxTentativas × "aposHoras h" (1–5)
  },
  //            {{nome}} é instrução ao agente (usa o nome se souber). A resposta/GET devolve sempre `tentativas` + os derivados
  "conhecimento": {
    "textos": [{ "titulo": "Convênios", "conteudo": "…" }],   // ≤ 60; conteudo ≤ 100.000
    "faq": [{ "pergunta": "Atendem sábado?", "resposta": "Não." }]   // ≤ 200
  },
  "inboxIds": ["uuid"]                           // opcional; precisam ser da conta. Omitido/vazio = todas as inboxes
}
```

Outros limites: prompt gerado ≤ **30.000** caracteres (400 explica o que encurtar —
FAQ e textos vão para a base, não para o prompt).

### 3.1 Exemplos por segmento

**clinica**
```json
{ "versao": 1,
  "negocio": { "nome": "Clínica Vida Plena", "segmento": "clinica", "sobre": "Clínica médica de atenção primária e check-up, adultos e idosos, desde 2012.", "endereco": "Rua das Flores, 120 — Campinas/SP", "contato": "(19) 3333-0000", "diferenciais": ["Hora marcada, sem fila"] },
  "agente": { "nome": "Bia", "tom": "acolhedor", "apresentacao": "Oi! Eu sou a Bia, da Clínica Vida Plena.", "temperatura": 0.4 },
  "servicos": [ { "nome": "Consulta clínica", "duracaoMinutos": 30, "valorPadrao": 250 }, { "nome": "Avaliação", "duracaoMinutos": 20 } ],
  "agenda": { "ativo": true, "fuso": "America/Sao_Paulo", "horarios": [ { "dias": [1,2,3,4,5], "inicio": "08:00", "fim": "12:00" }, { "dias": [1,2,3,4,5], "inicio": "13:00", "fim": "18:00" } ], "profissionais": [ { "email": "carlos@clinicavidaplena.com" } ], "antecedenciaMinimaHoras": 2 },
  "triagem": { "perguntas": ["Qual seu nome?", "Já é paciente?"], "camposMemoria": [ { "chave": "motivo", "descricao": "motivo do contato" }, { "chave": "ja_paciente", "descricao": "se já é paciente (sim/não)" } ] },
  "regras": { "nuncaResponder": ["diagnóstico", "valores de procedimentos não listados"], "sempreTransferir": ["reclamação", "pedido explícito de humano", "urgência"], "limites": ["não prometer resultados"], "linksUteis": [ { "rotulo": "Instagram", "url": "https://instagram.com/vidaplena" } ] },
  "followup": { "ativo": true, "aposHoras": 24, "mensagem": "Oi {{nome}}, ficou alguma dúvida? Posso ajudar.", "maxTentativas": 2 },
  "conhecimento": { "textos": [ { "titulo": "Convênios", "conteudo": "Aceitamos Unimed, Bradesco Saúde e SulAmérica." } ], "faq": [ { "pergunta": "Atendem sábado?", "resposta": "Não, de segunda a sexta." } ] } }
```

**estetica — v1.1, papel sdr com bloco de vendas, catálogo com unidade e follow-up por toque**
```json
{ "versao": 1.1,
  "negocio": { "nome": "Studio Luz", "segmento": "estetica", "sobre": "Estúdio de estética facial e corporal. Avaliação gratuita antes de qualquer procedimento." },
  "agente": { "nome": "Sofia", "tom": "descontraido", "papel": "sdr", "apresentacao": "Oi! Aqui é a Sofia, do Studio Luz.", "model": "gpt-5-mini", "raciocinio": "low" },
  "vendas": { "objetivo": "agendar avaliacao",
    "roteiro": ["Descobrir o que incomoda a pessoa", "Mostrar o tratamento certo para isso", "Oferecer a avaliação gratuita"],
    "objecoes": [ { "objecao": "Está caro", "resposta": "A avaliação é gratuita e o plano cabe em 10x." }, { "objecao": "Vou pensar", "resposta": "Sem pressa; a agenda da semana tem poucas vagas, posso reservar uma?" } ],
    "gatilhos": ["Perguntou preço", "Falou de evento próximo"], "fechamento": "Proponha o horário mais próximo e confirme." },
  "servicos": [ { "nome": "Avaliação", "duracaoMinutos": 30, "unidade": "avaliacao" }, { "nome": "Limpeza de pele", "duracaoMinutos": 60, "valorPadrao": 180, "unidade": "sessao" },
                { "nome": "Plano mensal", "valorPadrao": 390, "unidade": "mes", "agendavel": false, "descricao": "4 sessões por mês" } ],
  "agenda": { "ativo": true, "horarios": [ { "dias": [2,3,4,5,6], "inicio": "10:00", "fim": "19:00" } ], "profissionais": [ { "email": "marina@studioluz.com" } ] },
  "regras": { "nuncaResponder": ["diagnóstico de pele", "indicação de medicamento"], "sempreTransferir": ["reclamação", "pedido de humano"], "limites": ["não prometer resultado", "não dar desconto"] },
  "followup": { "ativo": true, "tentativas": ["2h", "1d", "3d"], "janela": { "inicio": "09:00", "fim": "19:00" },
    "mensagens": ["Oi {{nome}}, ficou alguma dúvida sobre a avaliação?", "Passando pra lembrar que a avaliação é gratuita.", "Se preferir, retomo em outro momento — me avisa."] },
  "conhecimento": { "faq": [ { "pergunta": "Dói?", "resposta": "A maioria dos procedimentos é indolor; a avaliação explica cada caso." } ] } }
```
Trecho do prompt que isso gera (seções COMO VENDER e CATÁLOGO):
```
CATÁLOGO

- Avaliação — valor sob consulta (duração 30 min)
- Limpeza de pele — R$ 180,00 por sessão (duração 60 min)
- Plano mensal — R$ 390,00 por mês — 4 sessões por mês

Regras do catálogo:
- Cite o preço exatamente como está aqui, com a unidade informada ("por sessão", "por mês"…). Para item SEM unidade, diga só o valor — nunca acrescente "cada", "por sessão" ou "por mês" por conta própria.
- "Valor sob consulta": não invente nem estime. Diga que a equipe passa o valor e ofereça o próximo passo (agendamento ou transferência).
- Só os itens com duração se marcam pelas ferramentas de agenda; os outros você apresenta e encaminha.

---

COMO VENDER

Objetivo da conversa: levar a pessoa a marcar uma avaliação — o agendamento é a conversão.

Roteiro (siga a ordem; avance só quando a etapa anterior estiver cumprida, sem pular para a oferta):
1. Descobrir o que incomoda a pessoa
2. Mostrar o tratamento certo para isso
3. Oferecer a avaliação gratuita

Quando oferecer (gatilhos — ao ver um deles, é hora de propor o próximo passo):
- Perguntou preço
- Falou de evento próximo

Objeções — responda assim (adapte ao que a pessoa disse, sem recitar):
| Objeção | Como responder |
| --- | --- |
| Está caro | A avaliação é gratuita e o plano cabe em 10x. |
| Vou pensar | Sem pressa; a agenda da semana tem poucas vagas, posso reservar uma? |

Fechamento: Proponha o horário mais próximo e confirme.
```

**academia**
```json
{ "versao": 1,
  "negocio": { "nome": "FitPark", "segmento": "academia", "sobre": "Academia 24h com musculação, funcional e aulas coletivas. Planos mensal, trimestral e anual." },
  "agente": { "nome": "Téo", "tom": "direto" },
  "servicos": [ { "nome": "Aula experimental", "duracaoMinutos": 60 } ],
  "agenda": { "ativo": true, "horarios": [ { "dias": [1,2,3,4,5], "inicio": "06:00", "fim": "22:00" }, { "dias": [6], "inicio": "08:00", "fim": "14:00" } ], "profissionais": [ { "email": "recepcao@fitpark.com" } ], "antecedenciaMinimaHoras": 1 },
  "triagem": { "perguntas": ["Qual seu objetivo?", "Já treinou antes?"], "camposMemoria": [ { "chave": "objetivo", "descricao": "objetivo do aluno" } ] },
  "regras": { "nuncaResponder": ["treino ou dieta personalizados"], "sempreTransferir": ["trancar ou cancelar matrícula", "cobrança"] },
  "funil": { "etapaAoAtender": "Em contato", "etapaAoAgendar": "Aula marcada", "etapaAoTransferir": "Com recepção" },
  "conhecimento": { "textos": [ { "titulo": "Planos", "conteudo": "Mensal R$ 129. Trimestral R$ 349. Anual R$ 1.190 em 12x." } ] } }
```

**servicos**
```json
{ "versao": 1,
  "negocio": { "nome": "Oficina do Zé", "segmento": "servicos", "sobre": "Mecânica geral e elétrica automotiva. Orçamento após inspeção." },
  "agente": { "nome": "Léo", "tom": "direto" },
  "servicos": [ { "nome": "Inspeção", "duracaoMinutos": 45 } ],
  "agenda": { "ativo": true, "horarios": [ { "dias": [1,2,3,4,5], "inicio": "08:00", "fim": "18:00" } ], "profissionais": [ { "email": "ze@oficina.com" } ] },
  "regras": { "limites": ["não passar valor de conserto sem inspeção"], "sempreTransferir": ["garantia", "reclamação"] },
  "followup": { "ativo": true, "aposHoras": 48, "mensagem": "Oi {{nome}}, conseguiu ver sobre a inspeção?", "maxTentativas": 1 } }
```

**outro** (mínimo válido)
```json
{ "versao": 1,
  "negocio": { "nome": "Papelaria Central", "segmento": "outro", "sobre": "Papelaria e gráfica rápida no centro. Entregas na região." },
  "agente": { "nome": "Nina", "tom": "formal" } }
```

## 4. O prompt gerado — seções e de onde vêm

Seções fixas, nesta ordem, separadas por `---`. Seção sem conteúdo no spec **não entra**.

| Seção | Vem de | O que diz |
|---|---|---|
| **IDENTIDADE** | `agente.nome/papel/tom/apresentacao`, `negocio.nome/segmento` | "Você é Sofia, responsável pela pré-venda … de Studio Luz" (sem "atendente virtual"); `apresentacao` como **inspiração** para a 1ª mensagem; **não se declara IA por conta própria — se perguntarem, confirma com naturalidade**; nunca diz que é humano |
| **SOBRE O NEGÓCIO** | `negocio.sobre/endereco/contato/diferenciais` | texto do negócio |
| **CATÁLOGO** | `servicos[]` (todos) | `- Nome — R$ X por <unidade> (duração Y min) — descrição`; sem valor → `valor sob consulta`, `valorPadrao: 0` → `gratuito`; regra: **nunca inventar "cada"/"por sessão" fora da unidade informada**; só itens com duração se agendam |
| **COMO ATENDER** | `triagem.perguntas`, `triagem.camposMemoria` | responde a dúvida antes da triagem; uma pergunta por vez; `lembrar` com os campos; consultar a base; **PROIBIDO "vou confirmar com a equipe" sem transferir** — ou tem a informação, ou transfere dizendo o motivo |
| **COMO VENDER** (só `papel: sdr`) | `vendas.*` | objetivo; roteiro numerado (ou padrão de 4 passos); gatilhos; objeções em tabela; fechamento; "nunca pressione" |
| **AGENDA** (só com `agenda.ativo`) | `agenda.antecedenciaMinimaHoras` | roteiro `consultar_horarios (período) → reservar → "confirmo?" → agendar`; a reserva fica guardada na conversa (`agendar` sem ref, ou direto por horário); nunca inventar horário |
| **REGRAS** | `regras.*` | nunca responder / sempre transferir (rota `humano`) / limites / links permitidos |
| **TRANSFERÊNCIA** | `transferencia.mensagemAoCliente` | quando transferir; **ao transferir, escreve 1–2 frases de orientação** (motivo + o que fazer; urgência → emergência) que são **enviadas antes**; a mensagem fixa só sai se não escrever nada; `resumo` para a equipe |
| **ESTILO** | fixo | português, sem emoji/markdown, ≤ 3 frases, uma pergunta, áudio não transcrito → pedir texto |
| **FOLLOW-UP** (só com `followup.ativo`) | `followup.mensagens` ou `followup.mensagem` | a dica `{{objetivo_do_passo}}` da cadência + a mensagem de referência (por toque, se houver) |
| **FORMATO DA RESPOSTA** | fixo | JSON `{ mensagem_de_resposta, rota: respondeu\|humano, resumo }` — com rota `humano`, `mensagem_de_resposta` é a orientação |

Em tempo de execução a plataforma acrescenta, por conta própria: data/hora de agora no
fuso da conta, "quem é esta pessoa" (cadastro + histórico), memórias, resumo do
histórico, `SOBRE O NEGÓCIO` da base (`businessContext`), índice da base e trechos
recuperados. O operador não escreve nada disso.

## 5. O fluxo "Atendimento — <agente>"

```
[Mensagem recebida]  (agrupa 15 s; transcreve áudio na entrada)
        │
[Só continuar se]    (humano não assumiu há 30 min; conversa não resolvida)
        │
[Agrupar mensagens]
        │
[Atender com <agente>]  ai.atender · rotasSempreHumano: ["humano"] · enviarTextoAoTransferir: true · mensagemAoTransferir: <mensagemAoCliente>
   ├─ respondeu ─► [Ainda em atendimento?] ─► [Etapa: <etapaAoAtender>] ─► (follow-up, se ativo)
   │                 bloqueia se o lead já está em <etapaAoAgendar> / Fechado / Perdido
   ├─ humano ─────► [Etapa: <etapaAoTransferir>] ─► [Transferir para atendente]
   │                 (o aviso ao lead já saiu do próprio "Atender": o texto de orientação do agente, ou a mensagem fixa se ele não escreveu)
   ├─ encerrou ───► [Resolver conversa]
   └─ agendou ────► [Etapa: <etapaAoAgendar>] ─► [Aguardar até 24h antes da reunião] ─► [Lembrete da reunião]
                    (só com agenda.ativo)

follow-up (só com followup.ativo), encadeado após "Etapa: <etapaAoAtender>", 1 trio por item de `tentativas` (≤ 5):
   [Aguardar <tentativas[i]>] ─► [Ainda cabe falar? (toque i)] ─► [Escrever toque i (ai.agent, objetivo + mensagens[i])] ─► [Enviar toque i]
   guarda: lead não falou por último · teto de toques · fora de Agendado/Com humano/Fechado/Perdido · janela (followup.janela, nos dias da agenda)
```

Ids dos nós são fixos (`gatilho`, `guardas`, `agrupar`, `atende`, `ainda_em_atendimento`,
`etapa_atender`, `etapa_transferir`, `transferir`, `resolver`, `etapa_agendar`,
`aguardar_reuniao`, `lembrete`, `fu1_espera`…): re-provisionar regrava o grafo **sem mudar
ids**, então runs dormindo (follow-up, lembrete) retomam no lugar certo. (v1.1 tirou o
`avisar_transferencia`; um run que dormia nele não existe — o bloco não dormia.)

Lembrete enviado: `Oi! Passando para lembrar: {{agenda.servico}} marcado para {{agenda.rotulo}} com {{agenda.profissional}}. Se precisar remarcar, é só me avisar por aqui.`

### 5.1 Onde o template foge da letra do contrato (e por quê)

- **Sem nó `media.transcribe`**: a transcrição acontece no gatilho (`transcreverAudio: true`),
  que segura a janela até o áudio virar texto. O nó transcreveria o mesmo áudio de novo.
- **`guard.conditions` no início** (padrão da plataforma): sem ele a IA gastaria token
  respondendo por cima de um atendente que assumiu.
- **"Ainda em atendimento?" antes de "Etapa: Em atendimento"**: aplicar etapa troca a etapa
  do lead; sem a guarda, a segunda mensagem de quem acabou de agendar voltaria o card de
  Agendado para Em atendimento.
- **`etapaAoAgendar` não é config do nó `ai.atender`** (o nó não tem esse campo): vai para
  `agenda_configuracao.etapa_ao_agendar`, que o nó lê sozinho ao marcar, e o bloco
  "Etapa: Agendado" da porta `agendou` reforça no desenho.
- **Mensagem de transferência sai do próprio "Atender com IA"** (v1.1): com
  `enviarTextoAoTransferir`, o que o agente escreveu em `mensagem_de_resposta` (1–2 frases de
  orientação) vai antes da porta `humano`; `mensagemAoTransferir` (= `transferencia.mensagemAoCliente`)
  só sai se ele não escreveu nada. Um bloco "Avisar o lead" fixo mandaria duas mensagens.
- **Follow-up** usa o trio da cadência existente, um por intervalo de `tentativas` (cada
  "Aguardar" tem o próprio valor); `{{nome}}` na mensagem é instrução ao agente (não
  interpolação): ele usa o nome do lead se souber.
- **`inboxIds` omitido grava `null`** (= todas as inboxes), não a lista do momento — uma
  inbox criada depois já entra.

## 6. Endpoints

Base: `$API` = URL do ambiente + `/api` (ex.: `https://360.gleps.com.br/api`;
local `http://localhost:3000/api`). Todas as rotas abaixo exigem
`Authorization: Bearer <JWT de super_admin>`. Respostas vêm em `{ "data": … }`;
erros em `{ "error": { "code", "message", "details?", "fieldErrors?" } }`.
O roteiro encadeado (login → accountId → POST → simular → PUT → reverter → publicar)
está na seção 1.2; aqui, cada rota em detalhe.

### 6.0 Login (super admin → token) e accountId
```sh
TOKEN=$(curl -s -X POST $API/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"<super admin da instalação>","password":"…"}' | jq -r '.data.token')
```
`data.user.role` precisa ser `super_admin`. O token expira (ver `data.expiresAt`);
use `POST /auth/refresh` com `data.refreshToken` ou faça login de novo.

O `accountId` sai de `GET /accounts` (só super admin; `?search=` filtra pelo nome):
```sh
curl -s "$API/accounts?search=Vida" -H "Authorization: Bearer $TOKEN" \
  | jq -r '.data[] | "\(.id)\t\(.nome)\t\(.status)"'      # id ⇥ nome ⇥ status
```

### 6.1 `POST /admin/provisionar/agente` — criar ou atualizar
Body `{ "accountId": "<uuid da conta>", "agentId": "<uuid, opcional>", "spec": { … } }`.
`agentId` presente **ou** `agente.nome` já existente na conta → atualiza (200). Senão cria (201).
```sh
# spec-clinica.json contém SÓ o spec; o envelope { accountId, spec } é montado pelo jq
jq -n --arg a "$ACCOUNT_ID" --slurpfile s spec-clinica.json '{accountId: $a, spec: $s[0]}' \
  | curl -s -X POST $API/admin/provisionar/agente -H "Authorization: Bearer $TOKEN" \
      -H 'Content-Type: application/json' -d @- | jq '.data'
```
Resposta:
```json
{ "data": {
  "agentId": "5f72…", "flowId": "a1b2…", "knowledgeBaseId": "c3d4…",
  "productIds": ["…", "…"],
  "etapas": { "Em atendimento": "tag-uuid", "Agendado": "tag-uuid", "Com humano": "tag-uuid" },
  "profissionais": { "carlos@clinicavidaplena.com": "user-uuid-ou-null" },
  "versao": 1,
  "avisos": [] } }
```
`avisos` que podem aparecer: profissional sem usuário; agenda desligada no agente (sem
profissional ou sem serviço); agenda sem horários; base só indexa com chave OpenAI;
fuso da conta alterado; fluxo em rascunho.

### 6.2 `GET /admin/provisionar/agente/:agentId` (v1.1: enriquecido)
```json
{ "data": { "agentId": "…", "accountId": "…", "nome": "Bia", "versao": 3, "spec": { … },
  "prompt": "IDENTIDADE\n\nVocê é Bia, da recepção e do atendimento de …",
  "flow": { "id": "…", "status": "shadow", "inboxIds": null },
  "agenda": { "ativo": true,
    "configuracao": { "antecedenciaMinimaMinutos": 120, "janelaMaximaDias": 30, "passoMinutos": 30, "holdMinutos": 5, "etapaAoAgendar": "agendado" },
    "profissionais": [ { "userId": "…", "nome": "Dr. Carlos", "email": "carlos@clinicavidaplena.com" } ] },
  "servicos": [ { "id": "product-uuid", "nome": "Consulta clínica", "valorPadrao": 250, "unidade": null, "duracaoMinutos": 30, "agendavel": true, "ativo": true },
                { "id": null, "nome": "Plano mensal", "valorPadrao": 390, "unidade": "mes", "duracaoMinutos": null, "agendavel": false, "ativo": null } ],
  "usuarios": [ { "id": "…", "nome": "Dr. Carlos", "email": "…", "role": "admin", "ativo": true } ],
  "inboxes": [ { "id": "…", "nome": "WhatsApp", "canal": "whatsapp", "ativa": true, "conectada": false, "estado": null } ],
  "ia": { "provider": "openai", "model": "gpt-4.1", "raciocinio": null, "temChave": true },
  "versoes": [ { "versao": 3, "createdAt": "…", "criadoPor": "user-uuid" }, { "versao": 2, … }, { "versao": 1, … } ] } }
```
`servicos` é o catálogo do spec: `id` é o Product (só agendável); `inboxes.conectada` = instância
Evolution `open` (`estado`: open | connecting | close | unknown | null quando não é WhatsApp
pareado). O `spec` devolvido é o **normalizado** (v1.1 com `tentativas`, `agendavel`, defaults).

### 6.3 `PUT /admin/provisionar/agente/:agentId` — body `{ "spec": { … } }`
Re-provisiona em modo atualizar (mantém ids, versão +1). Mesma resposta do POST.

### 6.4 `POST /admin/provisionar/agente/:agentId/reverter` — body `{ "versao": 1 }`
Aplica o spec daquela versão e gera uma versão **nova** (cópia). Mesma resposta do POST.
Versão inexistente → 404.

### 6.5 `POST /admin/provisionar/agente/:agentId/publicar` — body `{ "status": "draft" | "shadow" | "active" }`
```json
{ "data": { "agentId": "…", "flowId": "…", "status": "active" } }
```
`active` e `shadow` validam o grafo; `active` exige chave de IA do provider do agente
(409 `IA_SEM_CHAVE`) e rebaixa qualquer outro fluxo `active` da conta para `draft`.

### 6.6 `POST /admin/provisionar/agente/:agentId/simular` — sombra, nada grava
Body `{ "conversas": [ { "nome": "Pede humano", "mensagens": ["oi", "quero falar com uma pessoa"] } ], "maxTurnos": 12 }`
— ≤ 30 conversas, ≤ 12 mensagens cada (≤ 2000 chars), timeout 60 s por turno, conversas
**sequenciais** (v1.1). Cada mensagem do lead vira um `aiAgentService.run({ shadow: true })` com o
histórico **da própria conversa simulada** (em memória). Nenhuma Conversation, Message,
FlowRun ou CalendarEvent é criada; `consultar_horarios` lê a agenda real, mas `reservar`/`agendar`
usam um **calendário em memória da simulação** (a reserva é fingida e consistente dentro da
conversa; duas conversas no mesmo horário não se bloqueiam); `lembrar` não persiste (não há
contato). Depois de uma rota `humano` a conversa para (em produção quem responde é a pessoa).
Erro num turno encerra só aquela conversa. Cada turno traz `toolCalls: [{ nome, argumentos,
resultadoResumo }]` (v1.1 — antes era só o nome) e `efeitos` (`agendou` continua reportado).
```sh
curl -s "$API/admin/provisionar/conversas-teste/clinica" -H "Authorization: Bearer $TOKEN" \
 | jq '{conversas: [.data[] | {nome, mensagens}]}' > bateria.json
curl -s -X POST $API/admin/provisionar/agente/$AGENT/simular -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d @bateria.json
```
Resposta:
```json
{ "data": {
  "resumo": { "conversas": 12, "transferidas": 4, "agendadas": 2, "comErro": 0, "custoUsd": 0.0183, "tokens": 48210 },
  "conversas": [
    { "nome": "Pedido explícito de humano", "transferiu": true, "agendou": false, "erro": null,
      "turnos": [
        { "lead": "oi", "resposta": "Oi! Eu sou a Bia…", "rota": "respondeu", "resumo": "abriu contato", "toolCalls": [], "efeitos": {}, "custoUsd": 0.0007, "tokens": 1900 },
        { "lead": "quero falar com uma pessoa", "resposta": "Vou te passar para a equipe, que resolve isso melhor do que eu — já te respondem por aqui.", "rota": "humano", "resumo": "pediu atendente", "toolCalls": [], "efeitos": {}, "custoUsd": 0.0008, "tokens": 2100 } ] },
    { "nome": "Agendamento simples", "transferiu": false, "agendou": true, "erro": null,
      "turnos": [ …, { "lead": "sim, confirmo", "resposta": "Marcado para quinta…", "rota": "respondeu",
                      "toolCalls": [ { "nome": "agendar", "argumentos": {}, "resultadoResumo": "quinta, 16/10 às 10:00 com Dr. Carlos (simulado)" } ],
                      "efeitos": { "agendou": { "rotulo": "quinta, 16/10 às 10:00", "profissional": "Dr. Carlos", "servico": "Consulta clínica", "simulado": true, … } } } ] } ] } }
```
Com `rota: "humano"`, `resposta` é a orientação que o agente escreveu (é o que o lead recebe
antes da transferência); `null` quando ele não escreveu nada — aí o lead recebe
`transferencia.mensagemAoCliente`.

### 6.7 `GET /admin/provisionar/conversas-teste/:segmento`
`clinica | estetica | academia | servicos | outro` → 12 conversas (6 do segmento + 6 comuns), cada uma
`{ nome, mensagens[], esperado: responder|transferir|agendar|recusar, confere }`. `confere` diz o que
olhar no relatório. Segmento desconhecido → 400.

### 6.8 `GET /admin/provisionar/conta/:accountId` (v1.1) — a conta sem logar nela
```json
{ "data": {
  "conta": { "id": "…", "nome": "Clínica Vida Plena", "status": "active", "timezone": "America/Sao_Paulo", "modulos": ["extracao"],
             "openaiApiKey": "••••Ab12", "anthropicApiKey": null, "temChaveOpenai": true, "temChaveAnthropic": false, "usersCount": 3, … },
  "usuarios": [ { "id": "…", "nome": "Dr. Carlos", "email": "carlos@…", "role": "admin", "ativo": true } ],
  "inboxes": [ { "id": "…", "nome": "WhatsApp", "canal": "whatsapp", "ativa": true, "conectada": true, "estado": "open" } ],
  "ia": { "provider": "openai", "model": "gpt-4.1", "temChave": true, "temChaveOpenai": true, "temChaveAnthropic": false },
  "agentes": [ { "id": "…", "nome": "Bia", "versao": 3, "flowStatus": "shadow" } ] } }
```
`ia.provider`/`ia.model` = o que o provisionamento usaria sem `agente.provider`/`model` no spec
(OpenAI primeiro; `temChave` considera também a chave do servidor como fallback;
`temChaveOpenai`/`temChaveAnthropic` só a da conta). `conta` é a mesma resposta de
`GET /accounts/:id` — **toda chave mascarada** (seção 11). `accountId` inválido → 400; conta
inexistente → 404.

### 6.9 `PUT /admin/provisionar/conta/:accountId/ia` (v1.1) — gravar a chave de IA
Body `{ "provider": "openai" | "anthropic", "apiKey": "sk-…", "model": "gpt-4.1" }` (`model` opcional).
```json
{ "data": { "ia": { "provider": "openai", "model": "gpt-4.1", "verificado": true, "temChave": true, "temChaveOpenai": true, "temChaveAnthropic": false } } }
```
A chave NOVA é **testada no provedor antes de gravar**: recusada (401) → **400** `Chave recusada
pelo provedor; nada foi alterado.` e a chave que funcionava continua lá; outras falhas do teste
(403 de chave restrita, 429, rede) gravam com `aviso`. Depois grava
`accounts.openai_api_key`/`anthropic_api_key`, **derruba o cache de 60 s** da chave e o de
modelos (10 min), audita `account.integrations_updated` (sem o valor). `model`, se vier, é só
**conferido** com a chave nova (não há coluna de modelo na conta — o modelo de cada agente vem do
spec): inexistente → **400** `A chave foi gravada, mas: Modelo "x" não existe…` (a chave fica).
`verificado: false` + `aviso` quando o provider não respondeu a listagem (aceito por tolerância).
`apiKey` mascarada (`••••…`/`***SET***`) → 400 "apiKey veio mascarada — mande a chave real".

## 7. Erros

| HTTP | `code` | Quando |
|---|---|---|
| 400 | `VALIDATION_ERROR` | spec/corpo inválido. `message` = `Dados inválidos: spec.negocio.nome — negocio.nome é obrigatório`; `fieldErrors[]` lista todos. Também: prompt > 30k, `inboxIds` de outra conta, horários inválidos, `vendas` sem `papel: sdr`, serviço `agendavel` sem duração, `tentativas` fora de "Nh"/"Nd". **Modelo**: `Modelo "gpt-9" não existe ou a chave não tem acesso. Confira o nome do modelo e a chave de IA da conta.` (POST/PUT/reverter, antes de criar). |
| 401 | `UNAUTHORIZED`/`TOKEN_EXPIRED` | sem token / vencido |
| 403 | `SUPER_ADMIN_REQUIRED` | JWT de admin comum ou agente |
| 404 | `NOT_FOUND` | conta inexistente (`Conta não encontrada`), agente não provisionado, versão inexistente, fluxo do agente apagado |
| 409 | `IA_SEM_CHAVE` | conta sem chave de IA do provider do agente — em **POST/PUT/reverter** (`Configure a chave OpenAI ou Anthropic da conta em Integrações`), em **`/simular`** (não roda nenhum turno) e em **`/publicar active`**. Chave recém-salva pode levar ~60 s para valer (cache). |
| 409 | `CONFLICT` | nome de base/fluxo colidindo com um criado à mão com outro dono |
| 500 | `FLUXO_INVALIDO` | o template não passou em `validateGraph` — defeito da plataforma, reporte |

## 8. O que o kit NÃO deve fazer

- **Não editar o grafo à mão** (nem por `PATCH /flows/:id`): o próximo PUT/reverter regrava o
  desenho inteiro e a edição some. Tudo que o fluxo faz vem do spec.
- **Não publicar `active` sem simular** com a bateria do segmento e ler `confere` de cada conversa.
- **Não usar JWT de admin comum** nem API key: 403.
- **Não criar agente/base/serviço/etapa pelas rotas de conta** (`/ai/agents`, `/products`…)
  para "ajudar" o provisionamento — ele acha pelo nome e passa a sobrescrever.
- **Não mandar FAQ/textos longos dentro de `negocio.sobre` ou `regras`**: isso vai para o
  prompt (teto 30k e custo em toda mensagem). Conhecimento vai em `conhecimento.*`.
- **Não assumir que a base está indexada** logo após o POST: a indexação é assíncrona e
  precisa de chave OpenAI (aviso na resposta). Simule depois de alguns segundos.
- **Não repetir o nome de outro agente** da conta com outro briefing: `agente.nome` é a
  chave — provisionar "Bia" de novo atualiza a Bia.

## 9. Ambiente (quem sobe a plataforma)

- Migration `0075_agente_spec` (colunas `ai_agents.spec`, `ai_agents.spec_versao` e tabela
  `agent_spec_versions`) é idempotente e está na lista que o `start.sh` reaplica a cada boot.
- **Dono da tabela no Postgres**: `agent_spec_versions` precisa pertencer ao usuário que o app
  usa na `DATABASE_URL`. Em produção o `start.sh` roda como esse usuário e a tabela já nasce
  dele. Em ambiente local, se a migration foi aplicada por um superusuário (`psql -d gleps_crm
  -f …`), rode uma vez: `ALTER TABLE agent_spec_versions OWNER TO <usuario_do_app>;` — senão o
  POST falha com erro de permissão ao gravar a versão.
- Chaves de IA ficam na conta (`accounts.openai_api_key` / `anthropic_api_key`) ou, como
  fallback, nas variáveis `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` do servidor.
- Migration `0076_agente_raciocinio` (coluna `ai_agents.reasoning_effort`) é idempotente e
  está no `start.sh`.

## 9b. Modelos (v1.1)

- **Quais**: qualquer modelo que a chave da conta alcance. O provisionamento confere em
  `GET /v1/models` da OpenAI (cache 10 min por conta **e chave** — trocar a chave muda a entrada)
  ou numa tabela fixa de famílias Anthropic (`claude-3-5-*`, `claude-3-7-sonnet`,
  `claude-opus-4*`, `claude-sonnet-4*`, `claude-haiku-4*`, `claude-*-5*`). Falha de rede e **403**
  (chave restrita, sem permissão de listar) não bloqueiam (aceita com `aviso`, `verificado:
  false`); **401** bloqueia com `A chave OpenAI da conta é inválida…` (não a mensagem de modelo
  inexistente).
- **Padrão**: `gpt-4.1` quando `agente.model` é omitido e o provider é OpenAI (venda). O PATCH
  manual do agente (`/ai/agents`) continua com o padrão do provider (`gpt-4o-mini`). Anthropic
  sem modelo → padrão do provider.
- **Raciocínio**: para todo `gpt-5*` (5, 5-mini, 5.1, 5.2, 5.4-mini…) e a série `o1`–`o9` o motor
  manda `max_completion_tokens` (4x o limite do agente, piso 8192) em vez de `max_tokens`, **não**
  manda `temperature`, e passa `reasoning_effort` = `agente.raciocinio`
  (`minimal | low | medium | high`; `minimal` só no gpt-5 original — nos demais vira `low`; os
  `*-chat` não recebem o campo). Resposta `length` com texto vazio: repete UMA vez com `low` e o
  dobro do limite. Nos outros modelos `raciocinio` é ignorado.
- **Custo**: a tabela de preços do motor tem gpt-4.1, gpt-4.1-mini, gpt-4.1-nano, gpt-5, gpt-5-mini,
  gpt-5-nano, o4-mini (valores públicos de 2026); o nome casa inteiro ou com carimbo de versão
  (`gpt-5-mini-2025-08-07`) — `gpt-5.1-mini` **não** é o `gpt-5`. Modelo sem preço conhecido vem
  com `priced: false` no `usage` (custo não é zero, é desconhecido).

## 11. Segurança — máscara de segredos (v1.1)

- **Nenhuma leitura devolve chave em texto puro**: `GET /accounts`, `GET /accounts/:id`,
  `GET /accounts/:id/stats`, `POST/PUT /accounts`, `pause`/`activate`, `GET /admin/provisionar/conta/:id`,
  `POST /auth/login`, `GET /auth/me`. Todo campo `openaiApiKey`, `anthropicApiKey`,
  `evolutionApiKey`, `evolutionWebhookSecret`, `sendgridApiKey`, `googleClientSecret`,
  `twilioAccountSid`, `twilioAuthToken`, `twilioApiKeySid`, `twilioApiKeySecret`, `sipPassword` — e
  qualquer `*Secret|*Token|*Password|*ApiKey|*Senha` futuro — sai como **`••••` + 4 últimos**
  (`••••Ab12`) quando o valor tem 12+ caracteres, senão só `••••`; vazio sai `null`. `temChaveOpenai` / `temChaveAnthropic` (boolean) dizem se existe.
- **Escrita continua aceitando o valor real**. Se o cliente devolver o valor **mascarado** no
  `PUT /accounts/:id` (`••••Ab12` ou a sentinela antiga `***SET***`), o campo é **ignorado** —
  nunca grava a máscara por cima da chave. `null`/`""` limpa de verdade.
- **Senha igual ao e-mail**: o login funciona, mas o servidor registra `warn` `[auth] senha igual
  ao e-mail — peça ao usuário para trocar a senha` com o `userId`.

## 10. Aceite (o que o QA confere no navegador depois do curl)

`/admin/ia/agentes` mostra o agente com o prompt por seções (CATÁLOGO com unidade; COMO VENDER
se `papel: sdr`); `/admin/ia/fluxos` tem "Atendimento — Bia" em **sombra** com as quatro portas
ligadas como no desenho da seção 5 (sem "Avisar o lead"); Agenda lista só os serviços agendáveis,
com duração, e o profissional ativo; Kanban tem Em atendimento / Agendado / Com humano antes de
Fechado / Perdido; `/simular` devolve o relatório (com `toolCalls` detalhados e sem
`calendar_events` depois); `/reverter` volta a versão; `/publicar active` só com chave de IA;
`GET /accounts/:id` sem nenhuma chave em texto puro; modelo inexistente → 400 no POST.
