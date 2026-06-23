import { useMemo, useState, KeyboardEvent } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import {
  customAttributesBackendService,
  type CustomAttribute,
  type CustomAttributeScope,
  type CustomAttributeType,
} from '@/services/custom-attributes.backend.service';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from '@/components/ui/dialog';
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { useToast } from '@/hooks/use-toast';
import { Plus, Pencil, Trash2, Tags, X, AlertTriangle } from 'lucide-react';

// ============================================================================
// Constantes / configuração
// ============================================================================

const SCOPES: { value: CustomAttributeScope; label: string; description: string }[] = [
  {
    value: 'conversation',
    label: 'Conversa',
    description: 'Campos aplicados a cada conversa (ex.: motivo do contato, canal de origem).',
  },
  {
    value: 'contact',
    label: 'Contato',
    description: 'Campos aplicados a contatos (ex.: CPF, plano, segmento).',
  },
  {
    value: 'account',
    label: 'Conta',
    description: 'Campos aplicados à conta (configurações globais do tenant).',
  },
];

const TYPES: { value: CustomAttributeType; label: string }[] = [
  { value: 'text', label: 'Texto' },
  { value: 'number', label: 'Número' },
  { value: 'date', label: 'Data' },
  { value: 'list', label: 'Lista (seleção)' },
  { value: 'boolean', label: 'Booleano (Sim/Não)' },
];

const TYPE_BADGE_VARIANT: Record<CustomAttributeType, string> = {
  text: 'bg-blue-100 text-blue-800 dark:bg-blue-950/40 dark:text-blue-300',
  number: 'bg-purple-100 text-purple-800 dark:bg-purple-950/40 dark:text-purple-300',
  date: 'bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300',
  list: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300',
  boolean: 'bg-slate-200 text-slate-800 dark:bg-slate-800 dark:text-slate-200',
};

const KEY_REGEX = /^[a-z][a-z0-9_]{0,79}$/;

// ============================================================================
// Schema (zod) — validação do formulário
// ============================================================================

const schema = z
  .object({
    scope: z.enum(['conversation', 'contact', 'account']),
    key: z
      .string()
      .min(1, 'Chave obrigatória')
      .regex(KEY_REGEX, 'Use apenas letras minúsculas, números e _, começando por letra (snake_case)'),
    label: z.string().min(2, 'Rótulo deve ter pelo menos 2 caracteres'),
    type: z.enum(['text', 'number', 'date', 'list', 'boolean']),
    required: z.boolean(),
    options: z.array(z.string().min(1)).optional(),
  })
  .superRefine((data, ctx) => {
    if (data.type === 'list') {
      if (!data.options || data.options.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Adicione pelo menos uma opção para o tipo "Lista"',
          path: ['options'],
        });
      }
    }
  });

type FormData = z.infer<typeof schema>;

// ============================================================================
// Helpers
// ============================================================================

function typeLabel(t: CustomAttributeType) {
  return TYPES.find(x => x.value === t)?.label ?? t;
}

function scopeLabel(s: CustomAttributeScope) {
  return SCOPES.find(x => x.value === s)?.label ?? s;
}

// ============================================================================
// Componente principal
// ============================================================================

