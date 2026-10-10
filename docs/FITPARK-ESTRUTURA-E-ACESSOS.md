# Estrutura de acessos por cliente — feature "Acesso total às conversas" + montagem do FitPark

> **Status:** proposta aprovada, **ainda não implementada** (nada de código foi escrito).
> Este documento explica **o que muda no produto** (Parte 1, genérica — serve pra qualquer
> cliente) e **como o cliente FitPark fica montado** com isso (Partes 2 a 5).
>
> Contexto que não muda: **toda integração com a Pacto e com planilhas vive no n8n.**
> O CRM continua genérico — ele só recebe "mande essa campanha pra esses contatos" e
> "essa conversa é dessa pessoa". Ele nunca precisa saber o que é "Pacto".

---

## O problema que a gente precisa resolver

Hoje o sistema tem **3 papéis**: `super_admin`, `admin`, `agent`. E a regra de **quem vê
quais conversas** é fixa pelo papel ([conversation.service.ts:253-284](../backend/src/services/conversation.service.ts#L253-L284)):

- `admin` / `super_admin` → veem **todas** as conversas da conta.
- `agent` → vê **só** as conversas onde é o responsável, participante, ou membro do time dono.

O FitPark (e vários outros clientes) tem um papel **no meio disso** que hoje **não existe**:
a **recepção**, que precisa **ver todas as conversas** pra fazer triagem, **mas não pode**
mexer em configuração da conta nem criar usuários (isso é só da administração).

Hoje, pra recepção ver tudo, ela teria que virar `admin` — e aí ganharia poder demais.

---

# Parte 1 — A mudança no produto (genérica)

## A ideia, em uma frase

Criar uma permissão nova, **"Acesso total às conversas"**, que um admin liga com **um clique**
ao criar/editar um usuário. Quem tem essa permissão **vê todas as conversas da conta** —
sem precisar ser admin.

É um recurso de produto, **não** uma gambiarra pro FitPark. Qualquer cliente que tenha
recepção, supervisor, coordenador de atendimento ou "quem cobre todo mundo" vai usar.

## Como fica amigável pra quem usa (a UI)

Na tela de **criar/editar usuário**, as permissões já aparecem agrupadas por área
(Atendimento, Vendas, Relatórios…). A permissão nova entra no grupo **Atendimento**,
como um toggle simples:

```
Atendimento
  ☑ Kanban
  ☑ Leads
  ☑ Conversas (chat)
  ☑ Acesso total às conversas   ← NOVA
      "Vê e atende qualquer conversa da conta, mesmo as de outros atendentes.
       Ideal pra recepção / supervisão. Não dá poder de administrador."
```

Sem esse toggle → o atendente vê só o que for **designado a ele** (comportamento atual).
Com o toggle → vê tudo. Simples assim, o admin do cliente resolve sozinho na tela.

### Opcional (deixa ainda mais fácil): perfis prontos

Pra não obrigar o admin a marcar permissão por permissão, dá pra oferecer **3 botões de
perfil** no topo do formulário que já deixam tudo marcado:

- **Recepção** → Conversas + **Acesso total às conversas** + módulos de atendimento.
- **Comercial** → Conversas + Leads/Kanban (só as designadas a ele).
- **Administração** → papel `admin` (tudo).

O admin clica no perfil, ajusta um detalhe se quiser, e salva. Isso também é genérico e
reaproveitável por todo cliente.

## Onde isso encosta no código (pra quem for implementar)

São poucos pontos, todos pequenos. **Nenhuma migration destrutiva** — a permissão é só
mais uma string no array `permissions` que o usuário já tem
([schema.prisma:243-244](../backend/prisma/schema.prisma#L243-L244)); nada muda no banco.

| # | Arquivo | O que fazer |
|---|---------|-------------|
| 1 | [src/config/permissions.config.ts:8-40](../src/config/permissions.config.ts#L8-L40) | Adicionar `CONVERSATIONS_ALL: 'conversations_all'` em `PERMISSIONS` e incluir no grupo **Atendimento** ([:53-56](../src/config/permissions.config.ts#L53-L56)) com o rótulo amigável. |
| 2 | `backend/src/types/index.ts:93` (`ALL_PERMISSIONS`) | Adicionar `'conversations_all'` à lista do backend (hoje ela **diverge** da do frontend — aproveitar e reconciliar). |
| 3 | [conversation.service.ts:256](../backend/src/services/conversation.service.ts#L256) | O filtro que hoje é `if (actor && actor.role === 'agent')` passa a **pular** a restrição quando o agente tem a permissão: `if (actor && actor.role === 'agent' && !actor.permissions?.includes('conversations_all'))`. Ou seja: agente com a permissão cai no mesmo caminho de "vê tudo". |
| 4 | Mesmo arquivo: `get()` individual ([:358-360](../backend/src/services/conversation.service.ts#L358-L360)) e os guards de ação `ensureConversationAccess` / `assertAgentCanAccess` ([:411-465](../backend/src/services/conversation.service.ts#L411-L465)) | Aplicar a **mesma** checagem, senão a recepção **lista** todas mas não consegue **abrir/agir** nelas. |
| 5 | Objeto `actor` (montado do `req.user` no controller de conversas) | Garantir que ele carregue `permissions`. Se hoje só leva `userId` + `role`, incluir `permissions`. É o único ponto que pode exigir 1 linha a mais fora dos acima. |

> **Regra de ouro pra quem implementar:** o ponto de verdade é o **backend**
> ([conversation.service.ts:256](../backend/src/services/conversation.service.ts#L256)).
> A permissão no frontend só controla menu/navegação — a visibilidade real das conversas
> é decidida no serviço. Sem os itens 3 e 4, a coisa **parece** funcionar (aparece o menu)
> mas a lista continua vazia.

---

# Parte 2 — Como o FitPark fica montado

## Papéis

| Grupo | Papel no sistema | Enxerga |
|-------|------------------|---------|
| **Administração** | `admin` | Tudo + gerencia a conta (usuários, config) |
| **Recepção** | `agent` + permissão **Acesso total às conversas** | **Todas** as conversas — mas **não** mexe em config/usuários |
| **Comercial** | `agent` (carteira individual) | **Só** as conversas designadas a ela |

## Usuários

| Nome | Papel | Time | Permissões-chave | O que vê |
|------|-------|------|------------------|----------|
| Jessica Silva | `admin` | — | (todas) | Tudo + administra a conta |
| Jessica Eneia | `admin` | — | (todas) | Tudo + administra a conta |
| Lorrayne | `agent` | Recepção | Conversas + **Acesso total** + atendimento | **Todas** as conversas |
| Jheniger² | `agent` | Recepção | idem | **Todas** as conversas |
| Anna Julia | `agent` | Recepção | idem | **Todas** as conversas |
| Jenifer | `agent` | Comercial¹ | Conversas + Leads/Kanban | **Só as dela** |
| Miria Felix | `agent` | Comercial¹ | idem | **Só as dela** |
| Nicolle | `agent` | Comercial¹ | idem | **Só as dela** |

> **² Confirmar grafia dos nomes.** Copiei da sua anotação (`Lorrayne`, `jheniger a`,
> `Anna julia`, `Jenifer`, `Miria felix`, `Nicolle`, `Jessica silva`, `Jessica eneia`).
> Antes de cadastrar, me passe nome completo + **e-mail** de cada uma (o e-mail é o login).

> **Detalhe operacional:** um `admin` de conta **não** cria outro `admin` (regra do sistema).
> Então as duas Jessicas precisam ser criadas via **super_admin**. O resto (recepção e
> comercial, que são `agent`) qualquer uma das Jessicas cria sozinha na tela de usuários.

## ¹ O ponto delicado do "Time Comercial" — leia com atenção

Você quer as 3 consultoras como "Time Comercial", **mas** com **carteira individual**
(cada uma vê só a sua). No sistema, **time = visão compartilhada** — se uma conversa for
atribuída ao *time*, as 3 veem. Pra ter carteira individual sem perder o agrupamento:

- O "Time Comercial" existe **só como lista/rodízio e relatório** — serve pro n8n saber
  *quem são as 3* e distribuir, e pra você medir o comercial junto.
- **A conversa é sempre atribuída a uma PESSOA, nunca ao time.** O n8n faz o rodízio:
  pega uma consultora disponível (`GET /users?role=agent&teamId=<comercial>&available=true`)
  e atribui **àquela pessoa**.
- Enquanto ninguém usar "atribuir ao time comercial", cada consultora vê **só a dela**. ✅

> Se algum dia alguém atribuir uma conversa **ao time** comercial, as 3 passam a ver aquela
> conversa. É o único jeito de "vazar" a carteira — então a regra é: **comercial sempre
> recebe por pessoa.** (Se preferir zero risco, dá pra nem criar o time comercial no CRM e
> deixar o rodízio 100% no n8n com os 3 IDs. Perde só o agrupamento em relatório.)

## Regras de negócio traduzidas

- **"Cliente inativo não é de ninguém"** → a conversa entra **sem responsável e sem time**
  (fila de não-atribuídas). Quem vê essa fila: **administração** e **recepção** (por causa do
  Acesso total). Comercial **não** vê. A recepção tria e, se virar oportunidade, designa a
  uma consultora.
- **Recepção faz a triagem** → ela vê tudo, responde dúvida geral (planos, Gympass/TotalPass)
  e **passa pro comercial** quando é intenção de compra.
- **Comercial só o designado** → carteira individual, como acima.

---

# Parte 3 — Disparos (100% no n8n)

O CRM só expõe a API genérica de campanha
(`POST /api/integrations/whatsapp/campaigns/send-batch`, aceita `contactIds` ou `phones`).
**Quem é Pacto, quem é planilha, isso é problema do n8n** — o CRM não sabe e não precisa saber.

| Disparo | Fonte do dado | Como o n8n faz |
|---------|---------------|-----------------|
| Faltoso | **Pacto** | n8n lê da Pacto (webhook/API) → chama a API de campanha do CRM |
| Aniversariante | **Pacto** | idem |
| Pós-venda | **Pacto** | idem |
| Gympass / TotalPass | **Planilha** | n8n lê a planilha → API de campanha |
| Inativo | **Planilha** | idem |
| Visitante | **Planilha** | idem |
| Promoção / ofertas | Avulso | Campanha manual no CRM, ou lista montada no n8n |

Cada disparo vira **um fluxo n8n** (ou um só, com um switch por origem). O contato precisa
existir no CRM antes do disparo — o n8n garante isso via
`POST /api/integrations/contacts` (com `upsert: true`) antes de mandar a campanha.

---

# Parte 4 — Menu de triagem (próximo artefato, ainda a desenhar)

O "menu de triagem" é **outro fluxo n8n**, separado do SDR (Marcus). Ele recebe o contato
novo e roteia:

- dúvida de **plano / Gympass / TotalPass** → resposta automática (ou cai pra recepção);
- **quer comprar / falar com consultor** → entra no rodízio do **comercial**;
- **assunto de recepção** (horário, matrícula, etc.) → **recepção**.

Isso tem decisões próprias (menu numerado fixo "1, 2, 3…" **ou** IA conversacional com
persona de recepção **ou** híbrido) que a gente fecha quando chegar nele. **Não está no
escopo deste documento** — aqui a gente só deixou a **estrutura de acessos** pronta pra ele
ter onde encaixar (a quem atribuir, quem vê o quê).

---

# Parte 5 — Ordem de implementação (quando você aprovar)

1. **Feature genérica** (Parte 1): permissão "Acesso total às conversas" — os 5 pontos de
   código. É o único desenvolvimento novo. Pequeno.
2. **Criar os usuários** (Parte 2): 2 admins (via super_admin) + 3 recepção + 3 comercial.
3. **Criar os times**: Recepção e Comercial (o Comercial como roster de rodízio).
4. **Marcar o toggle** "Acesso total às conversas" nas 3 da recepção.
5. **n8n**: fluxos de disparo (Parte 3) + menu de triagem (Parte 4) — cada um no seu tempo.

**Nada aqui apaga dado nem exige downtime.** A permissão nova é aditiva; usuários e times
são cadastro normal.

---

## Resumo de uma linha

Um recurso pequeno e reaproveitável — o toggle **"Acesso total às conversas"** — destrava a
recepção "que vê tudo sem ser admin", e com ele o FitPark inteiro se monta só com cadastro
(usuários + times), mantendo **toda a Pacto/planilha no n8n** e o CRM genérico.
