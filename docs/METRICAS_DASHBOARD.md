# Documentação das Métricas do Dashboard de Atendimento

> Última atualização: 2026-03-02

Este documento descreve **cada métrica exibida no Dashboard de Atendimento**, incluindo a regra de negócio, a fonte de dados e o critério de cálculo.

---

## Sumário

1. [Visão Geral da Arquitetura](#visão-geral-da-arquitetura)
2. [KPIs Principais (Linha 1)](#kpis-principais)
3. [Atendimento em Tempo Real](#atendimento-em-tempo-real)
4. [Resolução (Histórico)](#resolução-histórico)
5. [Taxas Calculadas](#taxas-calculadas)
6. [Pico por Hora](#pico-por-hora)
7. [Backlog Humano](#backlog-humano)
8. [Performance de Agentes](#performance-de-agentes)
9. [Qualidade & Conversão](#qualidade--conversão)
10. [Filtros e Período](#filtros-e-período)
11. [Glossário](#glossário)

---

## Visão Geral da Arquitetura

O dashboard opera em **duas camadas temporais**:

| Camada | Escopo Temporal | Descrição |
|--------|----------------|-----------|
| **Atendimento ao Vivo** | Tempo real (ignora filtro de data) | Mostra quem está atendendo **agora** — conversas com status `open` |
| **Histórico & Resolução** | Filtrado por período selecionado | Mostra o que aconteceu no período — volume, resoluções, performance |

**Fonte de dados**: API do Chatwoot (`/api/v1/accounts/{id}/conversations`, `/agents`, `/inboxes`) + tabela `resolution_logs` no PostgreSQL.

---

## KPIs Principais

### 1. Total de Leads

| Campo | Detalhe |
|-------|---------|
| **O que mostra** | Quantidade de contatos únicos que tiveram atividade no período |
| **Cálculo** | Contagem de `sender.id` distintos entre todas as conversas filtradas pelo período |
| **Critério de inclusão** | Conversa criada OU com última atividade dentro do período selecionado |
| **Fonte** | `conv.meta.sender.id` das conversas da API do Chatwoot |

```
Total de Leads = COUNT(DISTINCT sender.id) das conversas no período
```

### 2. Novos Leads

| Campo | Detalhe |
|-------|---------|
| **O que mostra** | Contatos que **nunca fizeram contato antes** — foram registrados no Chatwoot dentro do período |
| **Cálculo** | Para cada contato com conversa no período, busca o `created_at` do contato via **API de Contatos do Chatwoot** (`GET /api/v1/accounts/{id}/contacts/{contact_id}`). Se `contact.created_at` está dentro do período selecionado, o contato é um Novo Lead |
| **Fonte** | Campo `created_at` da API de Contatos do Chatwoot — imutável, representa a data de registro do contato na plataforma. Não depende de paginação de conversas nem de tabelas do banco (`contacts`, `first_resolved_at`) |

```
Novos Leads = contatos cujo created_at na API de Contatos do Chatwoot
              está dentro do período selecionado
```

### 3. Retornos no Período

| Campo | Detalhe |
|-------|---------|
| **O que mostra** | Contatos que já existiam antes do período e voltaram a fazer contato |
| **Cálculo** | `Total de Leads - Novos Leads` (nunca negativo) |
| **Fonte** | Derivado dos dois KPIs anteriores |

```
Retornos = MAX(0, Total de Leads - Novos Leads)
```

### 4. Agendamentos

| Campo | Detalhe |
|-------|---------|
| **O que mostra** | Eventos do tipo `meeting` ou `appointment` no calendário dentro do período |
| **Cálculo** | Contagem de eventos do calendário local filtrados por tipo e data |
| **Filtro de agente** | Se um agente está selecionado, mostra apenas os eventos criados por ele |
| **Fonte** | Módulo de calendário local (não vem do Chatwoot) |

```
Agendamentos = COUNT(events) WHERE type IN ('meeting', 'appointment') AND start IN período
```

### 5. Tempo Médio de Resposta

| Campo | Detalhe |
|-------|---------|
| **O que mostra** | Tempo médio entre a criação da conversa e a primeira resposta de um agente humano |
| **Cálculo** | Média de `(first_reply_created_at - created_at)` para conversas com agente humano atribuído |
| **Exclusões** | Conversas sem `first_reply_created_at` ou com tempo negativo são ignoradas |
| **Formato** | Exibido como `Xs`, `Xm Ys`, ou `Xh Ym` |
| **Fonte** | Campos `created_at` e `first_reply_created_at` da API do Chatwoot |

```
Tempo Médio = MÉDIA(first_reply_created_at - created_at) para conversas com assignee humano
```

### 6. Taxa de Transbordo

| Campo | Detalhe |
|-------|---------|
| **O que mostra** | Percentual de conversas iniciadas pela IA que foram finalizadas por um humano |
| **Cálculo** | `transbordo_finalizado / (resoluções_IA + transbordo_finalizado) * 100` |
| **Definição de transbordo** | Conversa resolvida por humano onde houve participação prévia da IA (`ai_responded`, `ai_participated`, ou `handoff_to_human` = true) |
| **Fonte** | Tabela `resolution_logs` ou fallback via metadados da conversa |

```
Taxa Transbordo = transbordo / (resoluções_IA + transbordo) * 100
```

---

## Atendimento em Tempo Real

> Card "Atendimento Agora" — **ignora filtro de data**, mostra apenas conversas com `status = 'open'`

| Métrica | Critério |
|---------|----------|
| **Total** | Todas as conversas abertas (`status = 'open'`) |
| **IA** | Conversas onde o handler atual é IA (ver classificação abaixo) |
| **Humano** | Conversas onde o handler atual é humano |
| **Sem Assignee** | Conversas abertas sem IA confirmada nem humano atribuído |

### Classificação do Handler Atual (`classifyCurrentHandler`)

A função avalia os metadados da conversa na seguinte ordem de prioridade:

| Prioridade | Condição | Resultado |
|-----------|----------|-----------|
| 1 | `human_active`, `handoff_to_human`, ou `human_intervened` = true | **Humano** |
| 2 | Assignee é do tipo `AgentBot` | **IA** |
| 3 | `ai_responded` = true E não há assignee humano | **IA** |
| 4 | `ai_responded` = true E há assignee humano | **Humano** |
| 5 | Há assignee humano | **Humano** |
| 6 | Nenhuma condição atendida | **Sem Assignee** |

Os campos são lidos de `custom_attributes` e `additional_attributes` da conversa.

---

## Resolução (Histórico)

> Card "Resolução" — **respeita filtro de data**, analisa conversas resolvidas no período

### Fonte de dados (em ordem de prioridade)

1. **Tabela `resolution_logs`** (PostgreSQL): Registros persistentes de quem resolveu cada conversa, populados pelo n8n ou pelo próprio backend durante a sincronização.
2. **Fallback via API**: Se `resolution_logs` está vazia ou indisponível, o sistema classifica cada conversa resolvida usando `classifyResolver`.

### Classificação de Resolução (`classifyResolver`)

Para cada conversa com `status = 'resolved'`:

| Prioridade | Condição | Resultado |
|-----------|----------|-----------|
| 1 | `resolved_by = 'ai'` (custom/additional attributes) | IA (explícito) |
| 2 | `resolved_by = 'human'` (custom/additional attributes) | Humano (explícito) |
| 3 | Assignee é `AgentBot` ou tem `agent_bot_id` | IA (bot nativo) |
| 4 | `ai_responded = true` + assignee humano | Humano (inferido) |
| 5 | `ai_responded = true` + sem assignee humano | IA (inferido) |
| 6 | Tem assignee humano | Humano (fallback) |
| 7 | Nenhuma condição atendida | Não classificado |

### Métricas exibidas

| Métrica | Cálculo |
|---------|---------|
| **Total Resolvidas** | IA + Humano |
| **Resolvidas por IA** | Contagem de resoluções classificadas como IA (explícito + bot nativo + inferido) |
| **Resolvidas por Humano** | Contagem de resoluções classificadas como Humano (explícito + inferido) |
| **Transbordo Finalizado** | Resoluções humanas onde IA participou previamente |

---

## Taxas Calculadas

| Taxa | Fórmula | Descrição |
|------|---------|-----------|
| **% Resolução IA** | `resoluções_IA / (resoluções_IA + resoluções_humano) * 100` | Proporção das resoluções feitas pela IA |
| **% Resolução Humano** | `100 - % Resolução IA` | Proporção das resoluções feitas por humanos |
| **Taxa de Transbordo** | `transbordo / (resoluções_IA + transbordo) * 100` | % de conversas que a IA iniciou mas humano finalizou |
| **Eficiência da IA** | `resoluções_IA / total_resolvidas * 100` | % de todas as resoluções que a IA resolveu sozinha |

---

## Pico por Hora

| Campo | Detalhe |
|-------|---------|
| **O que mostra** | Distribuição horária das conversas criadas no período |
| **Cálculo** | Para cada conversa criada dentro do período, extrai a hora (0-23) no fuso `America/Sao_Paulo` e incrementa o contador |
| **Fonte** | Campo `created_at` das conversas da API do Chatwoot |

```
Para cada hora (0-23):
  picoPorHora[hora] = COUNT(conversas criadas nessa hora no período)
```

---

## Backlog Humano

> **Ignora filtro de data** — mostra o estado atual da fila

| Campo | Detalhe |
|-------|---------|
| **O que mostra** | Conversas abertas atribuídas a agentes humanos, agrupadas por tempo de espera |
| **Cálculo do tempo de espera** | `agora - waiting_since` (se disponível) ou `agora - last_activity_at` |

| Faixa | Critério |
|-------|----------|
| **Até 15 min** | Tempo de espera ≤ 15 minutos |
| **15 a 60 min** | 15 < tempo de espera ≤ 60 minutos |
| **Acima de 60 min** | Tempo de espera > 60 minutos |

---

## Performance de Agentes

| Métrica | Cálculo |
|---------|---------|
| **Atendimentos Assumidos** | Conversas no período onde o agente é o assignee |
| **Atendimentos Resolvidos** | Conversas com `status = 'resolved'` onde o agente é o assignee |
| **Tempo Médio de Resposta** | Média de `(first_reply_created_at - created_at)` das conversas do agente |
| **Taxa de Resolução** | `resolvidos / assumidos * 100` |

Apenas agentes com pelo menos 1 conversa atribuída são exibidos na tabela.

---

## Qualidade & Conversão

| Métrica | Cálculo | Status |
|---------|---------|--------|
| **Conversas Sem Resposta** | Conversas abertas onde `agent_last_seen_at = null` | ✅ Funcional |
| **Taxa Atendimento → Venda** | Fixo em `0%` | ⏳ Pendente (requer integração com módulo financeiro) |

---

## Filtros e Período

### Períodos disponíveis

| Filtro | Intervalo |
|--------|-----------|
| **7 dias** | `startOfDay(hoje - 7)` até `endOfDay(hoje)` |
| **30 dias** | `startOfDay(hoje - 30)` até `endOfDay(hoje)` |
| **Personalizado** | Datas escolhidas pelo usuário, normalizadas para início/fim do dia |

### Critério de inclusão de conversas no período

Uma conversa é incluída no período se:
- `created_at` está dentro do intervalo

Ações administrativas (etiquetas, atribuições de agente, mudanças de status) **NÃO** inflam a contagem de leads no período, pois alteram apenas `last_activity_at` e não `created_at`. Isso evita que ações no Kanban ou no painel do Chatwoot inflem artificialmente os KPIs.

### Filtros adicionais

| Filtro | Efeito |
|--------|--------|
| **Canal** | Filtra por `inbox_id` (WhatsApp, Instagram, Webchat) |
| **Agente (via tabela)** | Clique no nome do agente na tabela de performance para filtrar KPIs pelo agente selecionado |

---

## Conversas por Canal

| Campo | Detalhe |
|-------|---------|
| **O que mostra** | Quantidade de conversas por inbox/canal do Chatwoot |
| **Cálculo** | Para cada inbox, conta conversas no período com `inbox_id` correspondente |
| **Mapeamento** | `Channel::Whatsapp` → whatsapp · `Channel::Instagram` / `Channel::FacebookPage` → instagram · `Channel::WebWidget` → webchat |

---

## Glossário

| Termo | Definição |
|-------|-----------|
| **Sender** | O contato/cliente que iniciou a conversa |
| **Assignee** | O agente (humano ou bot) atribuído à conversa |
| **AgentBot** | Bot nativo do Chatwoot configurado como atendente |
| **Transbordo** | Quando uma conversa iniciada pela IA é transferida e finalizada por um humano |
| **Resolution Log** | Registro persistente no banco de dados indicando quem resolveu cada conversa |
| **custom_attributes** | Campos personalizados da conversa no Chatwoot (usados por n8n/automações) |
| **additional_attributes** | Campos adicionais da conversa no Chatwoot |
| **first_resolved_at** | *(Legado — não mais usado para cálculo de Novos Leads)* Data do primeiro contato do lead, anteriormente usada para distinguir novos leads de retornos. Substituída pela análise do histórico completo de conversas via API do Chatwoot |
