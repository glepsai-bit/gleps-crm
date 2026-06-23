/**
 * AdminSLAPoliciesPage — T-022 (Sprint 3 / chat interno)
 *
 * CRUD de políticas de SLA + visualização dos breaches da policy selecionada.
 *
 * Estrutura:
 *  - Header com botão "Nova política"
 *  - Card com a tabela de policies (nome, firstResponseMin, resolutionMin,
 *    businessHoursOnly, status, ações)
 *  - Dialog criar/editar (nome, minutos primeira resposta, minutos resolução,
 *    switch horário comercial, switch ativo)
 *  - Sheet de detalhe com Tabs:
 *      • "Visão geral"  → metadata da policy
 *      • "Breaches"     → últimos 50 breaches (conversation, tipo, esperado,
 *                         real, breachedAt)
 *  - AlertDialog de confirmação de exclusão
 *
 * Multi-tenant:
 *  - admin: backend escopa automaticamente pela própria conta.
 *  - super_admin: precisa de accountId — usamos `user.account_id` quando
 *    estiver impersonando (fluxo `impersonate`); fora disso a página exige
 *    impersonação (mensagem explícita), já que SLA é por conta.
 *
 * Observação:
 *  - A aplicação de uma policy a uma conversa específica é feita pelo botão
 *    "Aplicar SLA" dentro de `ConversationActions` (página de conversa). Aqui
 *    apenas gerenciamos as policies e auditamos os breaches.
 */

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import {
  AlarmClock,
  AlertTriangle,
  Loader2,
  MoreVertical,
  Pencil,
  Plus,
  Search,
  Shield,
  Trash2,
} from 'lucide-react';
import { toast } from 'sonner';

import { useAuth } from '@/contexts/AuthContext';
import {
  slaPoliciesBackendService,
  type CreateSLAPolicyInput,
  type SLABreach,
  type SLAPolicy,
  type UpdateSLAPolicyInput,
} from '@/services/sla-policies.backend.service';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@/components/ui/tabs';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { safeFormatDateBR } from '@/utils/dateUtils';

// ---------------------------------------------------------------------------
// Constantes / validação
// ---------------------------------------------------------------------------

/**
 * Limites validados também no backend (backend/src/services/sla.service.ts).
 * Espelhamos aqui para feedback imediato no form.
 */
const FIRST_RESPONSE_MIN = 5;
const FIRST_RESPONSE_MAX = 1440; // 24h
const RESOLUTION_MIN = 10;
const RESOLUTION_MAX = 43200; // 30 dias

const policyFormSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(2, 'Nome muito curto (mín. 2 caracteres)')
      .max(80, 'Nome muito longo (máx. 80 caracteres)'),
    firstResponseMin: z.coerce
      .number({ invalid_type_error: 'Informe um número' })
      .int('Use minutos inteiros')
      .min(FIRST_RESPONSE_MIN, `Mínimo ${FIRST_RESPONSE_MIN} minutos`)
      .max(FIRST_RESPONSE_MAX, `Máximo ${FIRST_RESPONSE_MAX} minutos (24h)`),
    resolutionMin: z.coerce
      .number({ invalid_type_error: 'Informe um número' })
      .int('Use minutos inteiros')
      .min(RESOLUTION_MIN, `Mínimo ${RESOLUTION_MIN} minutos`)
      .max(RESOLUTION_MAX, `Máximo ${RESOLUTION_MAX} minutos (30 dias)`),
    businessHoursOnly: z.boolean(),
    active: z.boolean(),
  })
  .refine((v) => v.resolutionMin >= v.firstResponseMin, {
    message: 'Resolução deve ser >= primeira resposta',
    path: ['resolutionMin'],
  });

type PolicyFormValues = z.infer<typeof policyFormSchema>;

const DEFAULT_FORM: PolicyFormValues = {
  name: '',
  firstResponseMin: 15,
  resolutionMin: 240,
  businessHoursOnly: true,
  active: true,
};

// ---------------------------------------------------------------------------
// Helpers de formatação
// ---------------------------------------------------------------------------

/**
 * Formata minutos em "Xh Ymin" / "Xmin" / "Xd Yh" para legibilidade.
 */
function formatMinutes(total: number): string {
  if (!Number.isFinite(total) || total <= 0) return '—';
  const days = Math.floor(total / (60 * 24));
  const hours = Math.floor((total % (60 * 24)) / 60);
  const mins = total % 60;
  const parts: string[] = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (mins || (!days && !hours)) parts.push(`${mins}min`);
  return parts.join(' ');
}

