import { useState, useEffect } from 'react';
import { ChatwootAgent, UserRole, User } from '@/types/crm';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Progress } from '@/components/ui/progress';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { 
  User as UserIcon, 
  Shield, 
  Lock,
  LayoutDashboard,
  Kanban,
  Users,
  Calendar,
  ShoppingCart,
  DollarSign,
  Package,
  CalendarDays,
  Lightbulb,
  RotateCcw,
} from 'lucide-react';

// Permissões disponíveis para agentes
const PAGE_PERMISSIONS = [
  { key: 'dashboard', label: 'Dashboard', icon: LayoutDashboard, required: true },
  { key: 'kanban', label: 'Kanban', icon: Kanban },
  { key: 'leads', label: 'Leads', icon: Users },
  { key: 'agenda', label: 'Agenda', icon: Calendar },
  { key: 'sales', label: 'Vendas', icon: ShoppingCart },
  { key: 'finance', label: 'Financeiro', icon: DollarSign },
  { key: 'products', label: 'Produtos', icon: Package },
  { key: 'events', label: 'Eventos', icon: CalendarDays },
  { key: 'insights', label: 'Insights', icon: Lightbulb },
];

const ACTION_PERMISSIONS = [
  { key: 'refunds', label: 'Realizar Estornos', icon: RotateCcw },
];

interface CreateUserFromChatwootDialogProps {
  open: boolean;
  agent: ChatwootAgent;
  currentIndex: number;
  totalAgents: number;
  accountId: string;
  onUserCreated: (user: User) => void;
  onSkip: () => void;
  onClose: () => void;
}

let userIdCounter = 200;

