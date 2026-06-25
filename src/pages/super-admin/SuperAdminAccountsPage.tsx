import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { accountsCloudOrBackend } from '@/services';
import type { Account } from '@/services/accounts.cloud.service';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
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
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Building2,
  Plus,
  Search,
  MoreHorizontal,
  Edit,
  Trash2,
  Users,
  Pause,
  Play,
  Eye,
  Loader2,
} from 'lucide-react';
import { safeFormatDateBR } from '@/utils/dateUtils';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { Skeleton } from '@/components/ui/skeleton';

type AccountStatus = 'active' | 'paused' | 'cancelled';
type Language = 'pt' | 'en';

interface CreateFormData {
  nome: string;
  idioma: Language;
  status: AccountStatus;
  limiteAgentes: number;
  monthly_extraction_limit: number;
  monthly_email_limit: number;
  daily_email_limit: number;
  openaiEnabled: boolean;
  openaiApiKey: string;
  sendgridEnabled: boolean;
  sendgridApiKey: string;
  sendgridFromEmail: string;
  sendgridFromName: string;
}

const initialFormData: CreateFormData = {
  nome: '',
  idioma: 'pt',
  status: 'active',
  limiteAgentes: 10,
  monthly_extraction_limit: 100,
  monthly_email_limit: 3000,
  daily_email_limit: 100,
  openaiEnabled: false,
  openaiApiKey: '',
  sendgridEnabled: false,
  sendgridApiKey: '',
  sendgridFromEmail: '',
  sendgridFromName: '',
};

