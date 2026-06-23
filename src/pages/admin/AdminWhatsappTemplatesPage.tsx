import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import {
  listTemplates,
  createTemplate,
  updateTemplate,
  deleteTemplate,
  WhatsappTemplate,
} from '@/services/whatsapp-templates.backend.service';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
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
import { Alert, AlertDescription } from '@/components/ui/alert';
import { useToast } from '@/hooks/use-toast';
import { Plus, Pencil, Trash2, MessageSquare, Eye, AlertTriangle } from 'lucide-react';

const schema = z.object({
  name: z.string().min(2, 'Nome deve ter pelo menos 2 caracteres'),
  category: z.string().min(1, 'Categoria obrigatória'),
  content: z.string().min(1, 'Conteúdo obrigatório'),
});
type FormData = z.infer<typeof schema>;

const CATEGORIAS = [
  { value: 'relacionamento', label: 'Relacionamento' },
  { value: 'promocional', label: 'Promocional' },
  { value: 'transacional', label: 'Transacional' },
  { value: 'custom', label: 'Personalizado' },
];

const FAKE_PREVIEW = { '{nome}': 'João Silva', '{telefone}': '(11) 99999-9999', '{valor}': 'R$ 150,00' };
const KNOWN_PLACEHOLDERS = new Set(Object.keys(FAKE_PREVIEW));

function previewContent(content: string) {
  let preview = content;
  Object.entries(FAKE_PREVIEW).forEach(([placeholder, value]) => {
    preview = preview.split(placeholder).join(value);
  });
  return preview;
}

function findUnknownPlaceholders(content: string): string[] {
  const matches = content.match(/\{[^{}\s]+\}/g) ?? [];
  const unknown = matches.filter(m => !KNOWN_PLACEHOLDERS.has(m));
  return Array.from(new Set(unknown));
}

function categoryLabel(cat: string) {
  return CATEGORIAS.find(c => c.value === cat)?.label ?? cat;
}

