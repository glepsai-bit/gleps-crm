/**
 * AdminAgentesPage (T-024)
 *
 * Página dedicada ao admin de CONTA gerenciar os agentes da própria tenancy.
 * Inspirada em SuperAdminUsersPage, mas escopada:
 *  - Não mostra (nem permite criar) super_admin.
 *  - Não tem seletor de account (sempre a conta do requester).
 *  - Mostra badge com X/Y agentes consumidos do plano (cor escala por uso).
 *
 * Backend: /api/admin/users — adminUsersBackendService.
 */

import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
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
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Plus,
  Search,
  Loader2,
  MoreHorizontal,
  Edit,
  PowerOff,
  Power,
  UserCog,
  AlertTriangle,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { safeFormatDateBR } from '@/utils/dateUtils';
import {
  adminUsersBackendService,
  type AdminUser,
  type AdminUserRole,
} from '@/services/admin-users.backend.service';
import { AgenteFormDialog } from '@/components/admin/AgenteFormDialog';
import { useAuth } from '@/contexts/AuthContext';

// ============================================
// Constants / helpers
// ============================================

const LIMITS_QUERY_KEY = ['admin-users', 'limits'];
const LIST_QUERY_KEY = ['admin-users', 'list'];

function getInitials(name: string) {
  return name
    .split(' ')
    .map((n) => n[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();
}

function getStatusBadge(status: AdminUser['status']) {
  if (status === 'active') {
    return <span className="status-active">Ativo</span>;
  }
  if (status === 'suspended') {
    return <span className="status-paused">Suspenso</span>;
  }
  return <span className="status-cancelled">Inativo</span>;
}

function getRoleBadge(role: AdminUserRole) {
  if (role === 'admin') return <span className="badge-admin">Admin</span>;
  return <span className="badge-agent">Agente</span>;
}

// ============================================
// Componente
// ============================================

export default function AdminAgentesPage() {
  const { user: currentUser } = useAuth();
  const queryClient = useQueryClient();

  // Filtros
  const [searchTerm, setSearchTerm] = useState('');
  const [roleFilter, setRoleFilter] = useState<AdminUserRole | 'all'>('all');
  const [statusFilter, setStatusFilter] = useState<AdminUser['status'] | 'all'>(
    'all'
  );

  // Dialogs
  const [formOpen, setFormOpen] = useState(false);
  const [editingAgente, setEditingAgente] = useState<AdminUser | null>(null);

  // Confirmar desativação
  const [toggleTarget, setToggleTarget] = useState<AdminUser | null>(null);
  const [toggleLoading, setToggleLoading] = useState(false);

  // ============================================
  // Queries
  // ============================================

  const limitsQuery = useQuery({
    queryKey: LIMITS_QUERY_KEY,
    queryFn: () => adminUsersBackendService.getLimits(),
  });

  const listQuery = useQuery({
    queryKey: LIST_QUERY_KEY,
    queryFn: () => adminUsersBackendService.list({ limit: 100 }),
  });

  // ============================================
  // Derivados
  // ============================================

  const users = listQuery.data?.data ?? [];

  const filteredUsers = useMemo(() => {
    return users.filter((u) => {
      const term = searchTerm.trim().toLowerCase();
      const matchSearch =
        !term ||
        u.nome.toLowerCase().includes(term) ||
        u.email.toLowerCase().includes(term);
      const matchRole = roleFilter === 'all' || u.role === roleFilter;
      const matchStatus = statusFilter === 'all' || u.status === statusFilter;
      return matchSearch && matchRole && matchStatus;
    });
  }, [users, searchTerm, roleFilter, statusFilter]);

  const limits = limitsQuery.data;
  const limitRatio =
    limits && limits.maxAgents > 0 ? limits.usedAgents / limits.maxAgents : 0;
  const atLimit = !!limits && limits.usedAgents >= limits.maxAgents;
  const nearLimit = limitRatio >= 0.8 && !atLimit;

  const limitBadgeClass = atLimit
    ? 'bg-destructive/15 text-destructive border-destructive/30'
    : nearLimit
    ? 'bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30'
    : 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/20';

  // ============================================
  // Handlers
  // ============================================

  const openCreate = () => {
    if (atLimit) {
      toast.error(
        `Você atingiu o limite de ${limits?.maxAgents} agentes do seu plano. Desative ou remova um antes de adicionar outro.`
      );
      return;
    }
    setEditingAgente(null);
    setFormOpen(true);
  };

  const openEdit = (agente: AdminUser) => {
    setEditingAgente(agente);
    setFormOpen(true);
  };

  const onSaved = () => {
    // Invalida lista e limites — limite muda quando criamos/promovemos agent.
    queryClient.invalidateQueries({ queryKey: LIST_QUERY_KEY });
    queryClient.invalidateQueries({ queryKey: LIMITS_QUERY_KEY });
  };

  const onConfirmToggle = async () => {
    if (!toggleTarget) return;
    setToggleLoading(true);
    try {
      const next: AdminUser['status'] =
        toggleTarget.status === 'active' ? 'inactive' : 'active';
      await adminUsersBackendService.update(toggleTarget.id, { status: next });
      toast.success(
        next === 'active'
          ? 'Agente reativado com sucesso!'
          : 'Agente desativado com sucesso!'
      );
      setToggleTarget(null);
      onSaved();
    } catch (error: any) {
      const msg = error?.message ?? 'Erro ao atualizar status';
      const code = error?.code;
      if (
        error?.status === 422 &&
        (code === 'AGENT_LIMIT_EXCEEDED' ||
          msg.toLowerCase().includes('limite'))
      ) {
        toast.error(
          `Você atingiu o limite de ${limits?.maxAgents ?? ''} agentes do seu plano.`
        );
      } else {
        toast.error(msg);
      }
    } finally {
      setToggleLoading(false);
    }
  };

  // ============================================
  // Render
  // ============================================

  const isLoading = listQuery.isLoading;
  const loadError = listQuery.error as any;

  return (
    <div className="page-container">
      {/* Header */}
      <div className="page-header">
        <div className="flex flex-col sm:flex-row sm:items-center gap-3">
          <div>
            <h1 className="text-xl sm:text-2xl md:text-3xl font-bold text-foreground flex items-center gap-2">
              <UserCog className="w-6 h-6 text-primary" />
              Equipe
            </h1>
            <p className="text-xs sm:text-sm text-muted-foreground">
              Gerencie os agentes que atendem na sua conta
            </p>
          </div>
          {limitsQuery.isLoading ? (
            <Badge
              variant="outline"
              className="bg-muted text-muted-foreground border-muted-foreground/20"
            >
              <Loader2 className="w-3 h-3 mr-1 animate-spin" />
              Carregando limites...
            </Badge>
          ) : limits ? (
            <Badge variant="outline" className={cn('border', limitBadgeClass)}>
              {limits.usedAgents} de {limits.maxAgents} agentes usados
              {limits.plan ? ` · ${limits.plan}` : ''}
            </Badge>
          ) : null}
        </div>

        <Button
          onClick={openCreate}
          disabled={atLimit}
          className="bg-primary text-primary-foreground hover:bg-primary/90 gap-2"
          title={
            atLimit
              ? `Limite de ${limits?.maxAgents} agentes atingido`
              : 'Convidar agente'
          }
        >
          <Plus className="w-4 h-4" />
          Novo Agente
        </Button>
      </div>

      {atLimit && (
        <Card className="border-destructive/30 bg-destructive/5">
          <CardContent className="p-4 flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-destructive flex-shrink-0 mt-0.5" />
            <div className="text-sm">
              <p className="font-medium text-destructive">
                Limite de agentes do plano atingido
              </p>
              <p className="text-muted-foreground mt-1">
                Você está usando {limits?.usedAgents} de {limits?.maxAgents}{' '}
                agentes. Desative ou remova um agente antes de adicionar outro,
                ou faça upgrade do plano.
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Filtros */}
      <Card>
        <CardContent className="p-4">
          <div className="flex flex-col sm:flex-row gap-4">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input
                placeholder="Buscar por nome ou e-mail..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="pl-9"
              />
            </div>
            <Select
              value={roleFilter}
              onValueChange={(v) => setRoleFilter(v as AdminUserRole | 'all')}
            >
              <SelectTrigger className="w-full sm:w-[160px]">
                <SelectValue placeholder="Papel" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Todos os papéis</SelectItem>
                <SelectItem value="admin">Admin</SelectItem>
                <SelectItem value="agent">Agente</SelectItem>
              </SelectContent>
            </Select>
            <Select
              value={statusFilter}
              onValueChange={(v) =>
                setStatusFilter(v as AdminUser['status'] | 'all')
              }
            >
              <SelectTrigger className="w-full sm:w-[160px]">
                <SelectValue placeholder="Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Todos os status</SelectItem>
                <SelectItem value="active">Ativo</SelectItem>
                <SelectItem value="inactive">Inativo</SelectItem>
                <SelectItem value="suspended">Suspenso</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      {/* Tabela */}
      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <Table className="min-w-[720px]">
              <TableHeader>
                <TableRow>
                  <TableHead className="min-w-[200px]">Usuário</TableHead>
                  <TableHead className="min-w-[90px]">Papel</TableHead>
                  <TableHead className="min-w-[90px]">Status</TableHead>
                  <TableHead className="min-w-[160px] hidden md:table-cell">
                    Permissões
                  </TableHead>
                  <TableHead className="min-w-[140px] hidden sm:table-cell">
                    Último login
                  </TableHead>
                  <TableHead className="text-right min-w-[80px]">Ações</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? (
                  <TableRow>
                    <TableCell colSpan={6} className="text-center py-12">
                      <div className="flex flex-col items-center gap-2">
                        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
                        <p className="text-sm text-muted-foreground">
                          Carregando equipe...
                        </p>
                      </div>
                    </TableCell>
                  </TableRow>
                ) : loadError ? (
                  <TableRow>
                    <TableCell colSpan={6} className="text-center py-12">
                      <p className="text-sm text-destructive">
                        Erro ao carregar agentes: {loadError?.message ?? 'desconhecido'}
                      </p>
                      <Button
                        variant="link"
                        size="sm"
                        onClick={() => listQuery.refetch()}
                      >
                        Tentar novamente
                      </Button>
                    </TableCell>
                  </TableRow>
                ) : filteredUsers.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={6} className="text-center py-12">
                      <p className="text-sm text-muted-foreground">
                        {searchTerm || roleFilter !== 'all' || statusFilter !== 'all'
                          ? 'Nenhum agente encontrado com os filtros aplicados'
                          : 'Nenhum agente cadastrado ainda. Clique em "Novo Agente" para começar.'}
                      </p>
                    </TableCell>
                  </TableRow>
                ) : (
                  filteredUsers.map((u) => {
                    const isSelf = currentUser?.id === u.id;
                    return (
                      <TableRow key={u.id}>
                        <TableCell>
                          <div className="flex items-center gap-3">
                            <Avatar className="h-9 w-9">
                              <AvatarFallback
                                className={
                                  u.role === 'admin'
                                    ? 'bg-role-admin/20 text-role-admin'
                                    : 'bg-role-agent/20 text-role-agent'
                                }
                              >
                                {getInitials(u.nome)}
                              </AvatarFallback>
                            </Avatar>
                            <div>
                              {/* BUG-T024-02: trocado <p> por <div> porque
                                  shadcn Badge renderiza <div> internamente, e
                                  <div> dentro de <p> eh DOM invalido (warning
                                  validateDOMNesting no React 18). */}
                              <div className="font-medium flex items-center gap-2">
                                {u.nome}
                                {isSelf && (
                                  <Badge variant="outline" className="text-xs">
                                    você
                                  </Badge>
                                )}
                              </div>
                              <p className="text-sm text-muted-foreground">
                                {u.email}
                              </p>
                            </div>
                          </div>
                        </TableCell>
                        <TableCell>{getRoleBadge(u.role)}</TableCell>
                        <TableCell>{getStatusBadge(u.status)}</TableCell>
                        <TableCell className="hidden md:table-cell">
                          <span className="text-sm text-muted-foreground">
                            {/* BUG-T024-03: pluralizacao correta.
                                Antes: `${N} permissão${N>1?'ões':''}` =>
                                "3 permissãoões". Forma certa eh substituir
                                o sufixo, nao concatenar. */}
                            {u.permissions && u.permissions.length > 0
                              ? `${u.permissions.length} permiss${
                                  u.permissions.length === 1 ? 'ão' : 'ões'
                                }`
                              : '—'}
                          </span>
                        </TableCell>
                        <TableCell className="hidden sm:table-cell text-muted-foreground text-sm">
                          {u.lastLoginAt
                            ? safeFormatDateBR(u.lastLoginAt, "dd/MM/yyyy 'às' HH:mm")
                            : 'Nunca'}
                        </TableCell>
                        <TableCell className="text-right">
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button variant="ghost" size="icon">
                                <MoreHorizontal className="w-4 h-4" />
                                <span className="sr-only">Ações</span>
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuLabel>Ações</DropdownMenuLabel>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem onClick={() => openEdit(u)}>
                                <Edit className="w-4 h-4 mr-2" />
                                Editar
                              </DropdownMenuItem>
                              {!isSelf && (
                                <DropdownMenuItem
                                  onClick={() => setToggleTarget(u)}
                                  className={
                                    u.status === 'active'
                                      ? 'text-destructive'
                                      : ''
                                  }
                                >
                                  {u.status === 'active' ? (
                                    <>
                                      <PowerOff className="w-4 h-4 mr-2" />
                                      Desativar
                                    </>
                                  ) : (
                                    <>
                                      <Power className="w-4 h-4 mr-2" />
                                      Reativar
                                    </>
                                  )}
                                </DropdownMenuItem>
                              )}
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </TableCell>
                      </TableRow>
                    );
                  })
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      {/* Dialog Criar/Editar */}
      <AgenteFormDialog
        open={formOpen}
        onOpenChange={(v) => {
          setFormOpen(v);
          if (!v) setEditingAgente(null);
        }}
        agente={editingAgente}
        onSaved={onSaved}
      />

      {/* Confirmar Desativar/Reativar */}
      <AlertDialog
        open={!!toggleTarget}
        onOpenChange={(v) => {
          if (!v) setToggleTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {toggleTarget?.status === 'active'
                ? 'Desativar agente?'
                : 'Reativar agente?'}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {toggleTarget?.status === 'active' ? (
                <>
                  <strong>{toggleTarget?.nome}</strong> perderá acesso ao
                  sistema imediatamente. Você pode reativar a qualquer momento.
                </>
              ) : (
                <>
                  <strong>{toggleTarget?.nome}</strong> voltará a ter acesso ao
                  sistema com as permissões atuais.
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={toggleLoading}>
              Cancelar
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                onConfirmToggle();
              }}
              disabled={toggleLoading}
              className={
                toggleTarget?.status === 'active'
                  ? 'bg-destructive text-destructive-foreground hover:bg-destructive/90'
                  : ''
              }
            >
              {toggleLoading ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Aplicando...
                </>
              ) : toggleTarget?.status === 'active' ? (
                'Desativar'
              ) : (
                'Reativar'
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
