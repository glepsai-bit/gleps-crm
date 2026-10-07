# Aquecimento de números WhatsApp

Motor: `backend/src/services/aquecimento.service.ts` (cron de 60 s em `server.ts`).
Roteiros: `backend/src/services/aquecimento/roteiros.ts`. Migration: `0070_aquecimento_simples`.

## Regras
- Sem pool, sem estratégia, sem IA, sem mídia. Todos os números em aquecimento da conta conversam entre si — **precisa de 2** (com 1, o número fica `aguardando_parceiro`).
- O número é uma **inbox WhatsApp do Chat** conectada (Evolution `state=open`); o telefone vem do `fetchInstances`.
- Janela **08h–20h no fuso da conta**; intervalos irregulares (40% das rodadas são puladas; meta do dia proporcional ao tempo de janela decorrido).
- Conversa com cara de gente: roteiro curto sorteado (≥ 25, 2–6 linhas, A/B alternando). Quem responde marca a última mensagem como lida, mostra "digitando" por 3–8 s e manda a linha da vez; a resposta do outro é agendada para **1–5 min** depois. Roteiro acabou → conversa encerra.
- Mensagens de aquecimento **nunca entram no inbox nem acionam IA**: o webhook da Evolution consulta `ehNumeroDeAquecimento(accountId, telefone)` antes de criar contato/conversa/mensagem (inbound e eco `fromMe`), e também antes do opt-out por palavra-chave.

## Rampa (30 dias)
| Dias | Mensagens/dia |
|---|---|
| 1–7 | 10, 12, 15, 20, 25, 30, 40 |
| 8–14 | 50 → 80 (linear) |
| 15–21 | 100 → 180 (linear) |
| 22–30 | 200 |
| 31+ | **Pronto** (`status warm`, `modo manutencao`): 20/dia de aquecimento e limite de 200/dia para Disparos |

A virada de dia é por fuso da conta, com compare-and-swap no `currentDay` (duas réplicas não avançam dois dias). Zera `enviadas`, `recebidas` e `disparosHoje` e grava `WarmupDailyStats`.

## Erros
- **Infra** (timeout, rede, 5xx, 401/403, 429, instância desconectada, erro desconhecido): `accounts.warmup_infra_pausa_ate = agora + 15 min`. O número **não** é tocado; a conversa pendente fica para depois.
- **Número** (400/404, "not on whatsapp", "exists: false", "invalid jid", blocked, ban, telefone inválido): `falhas_seguidas++`, `WarmupMessage failed`; **5 seguidas pausam só esse número** ("5 falhas seguidas no envio"). Sucesso zera.
- **Retomar** zera as falhas, limpa a pausa e mantém o dia.
- `saude`: `boa` (0 falhas) · `atencao` (1–4) · `pausado`.

## Capacidade para Disparos
`capacidadeDoNumero(accountId, inboxId)` → `{ status, dia, limiteDiario, restantesHoje }`
- `pronto`: 200 − (enviadas de aquecimento + disparosHoje)
- `aquecendo`: plano do dia − enviadas − disparosHoje (mín. 0)
- `pausado`: 0 · `nao_aquecido` (inbox sem registro): 50

`registrarEnvioExterno(accountId, inboxId, qtd = 1)` soma em `disparosHoje`.

## Endpoints (`/api/aquecimento`, admin/super_admin, módulo `aquecimento`)
| Método | Rota | Devolve (`data`) |
|---|---|---|
| GET | `/` | `{ numeros: NumeroAquecimento[], agora: { proximaRodadaEm, janela, trocadasHoje, falhasHoje, infraPausaAte } }` |
| GET | `/inboxes-disponiveis` | `[{ id, nome, telefone, status, conectada, motivo }]` (desconectadas vêm com `conectada=false`) |
| POST | `/numeros` `{ inboxId }` | `{ numero }` — 400 desconectada/sem telefone, 409 já existe |
| POST | `/numeros/:id/pausar` · `/retomar` | `{ numero }` |
| DELETE | `/numeros/:id` | 204 |
| GET | `/numeros/:id/historico` | 30 itens `{ date, planned, actual, receives, failed }` (zeros nos dias sem registro; hoje vem dos contadores ao vivo) |

`NumeroAquecimento`: `id, inboxId, inboxNome, telefone (E.164), status ('aquecendo'|'pronto'|'pausado'|'aguardando_parceiro'), dia (1..30), modo, hoje {planejadas, enviadas, recebidas, disparos}, saude, falhasSeguidas, pausadoMotivo, pausadoEm, prontoEm, limiteDiario, restantesHoje`.

As rotas antigas `/api/warmup` continuam montadas até a etapa C; o motor antigo (`whatsapp-warmup.service`) não é mais chamado pelo cron.
