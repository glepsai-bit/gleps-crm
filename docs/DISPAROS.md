# Disparos — motor único com fila no banco

> ETAPA D (07/10/2026). Substitui os dois motores antigos (`prospecting.dispatch`
> em memória e `whatsapp-campaign` com cron de 5 min). Código:
> `backend/src/services/disparo.service.ts` (regras de negócio),
> `disparo/regras.ts` (funções puras), `disparo.worker.ts` (fila),
> `disparo-anexo.service.ts` (anexos), `disparo/contexto.ts` (bloco pro agente),
> `conversa-saida.service.ts` (conversa no Chat — compartilhado com a prospecção).

## Como funciona

1. **Criar** decide tudo de uma vez: monta a lista (público salvo | leads do
   CRM por etapa/tags | números colados), normaliza telefone
   (`utils/telefone.ts`: sempre `55DDD9XXXXXXXX`), tira **repetidos**,
   **inválidos** e **opt-out** (`whatsapp_consents.status='opted_out'`),
   escolhe o **número** de cada contato e calcula a **hora mínima**
   (`nao_antes_de`). Grava `disparos` + uma linha por contato em
   `disparo_envios` (os pulados também, com `status='pulado_*'`).
2. **Worker** (`iniciarWorkerDeDisparos()`, 15 s): numa transação curta pega o
   cadeado `pg_try_advisory_xact_lock(hashtext('disparos-worker'))` (réplica
   que não pega, sai), devolve à fila envios presos em `enviando` há mais de
   10 min, promove `agendado` → `enviando` quando `agendado_para` venceu, e
   faz o claim: `UPDATE disparo_envios SET status='enviando' WHERE id IN
   (SELECT … WHERE status='pendente' AND d.status='enviando' AND
   nao_antes_de <= now() ORDER BY nao_antes_de LIMIT 20 FOR UPDATE OF e SKIP
   LOCKED)`. Depois, um a um: confere a conexão da inbox (cache 60 s), renderiza
   a variante, `sendText`, grava conversa+mensagem no Chat com
   `conversations.disparo_id`, status `enviada`, `aquecimento.registrarEnvioExterno`,
   e, se houver anexo, espera 3–8 s e manda `sendMedia`/`sendWhatsAppAudio`.
   Disparo sem pendentes vira `concluido`.

## Regras

- **Rodízio**: peso = `restantesHoje` de cada número (do aquecimento); todos
  zerados → pesos iguais. Contato que já tem conversa por um dos números
  escolhidos fica **preso** a ele.
- **Ritmo**: o primeiro de cada número sai na partida; os seguintes somam
  20–60 s aleatórios. **Janela 08h–20h** no fuso da conta: antes das 8 → 8h;
  20h ou depois → 8h de amanhã. **Cota**: hoje vale `restantesHoje`; estourou
  → 8h do dia seguinte com `limiteDiario` (0 → 50, "não aquecido").
- **Variantes**: `[texto, ...variantes][k % total]`. Variáveis
  `{{nome}} {{primeiro_nome}} {{empresa}}` (e `{nome}` legado); vazia some.
- **Falhas**: INFRA (rede, timeout, 5xx, 401/403, instância desconectada) não
  conta — o envio volta pra `pendente` em +5 min, e os outros do mesmo número
  na rodada também. NÚMERO (4xx, "not on whatsapp", "invalid jid"…) →
  `falhou`, `disparos.falhas++`, `falhas_seguidas[inboxId]++`; na 5ª seguida
  os pendentes daquele número vão pros outros números do disparo (recalculando
  horário) ou, se era o único, o disparo fica `pausado` com motivo. Retomar
  zera `falhas_seguidas` e reprograma os pendentes a partir de agora.
- **Respostas**: `atende_respostas='humano'` marca
  `customAttributes.human_active=true` na conversa (a MESMA flag do live
  attendance e do circuit breaker da IA — não existe coluna nova). `'agente'`
  deixa o fluxo do inbox responder, com o bloco **CONTEXTO DO DISPARO** no
  prompt. "Responderam" = inbound na conversa → `respondeu` (uma vez por envio).
- **Ack**: `atualizarStatusPorMsgId(id, 'entregue'|'lida')` só sobe.
- **Contagens** em `disparos`: `total` = quem vai receber; `optout` = pulados
  por opt-out; `pulados` = repetidos + inválidos; `enviadas`, `falhas`,
  `respondidas`.

## Endpoints (`/api/disparos`, JWT + módulo `disparos` + admin/super_admin)

| Método | Rota | Corpo / query | Resposta (`{ data }`) |
|---|---|---|---|
| GET | `/` | — | `{ emAndamento: Disparo[], concluidos: Disparo[] }` (últimos 30 dias) |
| GET | `/numeros` | `?contatos=N` | `{ numeros: [...], optouts, estimativa }` |
| POST | `/preview-lista` | `{ lista }` | `{ total, vaoReceber, optout, duplicados, invalidos }` |
| POST | `/` | `{ nome?, texto, variantes?, anexo?, lista, inboxIds, atendeRespostas?, agendadoPara? }` | `Disparo` (201) |
| POST | `/variar` | `{ texto }` | `{ variantes: string[] }` (409 sem chave de IA) |
| POST | `/anexos` | multipart `file` | `{ id, tipo, nome, mime, tamanho }` |
| GET | `/:id` | `?page=N&status=X` | `{ disparo, envios[], paginacao }` (100/página) |
| POST | `/:id/pausar` · `/retomar` · `/cancelar` · `/reenviar-nao-respondidos` | — | `{ disparo }` |

`lista`: `{tipo:'publico', audienceId}` · `{tipo:'leads', etapaTagId?, tagIds?}`
· `{tipo:'numeros', linhas: string[]}` (cada linha `Nome;telefone` ou só o
telefone, até 2000). Anexo: imagem jpg/png/webp ≤ 2 MB, PDF ≤ 5 MB, áudio
ogg/mp3/m4a ≤ 2 MB, validado por magic bytes, em `uploads/disparos/<conta>/`.

## Pontos de ligação (o lead liga)

1. `server.ts`: `iniciarWorkerDeDisparos()` no boot.
2. `evolution.controller.ts › processMessageUpdate`: `disparoService.atualizarStatusPorMsgId(externalId, 'entregue'|'lida')`.
3. `evolution.controller.ts › inbound persistido`: `disparoService.registrarRespostaDeDisparo(conversation.id)` e, se `disparoService.atendimentoHumano(conversation)`, não chamar `flowService.onInboundMessage`.
4. `ai-agent.service.ts`: já ligado — `contextoDoDisparoParaAgente(conversationId)` entra como bloco "CONTEXTO DO DISPARO".