function breachTypeBadge(type: SLABreach['type']) {
  if (type === 'first_response') {
    return (
      <Badge variant="outline" className="text-xs border-amber-500/40 text-amber-600 dark:text-amber-400">
        Primeira resposta
      </Badge>
    );
  }
  if (type === 'resolution') {
    return (
      <Badge variant="outline" className="text-xs border-rose-500/40 text-rose-600 dark:text-rose-400">
        Resolução
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="text-xs">
      {type}
    </Badge>
  );
}

// ---------------------------------------------------------------------------
// Componente
// ---------------------------------------------------------------------------

export default function AdminSLAPoliciesPage() {
  const queryClient = useQueryClient();
  const { user } = useAuth();

  /**
   * super_admin sem impersonar não consegue escopo — sla é por conta.
   * Em impersonação, `user.account_id` está populado e mandamos no params.
   */
  const accountIdParam = useMemo<string | undefined>(() => {
    if (user?.role === 'super_admin') {
      return user.account_id || undefined;
    }
    return undefined; // admin: backend escopa sozinho
  }, [user?.role, user?.account_id]);

  const isSuperAdminSemConta =
    user?.role === 'super_admin' && !accountIdParam;

  // ----- estado UI -----
  const [search, setSearch] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<SLAPolicy | null>(null);
  const [deleting, setDeleting] = useState<SLAPolicy | null>(null);
  const [detailPolicy, setDetailPolicy] = useState<SLAPolicy | null>(null);

  // ----- query: lista -----
  const {
    data: policies = [],
    isLoading,
    isError,
  } = useQuery<SLAPolicy[]>({
    queryKey: ['sla-policies', accountIdParam ?? 'self'],
    queryFn: () =>
      slaPoliciesBackendService.listSLAPolicies(
        accountIdParam ? { accountId: accountIdParam } : undefined
      ),
    enabled: !isSuperAdminSemConta,
  });

  const filteredPolicies = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return policies;
    return policies.filter((p) => p.name.toLowerCase().includes(q));
  }, [policies, search]);

  // ----- query: breaches da policy em detalhe -----
  const { data: breaches = [], isLoading: isBreachesLoading } = useQuery<
    SLABreach[]
  >({
    queryKey: ['sla-breaches', detailPolicy?.id, accountIdParam ?? 'self'],
    queryFn: () =>
      slaPoliciesBackendService.listBreaches(
        detailPolicy!.id,
        accountIdParam ? { accountId: accountIdParam } : undefined
      ),
    enabled: !!detailPolicy?.id,
  });

  // ----- mutations -----
  const createMutation = useMutation({
    mutationFn: (input: CreateSLAPolicyInput) =>
      slaPoliciesBackendService.create(
        input,
        accountIdParam ? { accountId: accountIdParam } : undefined
      ),
    onSuccess: (created) => {
      toast.success(`Política "${created.name}" criada`);
      queryClient.invalidateQueries({ queryKey: ['sla-policies'] });
      setCreateOpen(false);
    },
    onError: (err: unknown) => {
      toast.error(
        'Erro ao criar política: ' +
          ((err as { message?: string })?.message ?? 'desconhecido')
      );
    },
  });

  const updateMutation = useMutation({
    mutationFn: (vars: { id: string; input: UpdateSLAPolicyInput }) =>
      slaPoliciesBackendService.update(
        vars.id,
        vars.input,
        accountIdParam ? { accountId: accountIdParam } : undefined
      ),
    onSuccess: (updated) => {
      toast.success(`Política "${updated.name}" atualizada`);
      queryClient.invalidateQueries({ queryKey: ['sla-policies'] });
      // Se o detalhe está aberto, refresca o objeto.
      setDetailPolicy((prev) => (prev?.id === updated.id ? updated : prev));
      setEditing(null);
    },
    onError: (err: unknown) => {
      toast.error(
        'Erro ao atualizar política: ' +
          ((err as { message?: string })?.message ?? 'desconhecido')
      );
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) =>
      slaPoliciesBackendService.delete(
        id,
        accountIdParam ? { accountId: accountIdParam } : undefined
      ),
    onSuccess: () => {
      toast.success('Política excluída');
      queryClient.invalidateQueries({ queryKey: ['sla-policies'] });
      setDeleting(null);
    },
    onError: (err: unknown) => {
      toast.error(
        'Erro ao excluir política: ' +
          ((err as { message?: string })?.message ?? 'desconhecido')
      );
    },
  });

  // Toggle rápido do "ativo" direto na tabela (sem abrir dialog).
  const toggleActiveMutation = useMutation({
    mutationFn: (policy: SLAPolicy) =>
      slaPoliciesBackendService.update(
        policy.id,
        { active: !policy.active },
        accountIdParam ? { accountId: accountIdParam } : undefined
      ),
    onSuccess: (updated) => {
      toast.success(
        `Política "${updated.name}" ${updated.active ? 'ativada' : 'desativada'}`
      );
      queryClient.invalidateQueries({ queryKey: ['sla-policies'] });
    },
    onError: (err: unknown) => {
      toast.error(
        'Erro ao alternar status: ' +
          ((err as { message?: string })?.message ?? 'desconhecido')
      );
    },
  });

  // ----- render -----

  if (isSuperAdminSemConta) {
    return (
      <div className="page-container space-y-6">
        <div className="page-header">
          <div>
            <h1 className="text-xl sm:text-2xl md:text-3xl font-bold text-foreground flex items-center gap-2">
              <Shield className="w-6 h-6" />
              Políticas de SLA
            </h1>
            <p className="text-xs sm:text-sm text-muted-foreground mt-1">
              Defina prazos de primeira resposta e resolução por conta.
            </p>
          </div>
        </div>

        <Card>
          <CardContent className="pt-10 pb-10 text-center text-muted-foreground">
            <Shield className="w-12 h-12 mx-auto mb-3 opacity-20" />
            <p className="font-medium text-base">
              SLA é gerenciado por conta.
            </p>
            <p className="text-sm mt-1">
              Entre em uma conta (impersonação) para visualizar e editar as
              políticas.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="page-container space-y-6">
      {/* Header */}
      <div className="page-header">
        <div>
          <h1 className="text-xl sm:text-2xl md:text-3xl font-bold text-foreground flex items-center gap-2">
            <Shield className="w-6 h-6" />
            Políticas de SLA
          </h1>
          <p className="text-xs sm:text-sm text-muted-foreground mt-1">
            Defina prazos de primeira resposta e resolução. Aplicação por
            conversa via botão "Aplicar SLA" no chat.
          </p>
        </div>
        <Button className="gap-2" onClick={() => setCreateOpen(true)}>
          <Plus className="w-4 h-4" />
          Nova política
        </Button>
      </div>

      {/* Busca */}
      <Card>
        <CardContent className="pt-4">
          <div className="relative max-w-md">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              placeholder="Buscar política pelo nome..."
              className="pl-9"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        </CardContent>
      </Card>

      {/* Lista */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center justify-between">
            <span className="flex items-center gap-2">
              <AlarmClock className="w-4 h-4" />
              Políticas cadastradas
            </span>
            {!isLoading && !isError && (
              <span className="text-sm font-normal text-muted-foreground">
                {filteredPolicies.length} política(s)
              </span>
            )}
          </CardTitle>
          <CardDescription className="text-xs">
            Clique em uma linha para abrir o detalhe e ver os últimos breaches.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-3">
              {[1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : isError ? (
            <div className="text-center py-12 text-muted-foreground">
              <AlertTriangle className="w-12 h-12 mx-auto mb-3 opacity-30 text-amber-500" />
              <p className="font-medium">Não foi possível carregar as políticas.</p>
              <p className="text-xs mt-1">Tente novamente em alguns instantes.</p>
            </div>
          ) : filteredPolicies.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">
              <Shield className="w-12 h-12 mx-auto mb-3 opacity-20" />
              <p className="font-medium text-base">
                {search
                  ? 'Nenhuma política bate com a busca.'
                  : 'Nenhuma política cadastrada ainda.'}
              </p>
              <p className="text-xs mt-1 text-muted-foreground/70">
                {search
                  ? 'Tente ajustar o termo de busca.'
                  : 'Crie sua primeira política em "Nova política".'}
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table className="min-w-[720px]">
                <TableHeader>
                  <TableRow>
                    <TableHead className="min-w-[180px]">Nome</TableHead>
                    <TableHead className="min-w-[140px]">Primeira resposta</TableHead>
                    <TableHead className="min-w-[120px]">Resolução</TableHead>
                    <TableHead className="min-w-[140px]">Horário</TableHead>
                    <TableHead className="text-center min-w-[100px]">Ativa</TableHead>
                    <TableHead className="w-[50px]" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredPolicies.map((policy) => (
                    <TableRow
                      key={policy.id}
                      className="cursor-pointer"
                      onClick={() => setDetailPolicy(policy)}
                    >
                      <TableCell className="font-medium">{policy.name}</TableCell>
                      <TableCell className="text-sm">
                        {formatMinutes(policy.firstResponseMin)}
                      </TableCell>
                      <TableCell className="text-sm">
                        {formatMinutes(policy.resolutionMin)}
                      </TableCell>
                      <TableCell>
                        {policy.businessHoursOnly ? (
                          <Badge variant="outline" className="text-xs">
                            Comercial
                          </Badge>
                        ) : (
                          <Badge variant="secondary" className="text-xs">
                            24/7
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell
                        className="text-center"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <Switch
                          checked={policy.active}
                          disabled={
                            toggleActiveMutation.isPending &&
                            toggleActiveMutation.variables?.id === policy.id
                          }
                          onCheckedChange={() =>
                            toggleActiveMutation.mutate(policy)
                          }
                          aria-label={
                            policy.active
                              ? `Desativar política ${policy.name}`
                              : `Ativar política ${policy.name}`
                          }
                        />
                      </TableCell>
                      <TableCell onClick={(e) => e.stopPropagation()}>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon" className="h-8 w-8">
                              <MoreVertical className="h-4 w-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onClick={() => setEditing(policy)}>
                              <Pencil className="h-4 w-4 mr-2" />
                              Editar
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onClick={() => setDetailPolicy(policy)}
                            >
                              <AlertTriangle className="h-4 w-4 mr-2" />
                              Ver breaches
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              onClick={() => setDeleting(policy)}
                              className="text-destructive focus:text-destructive"
                            >
                              <Trash2 className="h-4 w-4 mr-2" />
                              Excluir
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Dialog criar */}
      <PolicyFormDialog
        open={createOpen}
        onOpenChange={(open) => {
          if (!createMutation.isPending) setCreateOpen(open);
        }}
        title="Nova política de SLA"
        description="Defina prazos de primeira resposta e de resolução. Os tempos são aplicados a partir da abertura da conversa."
        submitLabel="Criar política"
        isSubmitting={createMutation.isPending}
        initialValues={DEFAULT_FORM}
        onSubmit={(values) =>
          createMutation.mutate({
            name: values.name,
            firstResponseMin: values.firstResponseMin,
            resolutionMin: values.resolutionMin,
            businessHoursOnly: values.businessHoursOnly,
          })
        }
      />

      {/* Dialog editar */}
      <PolicyFormDialog
        open={!!editing}
        onOpenChange={(open) => {
          if (!updateMutation.isPending && !open) setEditing(null);
        }}
        title={editing ? `Editar "${editing.name}"` : 'Editar política'}
        description="Alterações afetam apenas conversas abertas a partir de agora."
        submitLabel="Salvar alterações"
        isSubmitting={updateMutation.isPending}
        initialValues={
          editing
            ? {
                name: editing.name,
                firstResponseMin: editing.firstResponseMin,
                resolutionMin: editing.resolutionMin,
                businessHoursOnly: editing.businessHoursOnly,
                active: editing.active,
              }
            : DEFAULT_FORM
        }
        onSubmit={(values) => {
          if (!editing) return;
          updateMutation.mutate({
            id: editing.id,
            input: {
              name: values.name,
              firstResponseMin: values.firstResponseMin,
              resolutionMin: values.resolutionMin,
              businessHoursOnly: values.businessHoursOnly,
              active: values.active,
            },
          });
        }}
      />

      {/* Sheet detalhe + breaches */}
      <Sheet
        open={!!detailPolicy}
        onOpenChange={(open) => {
          if (!open) setDetailPolicy(null);
        }}
      >
        <SheetContent className="w-full sm:max-w-2xl overflow-y-auto">
          {detailPolicy && (
            <>
              <SheetHeader>
                <SheetTitle className="flex items-center gap-2">
                  <Shield className="w-5 h-5" />
                  {detailPolicy.name}
                </SheetTitle>
                <SheetDescription>
                  Primeira resposta: <strong>{formatMinutes(detailPolicy.firstResponseMin)}</strong> ·
                  Resolução: <strong>{formatMinutes(detailPolicy.resolutionMin)}</strong>
                </SheetDescription>
              </SheetHeader>

              <Tabs defaultValue="overview" className="mt-6">
                <TabsList className="grid w-full grid-cols-2">
                  <TabsTrigger value="overview">Visão geral</TabsTrigger>
                  <TabsTrigger value="breaches">
                    Breaches
                    {breaches.length > 0 && (
                      <Badge variant="secondary" className="ml-2 text-xs">
                        {breaches.length}
                      </Badge>
                    )}
                  </TabsTrigger>
                </TabsList>

                <TabsContent value="overview" className="space-y-4 mt-4">
                  <div className="grid grid-cols-2 gap-3 text-sm">
                    <div className="rounded-md border border-border p-3">
                      <div className="text-xs text-muted-foreground">
                        Primeira resposta
                      </div>
                      <div className="font-medium mt-1">
                        {formatMinutes(detailPolicy.firstResponseMin)}
                      </div>
                    </div>
                    <div className="rounded-md border border-border p-3">
                      <div className="text-xs text-muted-foreground">
                        Resolução
                      </div>
                      <div className="font-medium mt-1">
                        {formatMinutes(detailPolicy.resolutionMin)}
                      </div>
                    </div>
                    <div className="rounded-md border border-border p-3">
                      <div className="text-xs text-muted-foreground">
                        Horário comercial
                      </div>
                      <div className="font-medium mt-1">
                        {detailPolicy.businessHoursOnly ? 'Sim' : 'Não (24/7)'}
                      </div>
                    </div>
                    <div className="rounded-md border border-border p-3">
                      <div className="text-xs text-muted-foreground">Status</div>
                      <div className="font-medium mt-1">
                        {detailPolicy.active ? (
                          <Badge className="bg-success/20 text-success-foreground border-success/30">
                            Ativa
                          </Badge>
                        ) : (
                          <Badge variant="secondary">Inativa</Badge>
                        )}
                      </div>
                    </div>
                    <div className="rounded-md border border-border p-3 col-span-2">
                      <div className="text-xs text-muted-foreground">
                        Criada em
                      </div>
                      <div className="font-medium mt-1">
                        {safeFormatDateBR(detailPolicy.createdAt, 'dd/MM/yyyy HH:mm')}
                      </div>
                    </div>
                  </div>
                  <Button
                    variant="outline"
                    className="w-full gap-2"
                    onClick={() => setEditing(detailPolicy)}
                  >
                    <Pencil className="w-4 h-4" />
                    Editar política
                  </Button>
                </TabsContent>

                <TabsContent value="breaches" className="mt-4">
                  {isBreachesLoading ? (
                    <div className="space-y-3">
                      {[1, 2, 3].map((i) => (
                        <Skeleton key={i} className="h-10 w-full" />
                      ))}
                    </div>
                  ) : breaches.length === 0 ? (
                    <div className="text-center py-10 text-muted-foreground">
                      <AlarmClock className="w-10 h-10 mx-auto mb-3 opacity-20" />
                      <p className="font-medium">Sem breaches por aqui.</p>
                      <p className="text-xs mt-1">
                        Os últimos 50 breaches desta política aparecerão nesta lista.
                      </p>
                    </div>
                  ) : (
                    <div className="overflow-x-auto">
                      <Table className="min-w-[560px]">
                        <TableHeader>
                          <TableRow>
                            <TableHead className="min-w-[160px]">Conversa</TableHead>
                            <TableHead className="min-w-[140px]">Tipo</TableHead>
                            <TableHead className="min-w-[110px]">Esperado</TableHead>
                            <TableHead className="min-w-[110px]">Real</TableHead>
                            <TableHead className="min-w-[140px]">Quebrado em</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {breaches.map((b) => (
                            <TableRow key={b.id}>
                              <TableCell className="text-sm">
                                <a
                                  href={`/admin/chat?conversationId=${b.conversationId}`}
                                  className="text-primary hover:underline font-mono text-xs"
                                  title={b.conversationId}
                                >
                                  {b.conversationId.slice(0, 8)}…
                                </a>
                              </TableCell>
                              <TableCell>{breachTypeBadge(b.type)}</TableCell>
                              <TableCell className="text-sm text-muted-foreground">
                                {formatMinutes(b.expectedMin)}
                              </TableCell>
                              <TableCell className="text-sm">
                                {b.actualMin === null
                                  ? '—'
                                  : formatMinutes(b.actualMin)}
                              </TableCell>
                              <TableCell className="text-xs text-muted-foreground">
                                {safeFormatDateBR(b.breachedAt, 'dd/MM/yyyy HH:mm')}
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  )}
                </TabsContent>
              </Tabs>
            </>
          )}
        </SheetContent>
      </Sheet>

      {/* AlertDialog excluir */}
      <AlertDialog
        open={!!deleting}
        onOpenChange={(open) => {
          if (!deleteMutation.isPending && !open) setDeleting(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Excluir política?</AlertDialogTitle>
            <AlertDialogDescription>
              A política <strong>{deleting?.name}</strong> será removida. Conversas
              que estão usando esta política deixarão de ter SLA aplicado, mas
              não serão arquivadas/canceladas.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteMutation.isPending}>
              Cancelar
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleting && deleteMutation.mutate(deleting.id)}
              disabled={deleteMutation.isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleteMutation.isPending && (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              )}
              Excluir
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-componente: dialog form (criar/editar) — react-hook-form + zod
// ---------------------------------------------------------------------------

interface PolicyFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  submitLabel: string;
  isSubmitting: boolean;
  initialValues: PolicyFormValues;
  onSubmit: (values: PolicyFormValues) => void;
}

function PolicyFormDialog({
  open,
  onOpenChange,
  title,
  description,
  submitLabel,
  isSubmitting,
  initialValues,
  onSubmit,
}: PolicyFormDialogProps) {
  const {
    register,
    handleSubmit,
    reset,
    setValue,
    watch,
    formState: { errors },
  } = useForm<PolicyFormValues>({
    resolver: zodResolver(policyFormSchema),
    defaultValues: initialValues,
    values: initialValues, // resync quando initialValues muda (editar)
  });

  const businessHoursOnly = watch('businessHoursOnly');
  const active = watch('active');

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) reset(initialValues);
        onOpenChange(o);
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        <form
          onSubmit={handleSubmit(onSubmit)}
          className="space-y-4"
          noValidate
        >
          <div className="space-y-2">
            <Label htmlFor="sla-name">Nome</Label>
            <Input
              id="sla-name"
              placeholder="Ex.: Padrão atendimento"
              autoFocus
              {...register('name')}
              disabled={isSubmitting}
            />
            {errors.name && (
              <p className="text-xs text-destructive">{errors.name.message}</p>
            )}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="sla-first">
                Primeira resposta (min)
              </Label>
              <Input
                id="sla-first"
                type="number"
                min={FIRST_RESPONSE_MIN}
                max={FIRST_RESPONSE_MAX}
                step={1}
                inputMode="numeric"
                {...register('firstResponseMin', { valueAsNumber: true })}
                disabled={isSubmitting}
              />
              <p className="text-[11px] text-muted-foreground">
                Entre {FIRST_RESPONSE_MIN} e {FIRST_RESPONSE_MAX} min (até 24h).
              </p>
              {errors.firstResponseMin && (
                <p className="text-xs text-destructive">
                  {errors.firstResponseMin.message}
                </p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="sla-resolution">
                Resolução (min)
              </Label>
              <Input
                id="sla-resolution"
                type="number"
                min={RESOLUTION_MIN}
                max={RESOLUTION_MAX}
                step={1}
                inputMode="numeric"
                {...register('resolutionMin', { valueAsNumber: true })}
                disabled={isSubmitting}
              />
              <p className="text-[11px] text-muted-foreground">
                Entre {RESOLUTION_MIN} e {RESOLUTION_MAX} min (até 30 dias).
              </p>
              {errors.resolutionMin && (
                <p className="text-xs text-destructive">
                  {errors.resolutionMin.message}
                </p>
              )}
            </div>
          </div>

          <div className="flex items-center justify-between rounded-md border border-border p-3">
            <div>
              <Label htmlFor="sla-business" className="cursor-pointer">
                Apenas horário comercial
              </Label>
              <p className="text-xs text-muted-foreground mt-0.5">
                Conta tempo só dentro do expediente configurado na conta.
              </p>
            </div>
            <Switch
              id="sla-business"
              checked={businessHoursOnly}
              onCheckedChange={(v) => setValue('businessHoursOnly', v)}
              disabled={isSubmitting}
            />
          </div>

          <div className="flex items-center justify-between rounded-md border border-border p-3">
            <div>
              <Label htmlFor="sla-active" className="cursor-pointer">
                Política ativa
              </Label>
              <p className="text-xs text-muted-foreground mt-0.5">
                Quando inativa, deixa de gerar novos breaches.
              </p>
            </div>
            <Switch
              id="sla-active"
              checked={active}
              onCheckedChange={(v) => setValue('active', v)}
              disabled={isSubmitting}
            />
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={isSubmitting}
            >
              Cancelar
            </Button>
            <Button type="submit" disabled={isSubmitting} className="gap-2">
              {isSubmitting && <Loader2 className="w-4 h-4 animate-spin" />}
              {submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
