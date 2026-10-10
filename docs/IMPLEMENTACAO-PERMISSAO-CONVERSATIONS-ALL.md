# Guia de implementação — permissão "Acesso total às conversas" (`conversations_all`)

> Documento de **como codar**. É a Parte 1 (feature genérica) de
> [FITPARK-ESTRUTURA-E-ACESSOS.md](FITPARK-ESTRUTURA-E-ACESSOS.md).
>
> **O que é:** uma permissão nova que faz um `agent` ver **todas** as conversas da conta,
> sem virar admin. Aditiva, **sem migration, sem tocar no banco** — é só mais uma string no
> array `permissions` que o usuário já tem.
>
> **Tempo:** ~30-40 min. São 6 arquivos, mudanças pequenas.

---

## Como funciona (o modelo mental)

A visibilidade de conversa é decidida **no backend**, em UM lugar
([conversation.service.ts](../backend/src/services/conversation.service.ts)): se o `actor`
é `agent`, o Prisma filtra pra mostrar só as dele (assignee/participante/time). `admin` e
`super_admin` pulam esse filtro.

A permissão nova só adiciona **uma condição**: se o agente tem `conversations_all`, ele
**também** pula o filtro. Nada mais muda. O frontend só ganha um **toggle** pra ligar isso.

> ⚠️ O ponto de verdade é o **backend**. A permissão no frontend controla menu; a
> visibilidade real das conversas é o filtro do serviço. Se você mexer só no frontend, o
> menu aparece mas a lista continua vazia.

---

## Mapa dos arquivos (6 mudanças)

| # | Arquivo | Mudança |
|---|---------|---------|
| 1 | `backend/src/types/index.ts` | Registrar `'conversations_all'` no tipo + lista de permissões |
| 2 | `backend/src/services/conversation.service.ts` | Actor ganha `permissions`; 3 guards honram a permissão |
| 3 | `backend/src/controllers/conversation.controller.ts` | `getActor` passa `permissions` |
| 4 | `backend/src/controllers/message.controller.ts` | `getActor` passa `permissions` (mesmo motivo) |
| 5 | `src/config/permissions.config.ts` | Registrar a permissão no frontend + grupo Atendimento |
| 6 | `src/components/admin/AgenteFormDialog.tsx` | O toggle amigável na tela de criar/editar agente |

---

## Passo 1 — Backend: registrar a permissão

**Arquivo:** `backend/src/types/index.ts`

