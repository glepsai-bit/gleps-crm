/**
 * AgenteFormDialog (T-024)
 *
 * Modal de criar/editar agente, consumido por AdminAgentesPage.
 * - Cria: nome, email, senha (com confirmação) + permissions.
 * - Edita: nome, email, status, permissions (sem trocar senha aqui — fluxo dedicado).
 *
 * Validações:
 * - Zod schema sem `super_admin` no enum (admin nunca cria super).
 * - Senha mínimo 6 chars (somente no create).
 * - Agent precisa ter pelo menos 'dashboard' nas permissões (alinhado ao backend).
 *
 * Erros do backend são mapeados pra react-hook-form via setError(field, ...).
 */

import { useEffect, useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import {
  Eye,
  EyeOff,
  Loader2,
  LayoutDashboard,
  Kanban,
  Users,
  Calendar,
  DollarSign,
  Wallet,
  Package,
  Activity,
  RotateCcw,
  Crosshair,
  Mail,
} from 'lucide-react';
import {
  adminUsersBackendService,
  type AdminUser,
} from '@/services/admin-users.backend.service';

// ============================================
// Schemas
// ============================================

const baseFields = {
  nome: z.string().min(2, 'Nome deve ter pelo menos 2 caracteres'),
  email: z.string().email('E-mail inválido'),
  permissions: z.array(z.string()).default([]),
};

const createSchema = z
  .object({
    ...baseFields,
    password: z.string().min(6, 'Senha deve ter pelo menos 6 caracteres'),
    confirmPassword: z.string(),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: 'As senhas não coincidem',
    path: ['confirmPassword'],
  })
  .refine((data) => data.permissions.includes('dashboard'), {
    message: 'A permissão "Dashboard" é obrigatória',
    path: ['permissions'],
  });

const editSchema = z
  .object({
    ...baseFields,
    status: z.enum(['active', 'inactive', 'suspended']),
  })
  .refine((data) => data.permissions.includes('dashboard'), {
    message: 'A permissão "Dashboard" é obrigatória',
    path: ['permissions'],
  });

type CreateFormValues = z.infer<typeof createSchema>;
type EditFormValues = z.infer<typeof editSchema>;

// ============================================
// Permissões disponíveis (espelho de SuperAdminUsersPage)
// ============================================

const PERMISSION_AREAS = [
  { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { id: 'kanban', label: 'Kanban', icon: Kanban },
  { id: 'leads', label: 'Leads', icon: Users },
  { id: 'agenda', label: 'Agenda', icon: Calendar },
  { id: 'sales', label: 'Vendas', icon: DollarSign },
  { id: 'finance', label: 'Financeiro', icon: Wallet },
  { id: 'products', label: 'Produtos', icon: Package },
  { id: 'events', label: 'Eventos', icon: Activity },
  { id: 'extracao', label: 'Prospecção', icon: Crosshair },
  { id: 'emails', label: 'E-mails', icon: Mail },
];

const ACTION_PERMISSIONS = [
  { id: 'refunds', label: 'Realizar Estornos', icon: RotateCcw },
];

// Permissões de supervisão — agente vê TODAS as conversas da conta sem virar
// admin (recepção/supervisor). A visibilidade real é decidida no backend
// (conversation.service — guards de list/get/ensureConversationAccess).
const SUPERVISION_PERMISSIONS = [
  { id: 'conversations_all', label: 'Acesso total às conversas', icon: Eye },
];

// ============================================
// Props
// ============================================

interface AgenteFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agente?: AdminUser | null; // undefined/null = modo criar
  onSaved: (agente: AdminUser) => void;
}

// ============================================
// Helpers
// ============================================

function handleBackendError(
  error: any,
  setError: (field: any, error: { message: string }) => void,
  fallbackMessage: string
) {
  // Limit atingido — toast amigável (passo 7 do plano)
  const msg: string = error?.message ?? '';
  const code: string | undefined = error?.code;

  if (
    error?.status === 422 &&
    (code === 'AGENT_LIMIT_EXCEEDED' ||
      msg.toLowerCase().includes('limite') ||
      msg.toLowerCase().includes('agent_limit'))
  ) {
    toast.error(
      'Você atingiu o limite de agentes do seu plano. Desative ou remova um agente antes de adicionar outro.'
    );
    return;
  }

  // 409 EMAIL_IN_USE — mensagem genérica pra não vazar tenant alheio
  if (error?.status === 409 || code === 'EMAIL_IN_USE') {
    setError('email', { message: 'E-mail indisponível' });
    return;
  }

  // Erros de campo (Zod backend)
  const fieldErrors = error?.fieldErrors;
  if (Array.isArray(fieldErrors) && fieldErrors.length > 0) {
    fieldErrors.forEach((fe: any) => {
      setError(fe.field, { message: fe.message });
    });
    return;
  }

  toast.error(msg || fallbackMessage);
}

// ============================================
// Component
// ============================================

export function AgenteFormDialog({
  open,
  onOpenChange,
  agente,
  onSaved,
}: AgenteFormDialogProps) {
  const isEdit = Boolean(agente);
  const [showPassword, setShowPassword] = useState(false);

  // Dois forms separados (create vs edit) — schemas diferentes.
  const createForm = useForm<CreateFormValues>({
    resolver: zodResolver(createSchema),
    defaultValues: {
      nome: '',
      email: '',
      password: '',
      confirmPassword: '',
      permissions: ['dashboard'],
    },
  });

  const editForm = useForm<EditFormValues>({
    resolver: zodResolver(editSchema),
    defaultValues: {
      nome: '',
      email: '',
      status: 'active',
      permissions: ['dashboard'],
    },
  });

  // Reset ao abrir/trocar agente
  useEffect(() => {
    if (!open) return;
    if (isEdit && agente) {
      editForm.reset({
        nome: agente.nome,
        email: agente.email,
        status: agente.status,
        permissions:
          Array.isArray(agente.permissions) && agente.permissions.length > 0
            ? agente.permissions
            : ['dashboard'],
      });
    } else {
      createForm.reset({
        nome: '',
        email: '',
        password: '',
        confirmPassword: '',
        permissions: ['dashboard'],
      });
      setShowPassword(false);
    }
  }, [open, isEdit, agente]); // eslint-disable-line react-hooks/exhaustive-deps

  // Permissões atuais (depende do modo) — usado pelo CheckboxGrid
  const currentPermissions = isEdit
    ? editForm.watch('permissions')
    : createForm.watch('permissions');

  const togglePermission = (permissionId: string) => {
    const set = new Set(currentPermissions ?? []);
    if (set.has(permissionId)) set.delete(permissionId);
    else set.add(permissionId);
    const next = Array.from(set);
    if (isEdit) editForm.setValue('permissions', next, { shouldValidate: true });
    else createForm.setValue('permissions', next, { shouldValidate: true });
  };

  const isSubmitting = isEdit ? editForm.formState.isSubmitting : createForm.formState.isSubmitting;

  const onCreateSubmit = createForm.handleSubmit(async (values) => {
    try {
      const created = await adminUsersBackendService.create({
        nome: values.nome,
        email: values.email,
        password: values.password,
        role: 'agent',
        permissions: values.permissions,
      });
      toast.success('Agente criado com sucesso!');
      onSaved(created);
      onOpenChange(false);
    } catch (error: any) {
      handleBackendError(error, createForm.setError as any, 'Erro ao criar agente');
    }
  });

  const onEditSubmit = editForm.handleSubmit(async (values) => {
    if (!agente) return;
    try {
      const updated = await adminUsersBackendService.update(agente.id, {
        nome: values.nome,
        email: values.email,
        status: values.status,
        permissions: values.permissions,
      });
      toast.success('Agente atualizado com sucesso!');
      onSaved(updated);
      onOpenChange(false);
    } catch (error: any) {
      handleBackendError(error, editForm.setError as any, 'Erro ao atualizar agente');
    }
  });

  // Erros para exibir
  const errors = isEdit ? editForm.formState.errors : createForm.formState.errors;
  // Helper que isola o tipo correto do register conforme o modo. Sem isso o
  // TypeScript reclama de union de signatures incompativeis entre os dois forms.
  const registerField = (name: 'nome' | 'email') =>
    isEdit ? editForm.register(name) : createForm.register(name);

  const permissionsError = useMemo(() => {
    const err = errors?.permissions as any;
    return err?.message ?? null;
  }, [errors]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-hidden flex flex-col">
        <DialogHeader className="flex-shrink-0">
          <DialogTitle>{isEdit ? 'Editar Agente' : 'Novo Agente'}</DialogTitle>
          <DialogDescription>
            {isEdit
              ? 'Atualize os dados e permissões do agente.'
              : 'Adicione um novo agente à sua equipe.'}
          </DialogDescription>
        </DialogHeader>

        <form
          onSubmit={isEdit ? onEditSubmit : onCreateSubmit}
          className="space-y-4 py-4 overflow-y-auto flex-1 px-1"
        >
          {/* Nome */}
          <div className="space-y-2">
            <Label htmlFor="agente-nome">
              Nome <span className="text-destructive">*</span>
            </Label>
            <Input
              id="agente-nome"
              placeholder="Nome completo"
              {...registerField('nome')}
            />
            {errors.nome && (
              <p className="text-sm text-destructive">{errors.nome.message as string}</p>
            )}
          </div>

          {/* Email */}
          <div className="space-y-2">
            <Label htmlFor="agente-email">
              E-mail <span className="text-destructive">*</span>
            </Label>
            <Input
              id="agente-email"
              type="email"
              placeholder="email@exemplo.com"
              {...registerField('email')}
            />
            {errors.email && (
              <p className="text-sm text-destructive">{errors.email.message as string}</p>
            )}
          </div>

          {/* Status (apenas no edit) */}
          {isEdit && (
            <div className="space-y-2">
              <Label htmlFor="agente-status">
                Status <span className="text-destructive">*</span>
              </Label>
              <Select
                value={editForm.watch('status')}
                onValueChange={(v) =>
                  editForm.setValue('status', v as EditFormValues['status'], {
                    shouldValidate: true,
                  })
                }
              >
                <SelectTrigger id="agente-status">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="active">Ativo</SelectItem>
                  <SelectItem value="inactive">Inativo</SelectItem>
                  <SelectItem value="suspended">Suspenso</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}

          {/* Senha (apenas no create) */}
          {!isEdit && (
            <div className="space-y-3 p-4 border rounded-lg bg-muted/30">
              <Label className="font-medium">
                Definir Senha <span className="text-destructive">*</span>
              </Label>
              <p className="text-sm text-muted-foreground">
                O agente poderá alterar depois pelo perfil.
              </p>

              <div className="space-y-2">
                <Label htmlFor="agente-password">Senha</Label>
                <div className="relative">
                  <Input
                    id="agente-password"
                    type={showPassword ? 'text' : 'password'}
                    placeholder="Mínimo 6 caracteres"
                    className="pr-10"
                    {...createForm.register('password')}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="absolute right-0 top-0 h-full px-3 hover:bg-transparent"
                    onClick={() => setShowPassword(!showPassword)}
                    aria-label={showPassword ? 'Ocultar senha' : 'Mostrar senha'}
                  >
                    {showPassword ? (
                      <EyeOff className="w-4 h-4 text-muted-foreground" />
                    ) : (
                      <Eye className="w-4 h-4 text-muted-foreground" />
                    )}
                  </Button>
                </div>
                {createForm.formState.errors.password && (
                  <p className="text-sm text-destructive">
                    {createForm.formState.errors.password.message}
                  </p>
                )}
              </div>

              <div className="space-y-2">
                <Label htmlFor="agente-confirmPassword">Confirmar Senha</Label>
                <Input
                  id="agente-confirmPassword"
                  type={showPassword ? 'text' : 'password'}
                  placeholder="Digite a senha novamente"
                  {...createForm.register('confirmPassword')}
                />
                {createForm.formState.errors.confirmPassword && (
                  <p className="text-sm text-destructive">
                    {createForm.formState.errors.confirmPassword.message}
                  </p>
                )}
              </div>
            </div>
          )}

          {/* Permissões */}
          <div className="space-y-4 p-4 border rounded-lg bg-muted/30">
            <div>
              <Label className="font-medium">
                Permissões de Acesso <span className="text-destructive">*</span>
              </Label>
              <p className="text-sm text-muted-foreground mt-1">
                Selecione as páginas e ações que este agente poderá acessar.
              </p>
            </div>

            <div className="space-y-2">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                Páginas
              </p>
              {/* BUG-T024-01: removido onClick do wrapper + pointer-events-none
                  do Checkbox. Triplo handler (wrapper + checkbox + label htmlFor)
                  causava 'Maximum update depth exceeded' — cada toggle disparava
                  setValue 2x via bubbling, e watch re-renderizava em loop.
                  Agora SO o Checkbox+label respondem (Radix nativo). */}
              <div className="grid grid-cols-1 xs:grid-cols-2 gap-2">
                {PERMISSION_AREAS.map((area) => {
                  const checked = (currentPermissions ?? []).includes(area.id);
                  return (
                    <label
                      key={area.id}
                      htmlFor={`perm-${area.id}`}
                      className={cn(
                        'flex items-center gap-2 p-2 rounded-md border cursor-pointer transition-colors',
                        checked
                          ? 'bg-primary/10 border-primary'
                          : 'bg-background hover:bg-muted'
                      )}
                    >
                      <Checkbox
                        id={`perm-${area.id}`}
                        checked={checked}
                        onCheckedChange={() => togglePermission(area.id)}
                      />
                      <area.icon className="w-4 h-4 text-muted-foreground" />
                      <span className="text-sm font-medium leading-none flex-1">
                        {area.label}
                      </span>
                    </label>
                  );
                })}
              </div>
            </div>

            <div className="space-y-2 pt-2 border-t">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                Ações Especiais
              </p>
              {/* BUG-T024-01: mesmo fix do grid de Paginas — so label+Checkbox. */}
              <div className="grid grid-cols-1 xs:grid-cols-2 gap-2">
                {ACTION_PERMISSIONS.map((action) => {
                  const checked = (currentPermissions ?? []).includes(action.id);
                  return (
                    <label
                      key={action.id}
                      htmlFor={`perm-${action.id}`}
                      className={cn(
                        'flex items-center gap-2 p-2 rounded-md border cursor-pointer transition-colors',
                        checked
                          ? 'bg-primary/10 border-primary'
                          : 'bg-background hover:bg-muted'
                      )}
                    >
                      <Checkbox
                        id={`perm-${action.id}`}
                        checked={checked}
                        onCheckedChange={() => togglePermission(action.id)}
                      />
                      <action.icon className="w-4 h-4 text-muted-foreground" />
                      <span className="text-sm font-medium leading-none flex-1">
                        {action.label}
                      </span>
                    </label>
                  );
                })}
              </div>
            </div>

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

            {permissionsError && (
              <p className="text-sm text-destructive">{permissionsError}</p>
            )}
          </div>

          <DialogFooter className="flex-shrink-0 flex-col sm:flex-row gap-3 pt-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={isSubmitting}
            >
              Cancelar
            </Button>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  {isEdit ? 'Salvando...' : 'Criando...'}
                </>
              ) : isEdit ? (
                'Salvar Alterações'
              ) : (
                'Criar Agente'
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export default AgenteFormDialog;
