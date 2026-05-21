import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { accountsCloudOrBackend, usersCloudOrBackend } from '@/services';
import type { Account } from '@/services/accounts.cloud.service';
import type { Profile } from '@/services/users.cloud.service';
import { UserRole, UserStatus } from '@/types/crm';
import { cn } from '@/lib/utils';
import { useAuth } from '@/contexts/AuthContext';
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
  AlertDialog,
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
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Plus,
  Search,
  MoreHorizontal,
  Edit,
  Trash2,
  ArrowLeftRight,
  UserCog,
  Shield,
  Eye,
  EyeOff,
  LayoutDashboard,
  Kanban,
  Users,
  Calendar,
  DollarSign,
  Wallet,
  Package,
  Activity,
  RotateCcw,
  Lightbulb,
  Loader2,
  Crosshair,
  Mail,
} from 'lucide-react';
import { safeFormatDateBR } from '@/utils/dateUtils';
import { toast } from 'sonner';

// Extend Profile to match User type expectations
interface UserWithRole extends Profile {
  last_login_at?: string | null;
}

export default function SuperAdminUsersPage() {
  const [users, setUsers] = useState<UserWithRole[]>([]);
  const [usersLoading, setUsersLoading] = useState(true);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [accountsLoading, setAccountsLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [roleFilter, setRoleFilter] = useState<UserRole | 'all'>('all');
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [createLoading, setCreateLoading] = useState(false);

  // Load accounts and users from database on mount
  useEffect(() => {
    const loadData = async () => {
      try {
        setAccountsLoading(true);
        setUsersLoading(true);
        
        const [accountsData, usersData] = await Promise.all([
          accountsCloudOrBackend.list(),
          usersCloudOrBackend.list(),
        ]);
        
        setAccounts(accountsData);
        setUsers(usersData);
      } catch (error: any) {
        console.error('Error loading data:', error);
        toast.error('Erro ao carregar dados');
      } finally {
        setAccountsLoading(false);
        setUsersLoading(false);
      }
    };
    loadData();
  }, []);
  const [editingUser, setEditingUser] = useState<UserWithRole | null>(null);
  const [editFormData, setEditFormData] = useState({
    nome: '',
    email: '',
    role: 'agent' as UserRole,
    account_id: '',
    status: 'active' as 'active' | 'inactive',
    password: '',
    confirmPassword: '',
    permissions: [] as string[],
  });
  const [showEditPassword, setShowEditPassword] = useState(false);
  const { impersonate } = useAuth();
  const navigate = useNavigate();

  const [showPassword, setShowPassword] = useState(false);

  // Delete confirmation with password
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [userToDelete, setUserToDelete] = useState<UserWithRole | null>(null);
  const [deletePassword, setDeletePassword] = useState('');
  const [showDeletePassword, setShowDeletePassword] = useState(false);
  const [deleteLoading, setDeleteLoading] = useState(false);

  // Agent permission areas - matching actual system pages
  const agentPermissionAreas = [
    { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
    { id: 'kanban', label: 'Kanban', icon: Kanban },
    { id: 'leads', label: 'Leads', icon: Users },
    { id: 'agenda', label: 'Agenda', icon: Calendar },
    { id: 'sales', label: 'Vendas', icon: DollarSign },
    { id: 'finance', label: 'Financeiro', icon: Wallet },
    { id: 'products', label: 'Produtos', icon: Package },
    { id: 'events', label: 'Eventos', icon: Activity },
    { id: 'insights', label: 'Insights', icon: Lightbulb },
    { id: 'extracao', label: 'Prospecção', icon: Crosshair },
    { id: 'emails', label: 'E-mails', icon: Mail },
  ];

  // Special action permissions
  const agentActionPermissions = [
    { id: 'refunds', label: 'Realizar Estornos', icon: RotateCcw },
  ];

  const [formData, setFormData] = useState({
    nome: '',
    email: '',
    role: 'agent' as UserRole,
    account_id: '',
    password: '',
    confirmPassword: '',
    permissions: [] as string[],
  });

  const filteredUsers = users.filter((user) => {
    const matchesSearch =
      user.nome.toLowerCase().includes(searchTerm.toLowerCase()) ||
      user.email.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesRole = roleFilter === 'all' || user.role === roleFilter;
    return matchesSearch && matchesRole;
  });

  const getAccountName = (accountId: string | null) => {
    if (!accountId) return 'Global';
    const account = accounts.find((a) => a.id === accountId);
    return account?.nome || 'Desconhecido';
  };

  const getInitials = (name: string) => {
    return name
      .split(' ')
      .map((n) => n[0])
      .slice(0, 2)
      .join('')
      .toUpperCase();
  };

  const togglePermission = (permissionId: string) => {
    setFormData(prev => ({
      ...prev,
      permissions: prev.permissions.includes(permissionId)
        ? prev.permissions.filter(p => p !== permissionId)
        : [...prev.permissions, permissionId]
    }));
  };

  const isCreateFormValid = () => {
    const baseValid = formData.nome && formData.email && formData.password && formData.confirmPassword;
    const passwordsMatch = formData.password === formData.confirmPassword;
    const passwordMinLength = formData.password.length >= 6;
    const accountValid = formData.role === 'super_admin' || formData.account_id;
    // Agents must have at least 'dashboard' permission
    const permissionsValid = formData.role !== 'agent' || formData.permissions.includes('dashboard');
    
    return baseValid && passwordsMatch && passwordMinLength && accountValid && permissionsValid;
  };

  const handleCreate = async () => {
    if (formData.password !== formData.confirmPassword) {
      toast.error('As senhas não coincidem!');
      return;
    }
    if (formData.password.length < 6) {
      toast.error('A senha deve ter pelo menos 6 caracteres!');
      return;
    }
    
    setCreateLoading(true);
    
    try {
      const newUser = await usersCloudOrBackend.create({
        nome: formData.nome,
        email: formData.email,
        password: formData.password,
        role: formData.role,
        account_id: formData.role === 'super_admin' ? undefined : formData.account_id || undefined,
        permissions: formData.role === 'agent' ? formData.permissions : undefined,
      });
      
      setUsers([newUser, ...users]);
      setIsCreateOpen(false);
      setFormData({ 
        nome: '', 
        email: '', 
        role: 'agent', 
        account_id: '', 
        password: '', 
        confirmPassword: '',
        permissions: [] 
      });
      setShowPassword(false);
      toast.success('Usuário criado com sucesso!');
    } catch (error: any) {
      console.error('Error creating user:', error);
      toast.error(error.message || 'Erro ao criar usuário');
    } finally {
      setCreateLoading(false);
    }
  };

  const handleEditOpen = (user: UserWithRole) => {
    setEditFormData({
      nome: user.nome,
      email: user.email,
      role: user.role,
      account_id: user.account_id || '',
      status: user.status === 'active' ? 'active' : 'inactive',
      password: '',
      confirmPassword: '',
      permissions: user.permissions || [],
    });
    setShowEditPassword(false);
    setEditingUser(user);
  };

  const toggleEditPermission = (permissionId: string) => {
    setEditFormData(prev => ({
      ...prev,
      permissions: prev.permissions.includes(permissionId)
        ? prev.permissions.filter(p => p !== permissionId)
        : [...prev.permissions, permissionId]
    }));
  };

  const isEditFormValid = () => {
    const baseValid = editFormData.nome && editFormData.email;
    const accountValid = editFormData.role === 'super_admin' || editFormData.account_id;
    // Agents must have at least 'dashboard' permission
    const permissionsValid = editFormData.role !== 'agent' || editFormData.permissions.includes('dashboard');
    
    // Password validation only if password is being changed
    if (editFormData.password || editFormData.confirmPassword) {
      const passwordsMatch = editFormData.password === editFormData.confirmPassword;
      const passwordMinLength = editFormData.password.length >= 6;
      return baseValid && accountValid && permissionsValid && passwordsMatch && passwordMinLength;
    }
    
    return baseValid && accountValid && permissionsValid;
  };

  const handleUpdate = async () => {
    if (!editingUser) return;
    
    if (editFormData.password && editFormData.password !== editFormData.confirmPassword) {
      toast.error('As senhas não coincidem!');
      return;
    }
    if (editFormData.password && editFormData.password.length < 6) {
      toast.error('A senha deve ter pelo menos 6 caracteres!');
      return;
    }
    
    try {
      const updatePayload: any = {
        nome: editFormData.nome,
        email: editFormData.email,
        role: editFormData.role,
        account_id: editFormData.role === 'super_admin' ? null : editFormData.account_id || null,
        status: editFormData.status,
        permissions: editFormData.role === 'agent' ? editFormData.permissions : undefined,
      };
      if (editFormData.password) {
        updatePayload.password = editFormData.password;
      }

      await usersCloudOrBackend.update(editingUser.user_id || editingUser.id, updatePayload);
      
      const updatedUser: UserWithRole = {
        ...editingUser,
        ...updatePayload,
        updated_at: new Date().toISOString(),
      };
      
      setUsers(users.map((u) => u.id === editingUser.id ? updatedUser : u));
      setEditingUser(null);
      setEditFormData({
        nome: '',
        email: '',
        role: 'agent',
        account_id: '',
        status: 'active',
        password: '',
        confirmPassword: '',
        permissions: [],
      });
      toast.success('Usuário atualizado com sucesso!');
    } catch (error: any) {
      if (error?.status === 404) {
        // User doesn't exist in DB - remove from local state
        setUsers(users.filter((u) => u.id !== editingUser.id));
        setEditingUser(null);
        toast.error('Usuário não encontrado no banco de dados. Removido da lista.');
      } else {
        toast.error(error.message || 'Erro ao atualizar usuário');
      }
    }
  };

  // Opens delete confirmation modal
  const openDeleteConfirm = (user: UserWithRole) => {
    setUserToDelete(user);
    setDeletePassword('');
    setShowDeletePassword(false);
    setDeleteConfirmOpen(true);
  };

  // Executes deletion after password validation
  const handleConfirmDelete = async () => {
    if (!userToDelete || !deletePassword) return;
    
    setDeleteLoading(true);
    
    try {
      // Call the real delete service with password verification
      await usersCloudOrBackend.delete(userToDelete.user_id, deletePassword);
      
      // Remove from local state on success
      setUsers(users.filter((u) => u.id !== userToDelete.id));
      setDeleteConfirmOpen(false);
      setUserToDelete(null);
      setDeletePassword('');
      toast.success('Usuário excluído com sucesso!');
    } catch (error: any) {
      const errorMsg = error.message || 'Erro ao excluir usuário';
      
      // Keep modal open for password errors so user can retry
      if (errorMsg.includes('Senha incorreta') || errorMsg.includes('password')) {
        toast.error('Senha incorreta. Tente novamente.');
      } else {
        toast.error(errorMsg);
        // Close modal for other errors
        setDeleteConfirmOpen(false);
        setUserToDelete(null);
        setDeletePassword('');
      }
    } finally {
      setDeleteLoading(false);
    }
  };

  const handleImpersonate = (user: UserWithRole) => {
    impersonate(user.id);
    // Navigate based on user role
    if (user.role === 'admin') {
      navigate('/admin');
    } else if (user.role === 'agent') {
      navigate('/agent');
    }
    toast.success(`Visualizando como ${user.nome}`);
  };

  const getRoleBadge = (role: UserRole) => {
    switch (role) {
      case 'super_admin':
        return <span className="badge-super-admin">Super Admin</span>;
      case 'admin':
        return <span className="badge-admin">Admin</span>;
      case 'agent':
        return <span className="badge-agent">Agente</span>;
    }
  };

  return (
    <div className="page-container">
      {/* Header */}
      <div className="page-header">
        <div>
          <h1 className="text-xl sm:text-2xl md:text-3xl font-bold text-foreground">Usuários</h1>
          <p className="text-xs sm:text-sm text-muted-foreground">Gerencie todos os usuários do sistema</p>
        </div>
        <Dialog open={isCreateOpen} onOpenChange={setIsCreateOpen}>
          <DialogTrigger asChild>
            <Button className="bg-primary text-primary-foreground hover:bg-primary/90 gap-2">
              <Plus className="w-4 h-4" />
              Novo Usuário
            </Button>
          </DialogTrigger>
          <DialogContent className="max-w-lg max-h-[90vh] overflow-hidden flex flex-col">
            <DialogHeader className="flex-shrink-0">
              <DialogTitle>Criar Novo Usuário</DialogTitle>
              <DialogDescription>Adicione um novo usuário ao sistema</DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-4 overflow-y-auto flex-1 px-1 py-1 [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]">
              <div className="space-y-2">
                <Label htmlFor="nome">Nome <span className="text-destructive">*</span></Label>
                <Input
                  id="nome"
                  value={formData.nome}
                  onChange={(e) => setFormData({ ...formData, nome: e.target.value })}
                  placeholder="Nome completo"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="email">E-mail <span className="text-destructive">*</span></Label>
                <Input
                  id="email"
                  type="email"
                  value={formData.email}
                  onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                  placeholder="email@exemplo.com"
                />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="role">Papel <span className="text-destructive">*</span></Label>
                  <Select
                    value={formData.role}
                    onValueChange={(v) => setFormData({ ...formData, role: v as UserRole, permissions: [] })}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="super_admin">Super Admin</SelectItem>
                      <SelectItem value="admin">Admin</SelectItem>
                      <SelectItem value="agent">Agente</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                {formData.role !== 'super_admin' && (
                  <div className="space-y-2">
                    <Label htmlFor="account">Conta <span className="text-destructive">*</span></Label>
                    <Select
                      value={formData.account_id}
                      onValueChange={(v) => setFormData({ ...formData, account_id: v })}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Selecione" />
                      </SelectTrigger>
                      <SelectContent>
                        {accountsLoading ? (
                          <SelectItem value="_loading" disabled>Carregando...</SelectItem>
                        ) : accounts.length === 0 ? (
                          <SelectItem value="_empty" disabled>Nenhuma conta encontrada</SelectItem>
                        ) : (
                          accounts.map((acc) => (
                            <SelectItem key={acc.id} value={acc.id}>
                              {acc.nome}
                            </SelectItem>
                          ))
                        )}
                      </SelectContent>
                    </Select>
                  </div>
                )}
              </div>

              {/* Agent Permissions */}
              {formData.role === 'agent' && (
                <div className="space-y-4 p-4 border rounded-lg bg-muted/30">
                  <div>
                    <Label className="font-medium">
                      Permissões de Acesso <span className="text-destructive">*</span>
                    </Label>
                    <p className="text-sm text-muted-foreground mt-1">
                      Selecione as páginas e ações que este agente poderá acessar
                    </p>
                  </div>
                  
                  {/* Page permissions */}
                  <div className="space-y-2">
                    <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Páginas</p>
                    <div className="grid grid-cols-1 xs:grid-cols-2 gap-2">
                      {agentPermissionAreas.map((area) => (
                        <div 
                          key={area.id} 
                          className={cn(
                            "flex items-center gap-2 p-2 rounded-md border cursor-pointer transition-colors",
                            formData.permissions.includes(area.id) 
                              ? "bg-primary/10 border-primary" 
                              : "bg-background hover:bg-muted"
                          )}
                          onClick={() => togglePermission(area.id)}
                        >
                          <Checkbox
                            id={`perm-${area.id}`}
                            checked={formData.permissions.includes(area.id)}
                            onCheckedChange={() => togglePermission(area.id)}
                            className="pointer-events-none"
                          />
                          <area.icon className="w-4 h-4 text-muted-foreground" />
                          <label
                            htmlFor={`perm-${area.id}`}
                            className="text-sm font-medium leading-none cursor-pointer flex-1"
                          >
                            {area.label}
                          </label>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Action permissions */}
                  <div className="space-y-2 pt-2 border-t">
                    <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Ações Especiais</p>
                    <div className="grid grid-cols-1 xs:grid-cols-2 gap-2">
                      {agentActionPermissions.map((action) => (
                        <div 
                          key={action.id} 
                          className={cn(
                            "flex items-center gap-2 p-2 rounded-md border cursor-pointer transition-colors",
                            formData.permissions.includes(action.id) 
                              ? "bg-primary/10 border-primary" 
                              : "bg-background hover:bg-muted"
                          )}
                          onClick={() => togglePermission(action.id)}
                        >
                          <Checkbox
                            id={`perm-${action.id}`}
                            checked={formData.permissions.includes(action.id)}
                            onCheckedChange={() => togglePermission(action.id)}
                            className="pointer-events-none"
                          />
                          <action.icon className="w-4 h-4 text-muted-foreground" />
                          <label
                            htmlFor={`perm-${action.id}`}
                            className="text-sm font-medium leading-none cursor-pointer flex-1"
                          >
                            {action.label}
                          </label>
                        </div>
                      ))}
                    </div>
                  </div>

                  {!formData.permissions.includes('dashboard') && (
                    <p className="text-sm text-warning">
                      A permissão "Dashboard" é obrigatória
                    </p>
                  )}
                </div>
              )}

              {/* Password Section */}
              <div className="space-y-3 p-4 border rounded-lg bg-muted/30">
                <Label className="font-medium">Definir Senha <span className="text-destructive">*</span></Label>
                <p className="text-sm text-muted-foreground">
                  O Super Admin deve definir a senha inicial do usuário
                </p>
                <div className="space-y-3 pt-2">
                  <div className="space-y-2">
                    <Label htmlFor="password">Senha</Label>
                    <div className="relative">
                      <Input
                        id="password"
                        type={showPassword ? 'text' : 'password'}
                        value={formData.password}
                        onChange={(e) => setFormData({ ...formData, password: e.target.value })}
                        placeholder="Mínimo 6 caracteres"
                        className="pr-10"
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="absolute right-0 top-0 h-full px-3 hover:bg-transparent"
                        onClick={() => setShowPassword(!showPassword)}
                      >
                        {showPassword ? (
                          <EyeOff className="w-4 h-4 text-muted-foreground" />
                        ) : (
                          <Eye className="w-4 h-4 text-muted-foreground" />
                        )}
                      </Button>
                    </div>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="confirmPassword">Confirmar Senha</Label>
                    <Input
                      id="confirmPassword"
                      type={showPassword ? 'text' : 'password'}
                      value={formData.confirmPassword}
                      onChange={(e) => setFormData({ ...formData, confirmPassword: e.target.value })}
                      placeholder="Digite a senha novamente"
                    />
                  </div>
                  {formData.password && formData.confirmPassword && formData.password !== formData.confirmPassword && (
                    <p className="text-sm text-destructive">As senhas não coincidem</p>
                  )}
                  {formData.password && formData.password.length < 6 && (
                    <p className="text-sm text-amber-600 dark:text-amber-400">A senha deve ter pelo menos 6 caracteres</p>
                  )}
                </div>
              </div>
            </div>
            <DialogFooter className="flex-shrink-0 flex-col sm:flex-row gap-3">
              <Button variant="outline" onClick={() => setIsCreateOpen(false)}>
                Cancelar
              </Button>
              <Button onClick={handleCreate} disabled={!isCreateFormValid() || createLoading}>
                {createLoading ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Criando...
                  </>
                ) : (
                  'Criar Usuário'
                )}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      {/* Filters */}
      <Card>
        <CardContent className="p-4">
          <div className="flex flex-col sm:flex-row gap-4">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input
                placeholder="Buscar por nome ou email..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="pl-9"
              />
            </div>
            <Select value={roleFilter} onValueChange={(v) => setRoleFilter(v as UserRole | 'all')}>
              <SelectTrigger className="w-full sm:w-[180px]">
                <SelectValue placeholder="Papel" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Todos os papéis</SelectItem>
                <SelectItem value="super_admin">Super Admin</SelectItem>
                <SelectItem value="admin">Admin</SelectItem>
                <SelectItem value="agent">Agente</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      {/* Table */}
      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <Table className="min-w-[700px]">
              <TableHeader>
                <TableRow>
                  <TableHead className="min-w-[180px]">Usuário</TableHead>
                  <TableHead className="min-w-[90px]">Papel</TableHead>
                  <TableHead className="min-w-[120px] hidden md:table-cell">Conta</TableHead>
                  <TableHead className="min-w-[80px]">Status</TableHead>
                  <TableHead className="min-w-[100px] hidden sm:table-cell">Último Login</TableHead>
                  <TableHead className="text-right min-w-[80px]">Ações</TableHead>
                </TableRow>
              </TableHeader>
            <TableBody>
              {usersLoading ? (
                <TableRow>
                  <TableCell colSpan={6} className="text-center py-12">
                    <div className="flex flex-col items-center gap-2">
                      <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
                      <p className="text-sm text-muted-foreground">Carregando usuários...</p>
                    </div>
                  </TableCell>
                </TableRow>
              ) : filteredUsers.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="text-center py-12">
                    <p className="text-sm text-muted-foreground">
                      {searchTerm || roleFilter !== 'all' 
                        ? 'Nenhum usuário encontrado com os filtros aplicados' 
                        : 'Nenhum usuário cadastrado'}
                    </p>
                  </TableCell>
                </TableRow>
              ) : (
              filteredUsers.map((user) => (
                <TableRow key={user.id}>
                  <TableCell>
                    <div className="flex items-center gap-3">
                      <Avatar className="h-9 w-9">
                        <AvatarFallback
                          className={
                            user.role === 'super_admin'
                              ? 'bg-role-super-admin/20 text-role-super-admin'
                              : user.role === 'admin'
                              ? 'bg-role-admin/20 text-role-admin'
                              : 'bg-role-agent/20 text-role-agent'
                          }
                        >
                          {getInitials(user.nome)}
                        </AvatarFallback>
                      </Avatar>
                      <div>
                        <p className="font-medium">{user.nome}</p>
                        <p className="text-sm text-muted-foreground">{user.email}</p>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell>{getRoleBadge(user.role)}</TableCell>
                  <TableCell className="text-muted-foreground hidden md:table-cell">
                    {getAccountName(user.account_id)}
                  </TableCell>
                  <TableCell>
                    <span
                      className={
                        user.status === 'active'
                          ? 'status-active'
                          : user.status === 'suspended'
                          ? 'status-paused'
                          : 'status-cancelled'
                      }
                    >
                      {user.status === 'active'
                        ? 'Ativo'
                        : user.status === 'suspended'
                        ? 'Suspenso'
                        : 'Inativo'}
                    </span>
                  </TableCell>
                  <TableCell className="text-muted-foreground hidden sm:table-cell">
                    {user.last_login_at
                      ? safeFormatDateBR(user.last_login_at, "dd/MM/yyyy 'às' HH:mm")
                      : 'Nunca'}
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
                        <DropdownMenuItem onClick={() => handleEditOpen(user)}>
                          <Edit className="w-4 h-4 mr-2" />
                          Editar
                        </DropdownMenuItem>
                        {user.role !== 'super_admin' && (
                          <DropdownMenuItem onClick={() => handleImpersonate(user)}>
                            <ArrowLeftRight className="w-4 h-4 mr-2" />
                            Acessar como usuário
                          </DropdownMenuItem>
                        )}
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          className="text-destructive"
                          onClick={() => openDeleteConfirm(user)}
                        >
                          <Trash2 className="w-4 h-4 mr-2" />
                          Excluir
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              ))
              )}
            </TableBody>
          </Table>
          </div>
        </CardContent>
      </Card>

      {/* Edit Dialog */}
      <Dialog open={!!editingUser} onOpenChange={() => setEditingUser(null)}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-hidden flex flex-col">
          <DialogHeader className="flex-shrink-0">
            <DialogTitle>Editar Usuário</DialogTitle>
            <DialogDescription>Atualize os dados do usuário</DialogDescription>
          </DialogHeader>
          {editingUser && (
            <div className="space-y-4 py-4 overflow-y-auto flex-1 px-1 py-1 [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]">
              <div className="space-y-2">
                <Label htmlFor="edit-nome">Nome <span className="text-destructive">*</span></Label>
                <Input
                  id="edit-nome"
                  value={editFormData.nome}
                  onChange={(e) => setEditFormData({ ...editFormData, nome: e.target.value })}
                  placeholder="Nome completo"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="edit-email">E-mail <span className="text-destructive">*</span></Label>
                <Input
                  id="edit-email"
                  type="email"
                  value={editFormData.email}
                  onChange={(e) => setEditFormData({ ...editFormData, email: e.target.value })}
                  placeholder="email@exemplo.com"
                />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="edit-role">Papel <span className="text-destructive">*</span></Label>
                  <Select
                    value={editFormData.role}
                    onValueChange={(v) => setEditFormData({ 
                      ...editFormData, 
                      role: v as UserRole,
                      permissions: v === 'agent' ? editFormData.permissions : []
                    })}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="super_admin">Super Admin</SelectItem>
                      <SelectItem value="admin">Admin</SelectItem>
                      <SelectItem value="agent">Agente</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="edit-status">Status <span className="text-destructive">*</span></Label>
                  <Select
                    value={editFormData.status}
                    onValueChange={(v) => setEditFormData({ ...editFormData, status: v as 'active' | 'inactive' })}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="active">Ativo</SelectItem>
                      <SelectItem value="inactive">Inativo</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {/* Account Selection (not for Super Admin) */}
              {editFormData.role !== 'super_admin' && (
                <div className="space-y-2">
                  <Label htmlFor="edit-account">Conta <span className="text-destructive">*</span></Label>
                  <Select
                    value={editFormData.account_id}
                    onValueChange={(v) => setEditFormData({ ...editFormData, account_id: v })}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Selecione uma conta" />
                    </SelectTrigger>
                    <SelectContent>
                      {accountsLoading ? (
                        <SelectItem value="_loading" disabled>Carregando...</SelectItem>
                      ) : accounts.length === 0 ? (
                        <SelectItem value="_empty" disabled>Nenhuma conta encontrada</SelectItem>
                      ) : (
                        accounts.map((acc) => (
                          <SelectItem key={acc.id} value={acc.id}>
                            {acc.nome}
                          </SelectItem>
                        ))
                      )}
                    </SelectContent>
                  </Select>
                </div>
              )}

              {/* Agent Permissions */}
              {editFormData.role === 'agent' && (
                <div className="space-y-4 p-4 border rounded-lg bg-muted/30">
                  <div>
                    <Label className="font-medium">
                      Permissões de Acesso <span className="text-destructive">*</span>
                    </Label>
                    <p className="text-sm text-muted-foreground mt-1">
                      Selecione as páginas e ações que este agente poderá acessar
                    </p>
                  </div>
                  
                  {/* Page permissions */}
                  <div className="space-y-2">
                    <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Páginas</p>
                    <div className="grid grid-cols-1 xs:grid-cols-2 gap-2">
                      {agentPermissionAreas.map((area) => (
                        <div 
                          key={area.id} 
                          className={cn(
                            "flex items-center gap-2 p-2 rounded-md border cursor-pointer transition-colors",
                            editFormData.permissions.includes(area.id) 
                              ? "bg-primary/10 border-primary" 
                              : "bg-background hover:bg-muted"
                          )}
                          onClick={() => toggleEditPermission(area.id)}
                        >
                          <Checkbox
                            id={`edit-perm-${area.id}`}
                            checked={editFormData.permissions.includes(area.id)}
                            onCheckedChange={() => toggleEditPermission(area.id)}
                            className="pointer-events-none"
                          />
                          <area.icon className="w-4 h-4 text-muted-foreground" />
                          <label
                            htmlFor={`edit-perm-${area.id}`}
                            className="text-sm font-medium leading-none cursor-pointer flex-1"
                          >
                            {area.label}
                          </label>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Action permissions */}
                  <div className="space-y-2 pt-2 border-t">
                    <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Ações Especiais</p>
                    <div className="grid grid-cols-1 xs:grid-cols-2 gap-2">
                      {agentActionPermissions.map((action) => (
                        <div 
                          key={action.id} 
                          className={cn(
                            "flex items-center gap-2 p-2 rounded-md border cursor-pointer transition-colors",
                            editFormData.permissions.includes(action.id) 
                              ? "bg-primary/10 border-primary" 
                              : "bg-background hover:bg-muted"
                          )}
                          onClick={() => toggleEditPermission(action.id)}
                        >
                          <Checkbox
                            id={`edit-perm-${action.id}`}
                            checked={editFormData.permissions.includes(action.id)}
                            onCheckedChange={() => toggleEditPermission(action.id)}
                            className="pointer-events-none"
                          />
                          <action.icon className="w-4 h-4 text-muted-foreground" />
                          <label
                            htmlFor={`edit-perm-${action.id}`}
                            className="text-sm font-medium leading-none cursor-pointer flex-1"
                          >
                            {action.label}
                          </label>
                        </div>
                      ))}
                    </div>
                  </div>

                  {!editFormData.permissions.includes('dashboard') && (
                    <p className="text-sm text-warning">
                      A permissão "Dashboard" é obrigatória
                    </p>
                  )}
                </div>
              )}

              {/* Password Section */}
              <div className="space-y-3 p-4 border rounded-lg bg-muted/30">
                <Label className="font-medium">Alterar Senha</Label>
                <p className="text-sm text-muted-foreground">
                  Deixe em branco para manter a senha atual
                </p>
                <div className="space-y-3 pt-2">
                  <div className="space-y-2">
                    <Label htmlFor="edit-password">Nova Senha</Label>
                    <div className="relative">
                      <Input
                        id="edit-password"
                        type={showEditPassword ? 'text' : 'password'}
                        value={editFormData.password}
                        onChange={(e) => setEditFormData({ ...editFormData, password: e.target.value })}
                        placeholder="Mínimo 6 caracteres"
                        className="pr-10"
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="absolute right-0 top-0 h-full px-3 hover:bg-transparent"
                        onClick={() => setShowEditPassword(!showEditPassword)}
                      >
                        {showEditPassword ? (
                          <EyeOff className="w-4 h-4 text-muted-foreground" />
                        ) : (
                          <Eye className="w-4 h-4 text-muted-foreground" />
                        )}
                      </Button>
                    </div>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="edit-confirmPassword">Confirmar Nova Senha</Label>
                    <Input
                      id="edit-confirmPassword"
                      type={showEditPassword ? 'text' : 'password'}
                      value={editFormData.confirmPassword}
                      onChange={(e) => setEditFormData({ ...editFormData, confirmPassword: e.target.value })}
                      placeholder="Digite a senha novamente"
                    />
                  </div>
                  {editFormData.password && editFormData.confirmPassword && editFormData.password !== editFormData.confirmPassword && (
                    <p className="text-sm text-destructive">As senhas não coincidem</p>
                  )}
                  {editFormData.password && editFormData.password.length < 6 && (
                    <p className="text-sm text-amber-600">A senha deve ter pelo menos 6 caracteres</p>
                  )}
                </div>
              </div>
            </div>
          )}
          <DialogFooter className="flex-shrink-0 flex-col sm:flex-row gap-3">
            <Button variant="outline" onClick={() => setEditingUser(null)}>
              Cancelar
            </Button>
            <Button onClick={handleUpdate} disabled={!isEditFormValid()}>
              Salvar Alterações
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog with Password */}
      <AlertDialog open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
        <AlertDialogContent className="max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2 text-destructive">
              <Shield className="w-5 h-5" />
              Confirmar Exclusão
            </AlertDialogTitle>
            <AlertDialogDescription>
              Você está prestes a excluir o usuário <strong>{userToDelete?.nome}</strong>. 
              Esta ação é irreversível e removerá todos os dados associados a este usuário.
            </AlertDialogDescription>
          </AlertDialogHeader>
          
          <div className="space-y-4 py-4">
            <div className="p-3 rounded-lg bg-destructive/10 border border-destructive/20">
              <p className="text-sm text-destructive font-medium">
                Para confirmar esta ação, digite sua senha de Super Admin:
              </p>
            </div>
            
            <div className="space-y-2">
              <Label htmlFor="delete-password">Senha</Label>
              <div className="relative">
                <Input
                  id="delete-password"
                  type={showDeletePassword ? 'text' : 'password'}
                  value={deletePassword}
                  onChange={(e) => setDeletePassword(e.target.value)}
                  placeholder="Digite sua senha"
                  className="pr-10"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="absolute right-0 top-0 h-full px-3 hover:bg-transparent"
                  onClick={() => setShowDeletePassword(!showDeletePassword)}
                >
                  {showDeletePassword ? (
                    <EyeOff className="h-4 w-4 text-muted-foreground" />
                  ) : (
                    <Eye className="h-4 w-4 text-muted-foreground" />
                  )}
                </Button>
              </div>
            </div>
          </div>
          
          <AlertDialogFooter className="flex-col sm:flex-row gap-2">
            <AlertDialogCancel 
              onClick={() => {
                setDeletePassword('');
                setUserToDelete(null);
              }}
              disabled={deleteLoading}
            >
              Cancelar
            </AlertDialogCancel>
            <Button
              variant="destructive"
              onClick={handleConfirmDelete}
              disabled={!deletePassword || deletePassword.length < 6 || deleteLoading}
            >
              {deleteLoading ? (
                <>
                  <span className="animate-spin mr-2">⏳</span>
                  Verificando...
                </>
              ) : (
                <>
                  <Trash2 className="w-4 h-4 mr-2" />
                  Confirmar Exclusão
                </>
              )}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