**1a.** No tipo `Permission` (union), adicione a linha (por volta da [linha 91](../backend/src/types/index.ts#L91)):

```ts
  | 'emails'
  | 'extracao'
  | 'conversations_all';   // ← NOVA
```

**1b.** No array `ALL_PERMISSIONS` ([linha 93+](../backend/src/types/index.ts#L93)), adicione a string:

```ts
export const ALL_PERMISSIONS: Permission[] = [
  'dashboard',
  // ... (mantém todas as existentes)
  'extracao',
  'conversations_all',   // ← NOVA
];
```

---

## Passo 2 — Backend: o actor e os 3 guards

**Arquivo:** `backend/src/services/conversation.service.ts`

**2a.** No tipo `ConversationActor` ([linha 172](../backend/src/services/conversation.service.ts#L172)), adicione o campo:

```ts
export interface ConversationActor {
  userId: string;
  role: ConversationActorRole;
  permissions?: string[];   // ← NOVA (permissões do usuário, pra checar conversations_all)
}
```

**2b.** No filtro da listagem `list()` ([linha 256](../backend/src/services/conversation.service.ts#L256)):

```ts
// ANTES
if (actor && actor.role === 'agent') {

// DEPOIS
if (actor && actor.role === 'agent' && !actor.permissions?.includes('conversations_all')) {
```

**2c.** Na leitura individual `get()` ([linha 358](../backend/src/services/conversation.service.ts#L358)):

```ts
// ANTES
if (actor && actor.role === 'agent') {
  await this.assertAgentCanAccess(conversation as Conversation, actor.userId);
}

// DEPOIS
if (actor && actor.role === 'agent' && !actor.permissions?.includes('conversations_all')) {
  await this.assertAgentCanAccess(conversation as Conversation, actor.userId);
}
```

**2d.** No guard de mutations `ensureConversationAccess()` ([linha 425](../backend/src/services/conversation.service.ts#L425)):

```ts
// ANTES
if (actor.role !== 'agent') return conversation as Conversation;

// DEPOIS
if (actor.role !== 'agent' || actor.permissions?.includes('conversations_all')) {
  return conversation as Conversation;
}
```

> Esses 3 pontos são o mesmo conceito repetido: **agente com `conversations_all` não sofre
> a restrição.** O guard `ensureConversationAccess` cobre também o envio de mensagens (o
> `message.controller` chama ele — por isso a recepção vai conseguir responder, não só ver).

---

## Passo 3 — Backend: os dois `getActor` passam as permissões

O `actor` é montado a partir do `req.user`. O `req.user` **já carrega** `permissions`
(preenchido em [auth.middleware.ts:69](../backend/src/middlewares/auth.middleware.ts#L69)) —
só não estava sendo repassado pro actor. São **dois** arquivos com a mesma função:

**3a.** `backend/src/controllers/conversation.controller.ts` ([linha 185](../backend/src/controllers/conversation.controller.ts#L185)):

```ts
function getActor(req: AuthenticatedRequest): ConversationActor {
  return {
    userId: req.user!.id,
    role: req.user!.role as ConversationActor['role'],
    permissions: req.user!.permissions,   // ← NOVA
  };
}
```

**3b.** `backend/src/controllers/message.controller.ts` ([linha 280](../backend/src/controllers/message.controller.ts#L280)) — **idêntico**:

```ts
function getActor(req: AuthenticatedRequest): ConversationActor {
  return {
    userId: req.user!.id,
    role: req.user!.role as ConversationActor['role'],
    permissions: req.user!.permissions,   // ← NOVA
  };
}
```

> Se aparecer erro de TS dizendo que `permissions` não existe em `req.user`, adicione
> `permissions: string[]` na interface do usuário autenticado (onde `AuthenticatedRequest`
> é declarado). Mas provavelmente já existe — o `requirePermission` lê `req.user!.permissions`
> sem cast ([auth.middleware.ts:160](../backend/src/middlewares/auth.middleware.ts#L160)).

**Fim do backend.** Rode `cd backend && npx tsc --noEmit` pra confirmar que compila.

---

## Passo 4 — Frontend: registrar a permissão

**Arquivo:** `src/config/permissions.config.ts`

**4a.** No objeto `PERMISSIONS` ([linha 13-16](../src/config/permissions.config.ts#L13-L16)):

```ts
  // CRM Features
  KANBAN: 'kanban',
  LEADS: 'leads',
  CONVERSATIONS: 'conversations',
  CONVERSATIONS_ALL: 'conversations_all',   // ← NOVA
```

**4b.** No grupo `ATENDIMENTO` ([linha 53-56](../src/config/permissions.config.ts#L53-L56)):

```ts
  ATENDIMENTO: {
    label: 'Atendimento',
    permissions: [PERMISSIONS.KANBAN, PERMISSIONS.LEADS, PERMISSIONS.CONVERSATIONS, PERMISSIONS.CONVERSATIONS_ALL],
  },
```

---

## Passo 5 — Frontend: o toggle na tela de agente

**Arquivo:** `src/components/admin/AgenteFormDialog.tsx`

Esta tela tem a **própria** lista de permissões (não usa a `permissions.config`). Vamos
adicionar uma seção "Supervisão" com o toggle.

**5a.** Depois do array `ACTION_PERMISSIONS` ([linha 117-119](../src/components/admin/AgenteFormDialog.tsx#L117-L119)), adicione:

```ts
const SUPERVISION_PERMISSIONS = [
  { id: 'conversations_all', label: 'Acesso total às conversas', icon: Eye },
];
```

> `Eye` já está importado no arquivo ([linha 42](../src/components/admin/AgenteFormDialog.tsx#L42)).

**5b.** No JSX, logo **depois** do bloco `Ações Especiais` (fecha na
[linha 510](../src/components/admin/AgenteFormDialog.tsx#L510), antes do `{permissionsError && ...}`),
adicione a seção nova:

```tsx
            <div className="space-y-2 pt-2 border-t">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                Supervisão
              </p>
              <div className="grid grid-cols-1 gap-2">
                {SUPERVISION_PERMISSIONS.map((sup) => {
                  const checked = (currentPermissions ?? []).includes(sup.id);
                  return (
                    <label
                      key={sup.id}
                      htmlFor={`perm-${sup.id}`}
                      className={cn(
                        'flex items-start gap-2 p-2 rounded-md border cursor-pointer transition-colors',
                        checked ? 'bg-primary/10 border-primary' : 'bg-background hover:bg-muted'
                      )}
                    >
                      <Checkbox
                        id={`perm-${sup.id}`}
                        checked={checked}
                        onCheckedChange={() => togglePermission(sup.id)}
                        className="mt-0.5"
                      />
                      <sup.icon className="w-4 h-4 text-muted-foreground mt-0.5" />
                      <span className="text-sm leading-tight flex-1">
                        <span className="font-medium block">{sup.label}</span>
                        <span className="text-xs text-muted-foreground">
                          Vê e atende qualquer conversa da conta, mesmo as de outros
                          atendentes. Ideal pra recepção / supervisão. Não dá poder de
                          administrador.
                        </span>
                      </span>
                    </label>
                  );
                })}
              </div>
            </div>
```

Pronto — o toggle aparece na criação e na edição (os dois usam `currentPermissions` +
`togglePermission`, que já existem). O backend já aceita a string nova (o schema é
`z.array(z.string())`), então **não precisa mexer no schema de criação de usuário.**

---

## Como testar

### Backend (o que importa de verdade)

Com dois agentes na mesma conta e uma conversa atribuída **só ao agente A**:

1. **Agente B sem a permissão** → `GET /conversations` **não** traz a conversa do A;
   `GET /conversations/:id` dela retorna 403; mandar mensagem nela retorna 403.
2. **Agente B com `conversations_all`** → a mesma conversa **aparece** na lista, **abre**, e
   ele **consegue responder**.
3. **Agente A** (dono) → continua vendo a dele, com ou sem a permissão.
4. **Admin** → segue vendo tudo (nada mudou pra ele).

> Teste rápido no banco de dev: adicione `'conversations_all'` no array `permissions` de um
> agente e repita 1→2. Nada de migration.

Se houver testes de RBAC de conversa (procure por `assertAgentCanAccess` /
`ensureConversationAccess` nos `.test.ts`), rode-os e, de preferência, adicione um caso
"agent com conversations_all vê conversa alheia".

### Frontend

- Abrir **Agentes → Novo/Editar**: a seção **Supervisão** aparece com o toggle.
- Criar uma recepcionista com o toggle ligado, logar como ela: a fila mostra **todas** as
  conversas (inclusive as não-atribuídas e as de outros).
- Criar uma comercial **sem** o toggle: ela vê **só** as atribuídas a ela.

---

## Checklist

- [ ] `types/index.ts`: string nova no tipo `Permission` **e** no array `ALL_PERMISSIONS`
- [ ] `conversation.service.ts`: `permissions?` no `ConversationActor` + 3 guards (list/get/ensure)
- [ ] `conversation.controller.ts`: `getActor` passa `permissions`
- [ ] `message.controller.ts`: `getActor` passa `permissions`
- [ ] `permissions.config.ts`: `CONVERSATIONS_ALL` + grupo Atendimento
- [ ] `AgenteFormDialog.tsx`: `SUPERVISION_PERMISSIONS` + seção no JSX
- [ ] `cd backend && npx tsc --noEmit` limpo
- [ ] `npx tsc --noEmit` (frontend) limpo
- [ ] Teste manual backend 1→4 acima
- [ ] Nada de migration / nada tocou no banco

---

## O que **não** fazer

- ❌ Não crie coluna nem migration — `permissions` já é `String[]` no `User`.
- ❌ Não confie só no frontend — sem os guards do serviço, a lista fica vazia.
- ❌ Não dê `conversations_all` pro comercial — ele é carteira individual (o toggle fica
  **desligado** pra ele).
- ❌ Não troque o papel da recepção pra `admin` — o objetivo é exatamente evitar isso.