export default function AdminCustomAttributesPage() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [activeScope, setActiveScope] = useState<CustomAttributeScope>('conversation');
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<CustomAttribute | null>(null);
  const [deleting, setDeleting] = useState<CustomAttribute | null>(null);
  const [optionDraft, setOptionDraft] = useState('');

  // Query única (sem filtro de scope) para evitar re-fetch ao trocar de aba.
  const { data: allAttributes = [], isLoading } = useQuery({
    queryKey: ['custom-attributes'],
    queryFn: () => customAttributesBackendService.listCustomAttributes(),
  });

  // Agrupa por scope para a UI
  const grouped = useMemo(() => {
    const acc: Record<CustomAttributeScope, CustomAttribute[]> = {
      conversation: [],
      contact: [],
      account: [],
    };
    for (const a of allAttributes) {
      if (acc[a.scope]) acc[a.scope].push(a);
    }
    return acc;
  }, [allAttributes]);

  // Formulário
  const {
    register,
    handleSubmit,
    reset,
    setValue,
    watch,
    formState: { errors },
  } = useForm<FormData>({
    resolver: zodResolver(schema),
    defaultValues: {
      scope: 'conversation',
      key: '',
      label: '',
      type: 'text',
      required: false,
      options: [],
    },
  });

  const watchedType = watch('type');
  const watchedRequired = watch('required');
  const watchedScope = watch('scope');
  const watchedOptions = watch('options') ?? [];

  // Mutations
  const mutateCreate = useMutation({
    mutationFn: customAttributesBackendService.create,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['custom-attributes'] });
      toast({ title: 'Campo customizado criado!' });
      fecharDialog();
    },
    onError: (err: Error) => {
      toast({
        title: 'Erro ao criar campo',
        description: err.message,
        variant: 'destructive',
      });
    },
  });

  const mutateUpdate = useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: Partial<FormData> }) =>
      customAttributesBackendService.update(id, {
        label: payload.label,
        type: payload.type,
        required: payload.required,
        options: payload.type === 'list' ? payload.options ?? [] : null,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['custom-attributes'] });
      toast({ title: 'Campo atualizado!' });
      fecharDialog();
    },
    onError: (err: Error) => {
      toast({
        title: 'Erro ao atualizar',
        description: err.message,
        variant: 'destructive',
      });
    },
  });

  const mutateDelete = useMutation({
    mutationFn: (id: string) => customAttributesBackendService.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['custom-attributes'] });
      toast({ title: 'Campo excluído.' });
      setDeleting(null);
    },
    onError: (err: Error) => {
      toast({
        title: 'Erro ao excluir',
        description: err.message,
        variant: 'destructive',
      });
    },
  });

  // Handlers de dialog
  const abrirCriar = () => {
    setEditing(null);
    setOptionDraft('');
    reset({
      scope: activeScope,
      key: '',
      label: '',
      type: 'text',
      required: false,
      options: [],
    });
    setDialogOpen(true);
  };

  const abrirEditar = (attr: CustomAttribute) => {
    setEditing(attr);
    setOptionDraft('');
    reset({
      scope: attr.scope,
      key: attr.key,
      label: attr.label,
      type: attr.type,
      required: attr.required,
      options: attr.options ?? [],
    });
    setDialogOpen(true);
  };

  const fecharDialog = () => {
    setDialogOpen(false);
    setEditing(null);
    setOptionDraft('');
  };

  // Tags input (opções para type=list)
  const addOption = () => {
    const val = optionDraft.trim();
    if (!val) return;
    if (watchedOptions.includes(val)) {
      setOptionDraft('');
      return;
    }
    setValue('options', [...watchedOptions, val], { shouldValidate: true });
    setOptionDraft('');
  };

  const removeOption = (val: string) => {
    setValue(
      'options',
      watchedOptions.filter(o => o !== val),
      { shouldValidate: true }
    );
  };

  const onOptionKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      addOption();
    } else if (e.key === 'Backspace' && optionDraft === '' && watchedOptions.length > 0) {
      e.preventDefault();
      removeOption(watchedOptions[watchedOptions.length - 1]);
    }
  };

  const onSubmit = (data: FormData) => {
    if (editing) {
      mutateUpdate.mutate({ id: editing.id, payload: data });
    } else {
      mutateCreate.mutate({
        scope: data.scope,
        key: data.key,
        label: data.label,
        type: data.type,
        required: data.required,
        options: data.type === 'list' ? data.options ?? [] : null,
      });
    }
  };

  const isSaving = mutateCreate.isPending || mutateUpdate.isPending;

  // Renderiza a tabela para um scope específico
  const renderTabela = (scope: CustomAttributeScope) => {
    const items = grouped[scope];

    if (isLoading) {
      return (
        <div className="space-y-3">
          {[1, 2, 3].map(i => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      );
    }

    if (items.length === 0) {
      return (
        <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
          <Tags className="w-12 h-12 mb-4 opacity-30" />
          <p className="text-sm font-medium">Nenhum campo customizado para {scopeLabel(scope).toLowerCase()}</p>
          <p className="text-xs mt-1">Clique em "Novo campo" para criar o primeiro</p>
        </div>
      );
    }

    return (
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-[28%]">Chave</TableHead>
            <TableHead>Rótulo</TableHead>
            <TableHead>Tipo</TableHead>
            <TableHead className="hidden md:table-cell">Obrigatório</TableHead>
            <TableHead className="text-right">Ações</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map(attr => (
            <TableRow key={attr.id}>
              <TableCell>
                <code className="font-mono text-xs bg-muted px-2 py-1 rounded">
                  {attr.key}
                </code>
              </TableCell>
              <TableCell className="font-medium">{attr.label}</TableCell>
              <TableCell>
                <Badge variant="secondary" className={TYPE_BADGE_VARIANT[attr.type]}>
                  {typeLabel(attr.type)}
                </Badge>
                {attr.type === 'list' && attr.options && attr.options.length > 0 && (
                  <span className="ml-2 text-xs text-muted-foreground">
                    {attr.options.length} opção(ões)
                  </span>
                )}
              </TableCell>
              <TableCell className="hidden md:table-cell">
                {attr.required ? (
                  <Badge variant="outline" className="border-destructive/40 text-destructive">
                    Sim
                  </Badge>
                ) : (
                  <span className="text-xs text-muted-foreground">Não</span>
                )}
              </TableCell>
              <TableCell className="text-right">
                <div className="flex items-center justify-end gap-1">
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => abrirEditar(attr)}
                    title="Editar"
                    aria-label={`Editar campo ${attr.label}`}
                  >
                    <Pencil className="w-4 h-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => setDeleting(attr)}
                    className="text-destructive hover:text-destructive"
                    title="Excluir"
                    aria-label={`Excluir campo ${attr.label}`}
                  >
                    <Trash2 className="w-4 h-4" />
                  </Button>
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    );
  };

  return (
    <div className="p-4 sm:p-6 lg:p-8 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Campos Customizados</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Defina campos extras para conversas, contatos e conta do chat interno
          </p>
        </div>
        <Button onClick={abrirCriar}>
          <Plus className="w-4 h-4 mr-2" />
          Novo campo
        </Button>
      </div>

      {/* Tabs por scope */}
      <Tabs
        value={activeScope}
        onValueChange={v => setActiveScope(v as CustomAttributeScope)}
        className="w-full"
      >
        <TabsList className="grid w-full grid-cols-3 sm:w-auto sm:inline-flex">
          {SCOPES.map(s => (
            <TabsTrigger key={s.value} value={s.value} className="gap-2">
              <span>{s.label}</span>
              <Badge variant="secondary" className="ml-1 h-5 px-1.5 text-[10px]">
                {grouped[s.value].length}
              </Badge>
            </TabsTrigger>
          ))}
        </TabsList>

        {SCOPES.map(s => (
          <TabsContent key={s.value} value={s.value} className="mt-4">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">
                  Campos de {s.label.toLowerCase()} ({grouped[s.value].length})
                </CardTitle>
                <p className="text-xs text-muted-foreground">{s.description}</p>
              </CardHeader>
              <CardContent>{renderTabela(s.value)}</CardContent>
            </Card>
          </TabsContent>
        ))}
      </Tabs>

      {/* Dialog criar/editar */}
      <Dialog
        open={dialogOpen}
        onOpenChange={open => {
          if (!open) fecharDialog();
        }}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {editing ? 'Editar campo customizado' : 'Novo campo customizado'}
            </DialogTitle>
            <DialogDescription>
              {editing
                ? 'Escopo e chave não podem ser alterados após a criação.'
                : 'Defina como o campo será identificado tecnicamente e exibido aos agentes.'}
            </DialogDescription>
          </DialogHeader>

          <form onSubmit={handleSubmit(onSubmit)} className="space-y-4 py-2">
            {/* Scope */}
            <div className="space-y-1">
              <Label>Escopo</Label>
              <Select
                value={watchedScope}
                onValueChange={val =>
                  setValue('scope', val as CustomAttributeScope, { shouldValidate: true })
                }
                disabled={!!editing}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Selecione o escopo" />
                </SelectTrigger>
                <SelectContent>
                  {SCOPES.map(s => (
                    <SelectItem key={s.value} value={s.value}>
                      {s.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {errors.scope && (
                <p className="text-xs text-destructive">{errors.scope.message}</p>
              )}
            </div>

            {/* Key */}
            <div className="space-y-1">
              <Label>
                Chave técnica <span className="text-muted-foreground">(snake_case)</span>
              </Label>
              <Input
                {...register('key')}
                placeholder="ex.: motivo_contato"
                disabled={!!editing}
                className="font-mono"
              />
              {errors.key ? (
                <p className="text-xs text-destructive">{errors.key.message}</p>
              ) : (
                <p className="text-xs text-muted-foreground">
                  Letras minúsculas, números e _, começando por letra. Não pode ser
                  alterada depois.
                </p>
              )}
            </div>

            {/* Label */}
            <div className="space-y-1">
              <Label>Rótulo exibido</Label>
              <Input {...register('label')} placeholder="ex.: Motivo do contato" />
              {errors.label && (
                <p className="text-xs text-destructive">{errors.label.message}</p>
              )}
            </div>

            {/* Type */}
            <div className="space-y-1">
              <Label>Tipo</Label>
              <Select
                value={watchedType}
                onValueChange={val => {
                  setValue('type', val as CustomAttributeType, { shouldValidate: true });
                  if (val !== 'list') {
                    setValue('options', [], { shouldValidate: true });
                  }
                }}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Selecione o tipo" />
                </SelectTrigger>
                <SelectContent>
                  {TYPES.map(t => (
                    <SelectItem key={t.value} value={t.value}>
                      {t.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {errors.type && (
                <p className="text-xs text-destructive">{errors.type.message}</p>
              )}
            </div>

            {/* Options (tags) — só para type=list */}
            {watchedType === 'list' && (
              <div className="space-y-1">
                <Label>Opções disponíveis</Label>
                <div className="rounded-md border bg-background p-2 flex flex-wrap gap-1.5 min-h-[42px] focus-within:ring-2 focus-within:ring-ring">
                  {watchedOptions.map(opt => (
                    <Badge
                      key={opt}
                      variant="secondary"
                      className="gap-1 pr-1 text-xs"
                    >
                      {opt}
                      <button
                        type="button"
                        onClick={() => removeOption(opt)}
                        className="ml-0.5 rounded-sm hover:bg-muted-foreground/20 p-0.5"
                        aria-label={`Remover opção ${opt}`}
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </Badge>
                  ))}
                  <input
                    type="text"
                    value={optionDraft}
                    onChange={e => setOptionDraft(e.target.value)}
                    onKeyDown={onOptionKeyDown}
                    onBlur={addOption}
                    placeholder={watchedOptions.length === 0 ? 'Digite e pressione Enter…' : ''}
                    className="flex-1 min-w-[120px] bg-transparent outline-none text-sm px-1"
                  />
                </div>
                {errors.options && (
                  <p className="text-xs text-destructive">
                    {(errors.options as { message?: string })?.message ??
                      'Opções inválidas'}
                  </p>
                )}
                <p className="text-xs text-muted-foreground">
                  Pressione Enter ou vírgula para adicionar. Backspace remove a última.
                </p>
              </div>
            )}

            {/* Required */}
            <div className="flex items-center justify-between rounded-md border p-3">
              <div className="space-y-0.5">
                <Label htmlFor="required-switch" className="cursor-pointer">
                  Campo obrigatório
                </Label>
                <p className="text-xs text-muted-foreground">
                  Agentes serão impedidos de salvar sem preencher este campo.
                </p>
              </div>
              <Switch
                id="required-switch"
                checked={watchedRequired}
                onCheckedChange={val => setValue('required', val, { shouldValidate: true })}
              />
            </div>

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={fecharDialog}
                disabled={isSaving}
              >
                Cancelar
              </Button>
              <Button type="submit" disabled={isSaving}>
                {isSaving
                  ? 'Salvando…'
                  : editing
                    ? 'Salvar alterações'
                    : 'Criar campo'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* AlertDialog excluir */}
      <AlertDialog
        open={!!deleting}
        onOpenChange={open => {
          if (!open) setDeleting(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle className="w-5 h-5 text-destructive" />
              Excluir campo customizado?
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2">
                <p>
                  A definição do campo{' '}
                  <code className="font-mono bg-muted px-1.5 py-0.5 rounded text-xs">
                    {deleting?.key}
                  </code>{' '}
                  ({deleting?.label}) será removida.
                </p>
                <p className="text-xs">
                  Os dados já preenchidos em conversas, contatos ou na conta serão{' '}
                  <strong>preservados no banco</strong>, mas deixarão de ser editáveis pela
                  UI até que o campo seja recriado com a mesma chave.
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => deleting && mutateDelete.mutate(deleting.id)}
              disabled={mutateDelete.isPending}
            >
              {mutateDelete.isPending ? 'Excluindo…' : 'Excluir'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