export function CreateUserFromChatwootDialog({
  open,
  agent,
  currentIndex,
  totalAgents,
  accountId,
  onUserCreated,
  onSkip,
  onClose,
}: CreateUserFromChatwootDialogProps) {
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [role, setRole] = useState<UserRole>(agent.role === 'administrator' ? 'admin' : 'agent');
  const [permissions, setPermissions] = useState<string[]>(['dashboard']); // Dashboard é obrigatório

  // Reset form when agent changes
  useEffect(() => {
    setPassword('');
    setConfirmPassword('');
    setRole(agent.role === 'administrator' ? 'admin' : 'agent');
    setPermissions(['dashboard']);
  }, [agent.id]);

  const progress = ((currentIndex + 1) / totalAgents) * 100;

  const togglePermission = (key: string) => {
    if (key === 'dashboard') return; // Dashboard é obrigatório
    
    if (permissions.includes(key)) {
      setPermissions(permissions.filter(p => p !== key));
    } else {
      setPermissions([...permissions, key]);
    }
  };

  const handleCreate = () => {
    if (password !== confirmPassword) {
      return; // Validação de senha
    }

    userIdCounter++;
    const newUser: User = {
      id: `user-imported-${userIdCounter}`,
      account_id: accountId,
      nome: agent.name,
      email: agent.email,
      role: role,
      status: 'active',
      permissions: role === 'agent' ? permissions : undefined,
      chatwoot_agent_id: agent.id,
      last_login_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    onUserCreated(newUser);
  };

  const isValid = password.length >= 6 && password === confirmPassword;

  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && onClose()}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-hidden flex flex-col">
        <DialogHeader className="flex-shrink-0">
          <div className="flex items-center justify-between">
            <DialogTitle className="flex items-center gap-2">
              <UserIcon className="w-5 h-5" />
              Criar Usuário
            </DialogTitle>
            <Badge variant="outline">
              {currentIndex + 1} de {totalAgents}
            </Badge>
          </div>
          <DialogDescription>
            Configure o usuário importado do Chatwoot
          </DialogDescription>
        </DialogHeader>

        {/* Progress */}
        <Progress value={progress} className="h-2 flex-shrink-0" />

        <div className="space-y-4 py-2 overflow-y-auto flex-1 px-1 py-1 [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]">
          {/* Dados do Chatwoot (readonly) */}
          <div className="p-3 rounded-lg bg-muted/50 space-y-2">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Badge variant="secondary" className="text-xs">
                Dados do Chatwoot
              </Badge>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <Label className="text-xs text-muted-foreground">Nome</Label>
                <p className="font-medium">{agent.name}</p>
              </div>
              <div>
                <Label className="text-xs text-muted-foreground">Email</Label>
                <p className="font-medium text-sm">{agent.email}</p>
              </div>
            </div>
            <div>
              <Label className="text-xs text-muted-foreground">ID Chatwoot</Label>
              <code className="text-xs bg-background px-2 py-0.5 rounded">
                #{agent.id}
              </code>
            </div>
          </div>

          {/* Senha */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="password" className="flex items-center gap-1">
                <Lock className="w-3 h-3" />
                Senha
              </Label>
              <Input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Mínimo 6 caracteres"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="confirm-password">Confirmar Senha</Label>
              <Input
                id="confirm-password"
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="Repita a senha"
              />
            </div>
          </div>
          {password && confirmPassword && password !== confirmPassword && (
            <p className="text-xs text-destructive">As senhas não coincidem</p>
          )}

          {/* Role */}
          <div className="space-y-2">
            <Label className="flex items-center gap-1">
              <Shield className="w-3 h-3" />
              Tipo de Usuário
            </Label>
            <Select value={role} onValueChange={(v) => setRole(v as UserRole)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="admin">Administrador</SelectItem>
                <SelectItem value="agent">Agente</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Permissões (apenas para agentes) */}
          {role === 'agent' && (
            <div className="space-y-3">
              <Label>Permissões do Agente</Label>
              
              {/* Páginas */}
              <div className="space-y-2">
                <span className="text-xs text-muted-foreground uppercase tracking-wider">
                  Páginas
                </span>
                <div className="grid grid-cols-1 xs:grid-cols-2 gap-2">
                  {PAGE_PERMISSIONS.map((perm) => {
                    const Icon = perm.icon;
                    const isChecked = permissions.includes(perm.key);
                    return (
                      <div
                        key={perm.key}
                        className={`flex items-center gap-2 p-2 rounded-md border cursor-pointer transition-colors ${
                          isChecked ? 'bg-primary/10 border-primary/30' : 'hover:bg-muted/50'
                        } ${perm.required ? 'opacity-75' : ''}`}
                        onClick={() => togglePermission(perm.key)}
                      >
                        <Checkbox 
                          checked={isChecked} 
                          disabled={perm.required}
                          onCheckedChange={() => togglePermission(perm.key)}
                        />
                        <Icon className="w-4 h-4 text-muted-foreground" />
                        <span className="text-sm">{perm.label}</span>
                        {perm.required && (
                          <Badge variant="secondary" className="text-[10px] ml-auto">
                            Obrigatório
                          </Badge>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Ações */}
              <div className="space-y-2">
                <span className="text-xs text-muted-foreground uppercase tracking-wider">
                  Ações Especiais
                </span>
                <div className="grid grid-cols-1 xs:grid-cols-2 gap-2">
                  {ACTION_PERMISSIONS.map((perm) => {
                    const Icon = perm.icon;
                    const isChecked = permissions.includes(perm.key);
                    return (
                      <div
                        key={perm.key}
                        className={`flex items-center gap-2 p-2 rounded-md border cursor-pointer transition-colors ${
                          isChecked ? 'bg-primary/10 border-primary/30' : 'hover:bg-muted/50'
                        }`}
                        onClick={() => togglePermission(perm.key)}
                      >
                        <Checkbox 
                          checked={isChecked} 
                          onCheckedChange={() => togglePermission(perm.key)}
                        />
                        <Icon className="w-4 h-4 text-muted-foreground" />
                        <span className="text-sm">{perm.label}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          )}
        </div>

        <DialogFooter className="flex-shrink-0 flex-col sm:flex-row gap-3">
          <Button variant="ghost" onClick={onSkip}>
            Pular este agente
          </Button>
          <Button onClick={handleCreate} disabled={!isValid}>
            {currentIndex + 1 === totalAgents ? 'Criar e Finalizar' : 'Criar e Próximo'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * User data with password for creation
 */
export interface UserCreationData {
  user: User;
  password: string;
}

/**
 * Embedded version for use inside another DialogContent
 * This renders just the content without a wrapping Dialog
 */
interface EmbeddedUserCreationFormProps {
  agent: ChatwootAgent;
  currentIndex: number;
  totalAgents: number;
  accountId: string;
  onUserCreated: (data: UserCreationData) => void;
  onSkip: () => void;
}

export function EmbeddedUserCreationForm({
  agent,
  currentIndex,
  totalAgents,
  accountId,
  onUserCreated,
  onSkip,
}: EmbeddedUserCreationFormProps) {
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [role, setRole] = useState<UserRole>(agent.role === 'administrator' ? 'admin' : 'agent');
  const [permissions, setPermissions] = useState<string[]>(['dashboard']);

  // Reset form when agent changes
  useEffect(() => {
    setPassword('');
    setConfirmPassword('');
    setRole(agent.role === 'administrator' ? 'admin' : 'agent');
    setPermissions(['dashboard']);
  }, [agent.id]);

  const progress = ((currentIndex + 1) / totalAgents) * 100;

  const togglePermission = (key: string) => {
    if (key === 'dashboard') return;
    
    if (permissions.includes(key)) {
      setPermissions(permissions.filter(p => p !== key));
    } else {
      setPermissions([...permissions, key]);
    }
  };

  const handleCreate = () => {
    if (password !== confirmPassword) return;

    const newUser: User = {
      id: `user-imported-${Date.now()}`,
      account_id: accountId,
      nome: agent.name,
      email: agent.email,
      role: role,
      status: 'active',
      permissions: role === 'agent' ? permissions : undefined,
      chatwoot_agent_id: agent.id,
      last_login_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    onUserCreated({ user: newUser, password });
  };

  const isValid = password.length >= 6 && password === confirmPassword;

  return (
    <>
      <DialogHeader className="flex-shrink-0">
        <div className="flex items-center justify-between">
          <DialogTitle className="flex items-center gap-2">
            <UserIcon className="w-5 h-5" />
            Criar Usuário
          </DialogTitle>
          <Badge variant="outline">
            {currentIndex + 1} de {totalAgents}
          </Badge>
        </div>
        <DialogDescription>
          Configure o usuário importado do Chatwoot
        </DialogDescription>
      </DialogHeader>

      {/* Progress */}
      <Progress value={progress} className="h-2 flex-shrink-0" />

      <div className="space-y-4 py-2 overflow-y-auto flex-1 px-1 py-1 [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]">
        {/* Dados do Chatwoot (readonly) */}
        <div className="p-3 rounded-lg bg-muted/50 space-y-2">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Badge variant="secondary" className="text-xs">
              Dados do Chatwoot
            </Badge>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <Label className="text-xs text-muted-foreground">Nome</Label>
              <p className="font-medium">{agent.name}</p>
            </div>
            <div>
              <Label className="text-xs text-muted-foreground">Email</Label>
              <p className="font-medium text-sm">{agent.email}</p>
            </div>
          </div>
          <div>
            <Label className="text-xs text-muted-foreground">ID Chatwoot</Label>
            <code className="text-xs bg-background px-2 py-0.5 rounded">
              #{agent.id}
            </code>
          </div>
        </div>

        {/* Senha */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label htmlFor="embed-password" className="flex items-center gap-1">
              <Lock className="w-3 h-3" />
              Senha
            </Label>
            <Input
              id="embed-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Mínimo 6 caracteres"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="embed-confirm-password">Confirmar Senha</Label>
            <Input
              id="embed-confirm-password"
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder="Repita a senha"
            />
          </div>
        </div>
        {password && confirmPassword && password !== confirmPassword && (
          <p className="text-xs text-destructive">As senhas não coincidem</p>
        )}

        {/* Role */}
        <div className="space-y-2">
          <Label className="flex items-center gap-1">
            <Shield className="w-3 h-3" />
            Tipo de Usuário
          </Label>
          <Select value={role} onValueChange={(v) => setRole(v as UserRole)}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="admin">Administrador</SelectItem>
              <SelectItem value="agent">Agente</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Permissões (apenas para agentes) */}
        {role === 'agent' && (
          <div className="space-y-3">
            <Label>Permissões do Agente</Label>
            
            {/* Páginas */}
            <div className="space-y-2">
              <span className="text-xs text-muted-foreground uppercase tracking-wider">
                Páginas
              </span>
              <div className="grid grid-cols-1 xs:grid-cols-2 gap-2">
                {PAGE_PERMISSIONS.map((perm) => {
                  const Icon = perm.icon;
                  const isChecked = permissions.includes(perm.key);
                  return (
                    <div
                      key={perm.key}
                      className={`flex items-center gap-2 p-2 rounded-md border cursor-pointer transition-colors ${
                        isChecked ? 'bg-primary/10 border-primary/30' : 'hover:bg-muted/50'
                      } ${perm.required ? 'opacity-75' : ''}`}
                      onClick={() => togglePermission(perm.key)}
                    >
                      <Checkbox 
                        checked={isChecked} 
                        disabled={perm.required}
                        onCheckedChange={() => togglePermission(perm.key)}
                      />
                      <Icon className="w-4 h-4 text-muted-foreground" />
                      <span className="text-sm">{perm.label}</span>
                      {perm.required && (
                        <Badge variant="secondary" className="text-[10px] ml-auto">
                          Obrigatório
                        </Badge>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Ações */}
            <div className="space-y-2">
              <span className="text-xs text-muted-foreground uppercase tracking-wider">
                Ações Especiais
              </span>
              <div className="grid grid-cols-1 xs:grid-cols-2 gap-2">
                {ACTION_PERMISSIONS.map((perm) => {
                  const Icon = perm.icon;
                  const isChecked = permissions.includes(perm.key);
                  return (
                    <div
                      key={perm.key}
                      className={`flex items-center gap-2 p-2 rounded-md border cursor-pointer transition-colors ${
                        isChecked ? 'bg-primary/10 border-primary/30' : 'hover:bg-muted/50'
                      }`}
                      onClick={() => togglePermission(perm.key)}
                    >
                      <Checkbox 
                        checked={isChecked} 
                        onCheckedChange={() => togglePermission(perm.key)}
                      />
                      <Icon className="w-4 h-4 text-muted-foreground" />
                      <span className="text-sm">{perm.label}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}
      </div>

      <DialogFooter className="flex-shrink-0 flex-col sm:flex-row gap-2">
        <Button variant="ghost" onClick={onSkip}>
          Pular este agente
        </Button>
        <Button onClick={handleCreate} disabled={!isValid}>
          {currentIndex + 1 === totalAgents ? 'Criar e Finalizar' : 'Criar e Próximo'}
        </Button>
      </DialogFooter>
    </>
  );
}