export default function SuperAdminAccountsPage() {
  const navigate = useNavigate();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState<AccountStatus | 'all'>('all');
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [editingAccount, setEditingAccount] = useState<Account | null>(null);
  const [deleteAccount, setDeleteAccount] = useState<Account | null>(null);
  const [deletePassword, setDeletePassword] = useState('');
  const [isSaving, setIsSaving] = useState(false);

  // Form state
  const [formData, setFormData] = useState<CreateFormData>(initialFormData);

  // Load accounts from database
  useEffect(() => {
    loadAccounts();
  }, []);

  const loadAccounts = async () => {
    try {
      setIsLoading(true);
      const data = await accountsCloudOrBackend.list();
      setAccounts(data);
    } catch (error: any) {
      toast.error('Erro ao carregar contas: ' + error.message);
    } finally {
      setIsLoading(false);
    }
  };

  const filteredAccounts = accounts.filter((account) => {
    const term = searchTerm.toLowerCase();
    const matchesSearch =
      !term ||
      account.nome.toLowerCase().includes(term) ||
      account.id.toLowerCase().includes(term) ||
      (account.plano || '').toLowerCase().includes(term);
    if (statusFilter === 'all') {
      return matchesSearch && account.status !== 'cancelled';
    }
    return matchesSearch && account.status === statusFilter;
  });

  const handleCreate = async () => {
    if (!formData.nome.trim()) {
      toast.error('Nome é obrigatório');
      return;
    }

    try {
      setIsSaving(true);
      await accountsCloudOrBackend.create({
        nome: formData.nome,
        monthly_extraction_limit: formData.monthly_extraction_limit,
        monthly_email_limit: formData.monthly_email_limit,
        daily_email_limit: formData.daily_email_limit,
        openai_api_key: formData.openaiEnabled ? formData.openaiApiKey : undefined,
        sendgrid_api_key: formData.sendgridEnabled ? formData.sendgridApiKey : undefined,
        sendgrid_from_email: formData.sendgridEnabled ? formData.sendgridFromEmail : undefined,
        sendgrid_from_name: formData.sendgridEnabled ? formData.sendgridFromName : undefined,
      } as any);

      await loadAccounts();
      closeAndReset();
      toast.success('Conta criada com sucesso!');
    } catch (error: any) {
      toast.error('Erro ao criar conta: ' + error.message);
    } finally {
      setIsSaving(false);
    }
  };

  const closeAndReset = () => {
    setIsCreateOpen(false);
    setFormData(initialFormData);
  };

  const handleUpdate = async () => {
    if (!editingAccount) return;

    try {
      setIsSaving(true);
      await accountsCloudOrBackend.update(editingAccount.id, {
        nome: editingAccount.nome,
        status: editingAccount.status,
        monthly_extraction_limit: (editingAccount as any).monthly_extraction_limit,
        monthly_email_limit: (editingAccount as any).monthly_email_limit,
        daily_email_limit: (editingAccount as any).daily_email_limit,
        openai_api_key: (editingAccount as any).openai_api_key,
        sendgrid_api_key: (editingAccount as any).sendgrid_api_key,
        sendgrid_from_email: (editingAccount as any).sendgrid_from_email,
        sendgrid_from_name: (editingAccount as any).sendgrid_from_name,
      } as any);

      await loadAccounts();
      setEditingAccount(null);
      toast.success('Conta atualizada com sucesso!');
    } catch (error: any) {
      toast.error('Erro ao atualizar conta: ' + error.message);
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!deleteAccount || !deletePassword) {
      toast.error('Digite sua senha para confirmar!');
      return;
    }

    try {
      setIsSaving(true);
      await accountsCloudOrBackend.delete(deleteAccount.id, deletePassword);
      await loadAccounts();
      setDeleteAccount(null);
      setDeletePassword('');
      toast.success('Conta excluída com sucesso!');
    } catch (error: any) {
      toast.error('Erro ao excluir conta: ' + error.message);
    } finally {
      setIsSaving(false);
    }
  };

  const handleToggleStatus = async (account: Account) => {
    const newStatus = account.status === 'active' ? 'paused' : 'active';
    try {
      await accountsCloudOrBackend.update(account.id, { status: newStatus });
      await loadAccounts();
      toast.success(
        `Conta ${newStatus === 'active' ? 'reativada' : 'pausada'} com sucesso!`
      );
    } catch (error: any) {
      toast.error('Erro ao alterar status: ' + error.message);
    }
  };

  const getStatusBadge = (status: AccountStatus) => {
    const variants: Record<AccountStatus, { className: string; label: string }> = {
      active: { className: 'bg-emerald-500/10 text-emerald-500', label: 'Ativa' },
      paused: { className: 'bg-amber-500/10 text-amber-500', label: 'Pausada' },
      cancelled: { className: 'bg-rose-500/10 text-rose-500', label: 'Cancelada' },
    };
    const cfg = variants[status];
    return <Badge className={cn('border-0', cfg.className)}>{cfg.label}</Badge>;
  };

  return (
    <div className="page-container">
      <div className="page-header">
        <div className="min-w-0">
          <h1 className="title-responsive text-foreground">Contas</h1>
          <p className="text-responsive-sm text-muted-foreground">
            Gerencie as contas (tenants) da plataforma
          </p>
        </div>
        <Dialog open={isCreateOpen} onOpenChange={setIsCreateOpen}>
          <DialogTrigger asChild>
            <Button className="gap-2">
              <Plus className="w-4 h-4" />
              Nova Conta
            </Button>
          </DialogTrigger>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>Criar Nova Conta</DialogTitle>
              <DialogDescription>
                Cadastre uma nova conta (tenant) na plataforma.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-2">
              <div className="space-y-2">
                <Label htmlFor="create-nome">Nome *</Label>
                <Input
                  id="create-nome"
                  value={formData.nome}
                  onChange={(e) => setFormData({ ...formData, nome: e.target.value })}
                  placeholder="Nome da empresa"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="create-idioma">Idioma</Label>
                <Select
                  value={formData.idioma}
                  onValueChange={(v) => setFormData({ ...formData, idioma: v as Language })}
                >
                  <SelectTrigger id="create-idioma">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="pt">Português</SelectItem>
                    <SelectItem value="en">English</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <DialogFooter className="flex-col sm:flex-row gap-2">
              <Button variant="outline" onClick={closeAndReset} disabled={isSaving}>
                Cancelar
              </Button>
              <Button onClick={handleCreate} disabled={isSaving}>
                {isSaving ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Criando...
                  </>
                ) : (
                  'Criar Conta'
                )}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      {/* Filters */}
      <Card>
        <CardContent className="p-3 sm:p-4">
          <div className="filter-container">
            <div className="relative flex-1 min-w-0">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input
                placeholder="Buscar por nome, ID ou plano..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="pl-9 min-h-[40px]"
              />
            </div>
            <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as AccountStatus | 'all')}>
              <SelectTrigger className="w-full sm:w-[160px] min-h-[40px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Ativas e Pausadas</SelectItem>
                <SelectItem value="active">Ativas</SelectItem>
                <SelectItem value="paused">Pausadas</SelectItem>
                <SelectItem value="cancelled">Canceladas</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      {/* Accounts Table */}
      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-6 space-y-3">
              {[1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : filteredAccounts.length === 0 ? (
            <div className="text-center py-16 px-4 text-muted-foreground">
              <Building2 className="w-12 h-12 mx-auto mb-3 opacity-50" />
              <p>Nenhuma conta encontrada</p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Nome</TableHead>
                  <TableHead className="hidden md:table-cell">ID</TableHead>
                  <TableHead className="hidden sm:table-cell">Status</TableHead>
                  <TableHead className="hidden lg:table-cell">Criada em</TableHead>
                  <TableHead className="w-[60px] text-right">Ações</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredAccounts.map((account) => {
                  const accountId8 = account.id.substring(0, 8);
                  return (
                    <TableRow key={account.id}>
                      <TableCell>
                        <button
                          type="button"
                          className="font-medium text-left hover:underline"
                          onClick={() => navigate(`/super-admin/accounts/${account.id}`)}
                        >
                          {account.nome}
                        </button>
                      </TableCell>
                      <TableCell className="hidden md:table-cell">
                        <code className="text-xs bg-muted px-2 py-1 rounded font-mono">
                          {accountId8}...
                        </code>
                      </TableCell>
                      <TableCell className="hidden sm:table-cell">
                        {getStatusBadge(account.status)}
                      </TableCell>
                      <TableCell className="hidden lg:table-cell text-muted-foreground">
                        {safeFormatDateBR(account.created_at, 'dd/MM/yyyy')}
                      </TableCell>
                      <TableCell className="text-right">
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon">
                              <MoreHorizontal className="w-4 h-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuLabel>Ações</DropdownMenuLabel>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              onClick={() => navigate(`/super-admin/accounts/${account.id}`)}
                            >
                              <Eye className="w-4 h-4 mr-2" />
                              Ver Detalhes
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => setEditingAccount(account)}>
                              <Edit className="w-4 h-4 mr-2" />
                              Editar
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onClick={() => navigate(`/super-admin/accounts/${account.id}#users`)}
                            >
                              <Users className="w-4 h-4 mr-2" />
                              Ver Usuários
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => handleToggleStatus(account)}>
                              {account.status === 'active' ? (
                                <>
                                  <Pause className="w-4 h-4 mr-2" />
                                  Pausar
                                </>
                              ) : (
                                <>
                                  <Play className="w-4 h-4 mr-2" />
                                  Ativar
                                </>
                              )}
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              className="text-destructive"
                              onClick={() => setDeleteAccount(account)}
                            >
                              <Trash2 className="w-4 h-4 mr-2" />
                              Excluir
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Edit Dialog */}
      <Dialog open={!!editingAccount} onOpenChange={(open) => !open && setEditingAccount(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Editar Conta</DialogTitle>
            <DialogDescription>Atualize os dados básicos da conta.</DialogDescription>
          </DialogHeader>
          {editingAccount && (
            <div className="space-y-4 py-2">
              <div className="space-y-2">
                <Label htmlFor="edit-nome">Nome</Label>
                <Input
                  id="edit-nome"
                  value={editingAccount.nome}
                  onChange={(e) =>
                    setEditingAccount({ ...editingAccount, nome: e.target.value })
                  }
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="edit-status">Status</Label>
                <Select
                  value={editingAccount.status}
                  onValueChange={(v) =>
                    setEditingAccount({ ...editingAccount, status: v as AccountStatus })
                  }
                >
                  <SelectTrigger id="edit-status">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="active">Ativa</SelectItem>
                    <SelectItem value="paused">Pausada</SelectItem>
                    <SelectItem value="cancelled">Cancelada</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          )}
          <DialogFooter className="flex-col sm:flex-row gap-2">
            <Button variant="outline" onClick={() => setEditingAccount(null)} disabled={isSaving}>
              Cancelar
            </Button>
            <Button onClick={handleUpdate} disabled={isSaving}>
              {isSaving ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Salvando...
                </>
              ) : (
                'Salvar Alterações'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation */}
      <AlertDialog
        open={!!deleteAccount}
        onOpenChange={(open) => {
          if (!open) {
            setDeleteAccount(null);
            setDeletePassword('');
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="text-destructive">Excluir Conta</AlertDialogTitle>
            <AlertDialogDescription>
              Esta ação é irreversível. Digite sua senha de Super Admin para confirmar a exclusão de{' '}
              <strong>{deleteAccount?.nome}</strong>.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-2 py-2">
            <Label htmlFor="delete-pwd">Senha do Super Admin</Label>
            <Input
              id="delete-pwd"
              type="password"
              value={deletePassword}
              onChange={(e) => setDeletePassword(e.target.value)}
              placeholder="Digite sua senha"
            />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isSaving}>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={handleDelete}
              disabled={isSaving || !deletePassword}
            >
              {isSaving ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Excluindo...
                </>
              ) : (
                'Excluir'
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