export default function AdminWhatsappTemplatesPage() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState<WhatsappTemplate | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [previewTemplate, setPreviewTemplate] = useState<WhatsappTemplate | null>(null);
  const [confirmDiscardOpen, setConfirmDiscardOpen] = useState(false);

  const { data: templates = [], isLoading } = useQuery({
    queryKey: ['whatsapp-templates'],
    queryFn: listTemplates,
  });

  const { register, handleSubmit, reset, setValue, watch, formState: { errors, isDirty } } = useForm<FormData>({
    resolver: zodResolver(schema),
    defaultValues: { name: '', category: 'relacionamento', content: '' },
  });

  const categoryValue = watch('category');

  const mutateCriar = useMutation({
    mutationFn: createTemplate,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['whatsapp-templates'] });
      toast({ title: 'Template criado com sucesso!' });
      fecharDialog();
    },
    onError: (err: Error) => {
      toast({ title: 'Erro ao criar template', description: err.message, variant: 'destructive' });
    },
  });

  const mutateEditar = useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: { name?: string; content?: string; category?: string } }) =>
      updateTemplate(id, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['whatsapp-templates'] });
      toast({ title: 'Template atualizado!' });
      fecharDialog();
    },
    onError: (err: Error) => {
      toast({ title: 'Erro ao atualizar', description: err.message, variant: 'destructive' });
    },
  });

  const mutateExcluir = useMutation({
    mutationFn: deleteTemplate,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['whatsapp-templates'] });
      toast({ title: 'Template excluído.' });
      setDeletingId(null);
    },
    onError: (err: Error) => {
      toast({ title: 'Erro ao excluir', description: err.message, variant: 'destructive' });
    },
  });

  const abrirCriar = () => {
    setEditingTemplate(null);
    reset({ name: '', category: 'relacionamento', content: '' });
    setDialogOpen(true);
  };

  const abrirEditar = (template: WhatsappTemplate) => {
    setEditingTemplate(template);
    reset({ name: template.name, category: template.category, content: template.content });
    setDialogOpen(true);
  };

  const fecharDialog = () => {
    setDialogOpen(false);
    setEditingTemplate(null);
    setConfirmDiscardOpen(false);
    reset({ name: '', category: 'relacionamento', content: '' });
  };

  const solicitarFechamento = (open: boolean) => {
    if (open) {
      setDialogOpen(true);
      return;
    }
    if (isDirty) {
      setConfirmDiscardOpen(true);
      return;
    }
    fecharDialog();
  };

  const onSubmit = (data: FormData) => {
    if (editingTemplate) {
      mutateEditar.mutate({ id: editingTemplate.id, payload: { name: data.name, content: data.content, category: data.category } });
    } else {
      mutateCriar.mutate({ name: data.name, content: data.content, category: data.category });
    }
  };

  const isSaving = mutateCriar.isPending || mutateEditar.isPending;

  return (
    <div className="p-4 sm:p-6 lg:p-8 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Templates de WhatsApp</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Crie e gerencie modelos de mensagem para campanhas
          </p>
        </div>
        <Button onClick={abrirCriar}>
          <Plus className="w-4 h-4 mr-2" />
          Novo Template
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Templates cadastrados ({templates.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-3">
              {[1, 2, 3].map(i => <Skeleton key={i} className="h-12 w-full" />)}
            </div>
          ) : templates.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
              <MessageSquare className="w-12 h-12 mb-4 opacity-30" />
              <p className="text-sm font-medium">Nenhum template cadastrado</p>
              <p className="text-xs mt-1">Clique em "Novo Template" para criar o primeiro</p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Nome</TableHead>
                  <TableHead>Categoria</TableHead>
                  <TableHead className="hidden md:table-cell">Conteúdo</TableHead>
                  <TableHead className="text-right">Ações</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {templates.map(t => (
                  <TableRow key={t.id}>
                    <TableCell className="font-medium">{t.name}</TableCell>
                    <TableCell>
                      <Badge variant="secondary">{categoryLabel(t.category)}</Badge>
                    </TableCell>
                    <TableCell className="hidden md:table-cell text-muted-foreground text-sm max-w-xs truncate">
                      {t.content}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => setPreviewTemplate(t)}
                          title="Pré-visualizar"
                          aria-label={`Pré-visualizar template ${t.name}`}
                        >
                          <Eye className="w-4 h-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => abrirEditar(t)}
                          title="Editar"
                          aria-label={`Editar template ${t.name}`}
                        >
                          <Pencil className="w-4 h-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => setDeletingId(t.id)}
                          className="text-destructive hover:text-destructive"
                          title="Excluir"
                          aria-label={`Excluir template ${t.name}`}
                        >
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Dialog criar/editar */}
      <Dialog open={dialogOpen} onOpenChange={solicitarFechamento}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{editingTemplate ? 'Editar Template' : 'Novo Template'}</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleSubmit(onSubmit)} className="space-y-4 py-2">
            <div className="space-y-1">
              <Label>Nome do template</Label>
              <Input {...register('name')} placeholder="Ex: Boas-vindas academia" />
              {errors.name && <p className="text-xs text-destructive">{errors.name.message}</p>}
            </div>

            <div className="space-y-1">
              <Label>Categoria</Label>
              <Select
                value={categoryValue}
                onValueChange={val => setValue('category', val, { shouldValidate: true })}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Selecione a categoria" />
                </SelectTrigger>
                <SelectContent>
                  {CATEGORIAS.map(c => (
                    <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {errors.category && <p className="text-xs text-destructive">{errors.category.message}</p>}
            </div>

            <div className="space-y-1">
              <Label>Conteúdo da mensagem</Label>
              <Textarea
                {...register('content')}
                placeholder="Olá {nome}, tudo bem? Temos uma oferta especial para você..."
                rows={4}
              />
              {errors.content && <p className="text-xs text-destructive">{errors.content.message}</p>}
              <p className="text-xs text-muted-foreground">
                Placeholders disponíveis: <code className="bg-muted px-1 rounded">{'{nome}'}</code>{' '}
                <code className="bg-muted px-1 rounded">{'{telefone}'}</code>{' '}
                <code className="bg-muted px-1 rounded">{'{valor}'}</code>
              </p>
            </div>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => solicitarFechamento(false)} disabled={isSaving}>
                Cancelar
              </Button>
              <Button type="submit" disabled={isSaving}>
                {isSaving ? 'Salvando...' : editingTemplate ? 'Salvar alterações' : 'Criar template'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Dialog preview */}
      <Dialog open={!!previewTemplate} onOpenChange={() => setPreviewTemplate(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Preview — {previewTemplate?.name}</DialogTitle>
          </DialogHeader>
          <div className="py-2 space-y-3">
            <p className="text-xs text-muted-foreground">Visualização com dados de exemplo</p>
            {previewTemplate && (() => {
              const desconhecidas = findUnknownPlaceholders(previewTemplate.content);
              if (desconhecidas.length === 0) return null;
              return (
                <Alert
                  variant="default"
                  className="border-yellow-300 bg-yellow-50 text-yellow-900 dark:border-yellow-800 dark:bg-yellow-950/30 dark:text-yellow-200 [&>svg]:text-yellow-600 dark:[&>svg]:text-yellow-400"
                >
                  <AlertTriangle className="h-4 w-4" />
                  <AlertDescription>
                    Variáveis sem dado de exemplo (serão exibidas literalmente):{' '}
                    {desconhecidas.map((v, i) => (
                      <span key={v}>
                        <code className="bg-yellow-100 dark:bg-yellow-900/40 px-1 rounded">{v}</code>
                        {i < desconhecidas.length - 1 ? ', ' : ''}
                      </span>
                    ))}
                  </AlertDescription>
                </Alert>
              );
            })()}
            <div className="bg-green-50 dark:bg-green-950/20 border border-green-200 dark:border-green-900 rounded-lg p-4">
              <p className="text-sm whitespace-pre-wrap text-foreground">
                {previewTemplate ? previewContent(previewTemplate.content) : ''}
              </p>
            </div>
            {previewTemplate && (
              <Badge variant="secondary">{categoryLabel(previewTemplate.category)}</Badge>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPreviewTemplate(null)}>Fechar</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* AlertDialog descartar alterações */}
      <AlertDialog open={confirmDiscardOpen} onOpenChange={setConfirmDiscardOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Descartar alterações?</AlertDialogTitle>
            <AlertDialogDescription>
              Você possui alterações não salvas no template. Se fechar agora, elas serão perdidas.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Continuar editando</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={fecharDialog}
            >
              Descartar
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* AlertDialog excluir */}
      <AlertDialog open={!!deletingId} onOpenChange={open => { if (!open) setDeletingId(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Excluir template?</AlertDialogTitle>
            <AlertDialogDescription>
              Esta ação não pode ser desfeita. O template será removido permanentemente.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => deletingId && mutateExcluir.mutate(deletingId)}
              disabled={mutateExcluir.isPending}
            >
              {mutateExcluir.isPending ? 'Excluindo...' : 'Excluir'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
