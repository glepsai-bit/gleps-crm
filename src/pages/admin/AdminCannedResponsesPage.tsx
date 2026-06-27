/**
 * AdminCannedResponsesPage (T-022 — chat interno)
 *
 * CRUD de respostas prontas (CannedResponse) escopadas por conta.
 * - shortCode validado client-side: começa com `/`, lowercase, alfanumérico + hífen.
 *   O backend normaliza (remove `/` e força lowercase) antes de salvar.
 * - Conflito de shortCode na conta retorna 409 (mensagem amigável no toast).
 * - Preview substitui placeholders {nome}/{telefone}/{valor} por dados de exemplo
 *   e avisa quando há placeholders desconhecidos.
 *
 * Serviço: src/services/canned-responses.backend.service.ts
 */

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import {
  cannedResponsesBackendService,
  CannedResponse,
  CreateCannedResponseInput,
  UpdateCannedResponseInput,
} from '@/services/canned-responses.backend.service';
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { useToast } from '@/hooks/use-toast';
import { Plus, Pencil, Trash2, MessageSquareReply, Search, AlertTriangle, Eye } from 'lucide-react';

// ----------- Validação -----------

/**
 * shortCode no formato exibido ao usuário: começa com `/`,
 * seguido de letras minúsculas, números e hífens. Sem espaços.
 * O backend remove a barra inicial e normaliza para lowercase.
 */
const SHORT_CODE_REGEX = /^\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

const schema = z.object({
  shortCode: z
    .string()
    .min(2, 'shortCode é obrigatório (ex: /saudacao)')
    .regex(
      SHORT_CODE_REGEX,
      'Use o formato /saudacao — barra inicial, letras minúsculas, números e hífen',
    ),
  content: z.string().min(1, 'Conteúdo obrigatório'),
  description: z.string().max(200, 'Máximo 200 caracteres').optional(),
});

type FormData = z.infer<typeof schema>;

// ----------- Preview -----------

const FAKE_PREVIEW: Record<string, string> = {
  '{nome}': 'João Silva',
  '{telefone}': '(11) 99999-9999',
  '{valor}': 'R$ 150,00',
  '{empresa}': 'GLEPS CRM',
};

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

/** Exibe shortCode sempre com barra inicial, mesmo que o backend devolva sem. */
function formatShortCode(shortCode: string): string {
  if (!shortCode) return '';
  return shortCode.startsWith('/') ? shortCode : `/${shortCode}`;
}

// ----------- Componente -----------

export default function AdminCannedResponsesPage() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<CannedResponse | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [previewItem, setPreviewItem] = useState<CannedResponse | null>(null);
  const [confirmDiscardOpen, setConfirmDiscardOpen] = useState(false);
  const [search, setSearch] = useState('');

  const { data: items = [], isLoading } = useQuery({
    queryKey: ['canned-responses', search],
    queryFn: () => cannedResponsesBackendService.listCannedResponses(search || undefined),
  });

  const {
    register,
    handleSubmit,
    reset,
    watch,
    formState: { errors, isDirty },
  } = useForm<FormData>({
    resolver: zodResolver(schema),
    defaultValues: { shortCode: '/', content: '', description: '' },
  });

  const contentValue = watch('content');

  const mutateCriar = useMutation({
    mutationFn: (payload: CreateCannedResponseInput) =>
      cannedResponsesBackendService.create(payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['canned-responses'] });
      toast({ title: 'Resposta pronta criada!' });
      fecharDialog();
    },
    onError: (err: Error) => {
      const isConflict = /409|já existe|conflict/i.test(err.message);
      toast({
        title: isConflict ? 'shortCode já existe' : 'Erro ao criar resposta',
        description: isConflict
          ? 'Já existe uma resposta pronta com esse shortCode nesta conta.'
          : err.message,
        variant: 'destructive',
      });
    },
  });

  const mutateEditar = useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: UpdateCannedResponseInput }) =>
      cannedResponsesBackendService.update(id, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['canned-responses'] });
      toast({ title: 'Resposta pronta atualizada!' });
      fecharDialog();
    },
    onError: (err: Error) => {
      const isConflict = /409|já existe|conflict/i.test(err.message);
      toast({
        title: isConflict ? 'shortCode já existe' : 'Erro ao atualizar',
        description: isConflict
          ? 'Já existe uma resposta pronta com esse shortCode nesta conta.'
          : err.message,
        variant: 'destructive',
      });
    },
  });

  const mutateExcluir = useMutation({
    mutationFn: (id: string) => cannedResponsesBackendService.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['canned-responses'] });
      toast({ title: 'Resposta pronta excluída.' });
      setDeletingId(null);
    },
    onError: (err: Error) => {
      toast({ title: 'Erro ao excluir', description: err.message, variant: 'destructive' });
    },
  });

  const abrirCriar = () => {
    setEditing(null);
    reset({ shortCode: '/', content: '', description: '' });
    setDialogOpen(true);
  };

  const abrirEditar = (item: CannedResponse) => {
    setEditing(item);
    reset({
      shortCode: formatShortCode(item.shortCode),
      content: item.content,
      description: item.description ?? '',
    });
    setDialogOpen(true);
  };

  const fecharDialog = () => {
    setDialogOpen(false);
    setEditing(null);
    setConfirmDiscardOpen(false);
    reset({ shortCode: '/', content: '', description: '' });
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
    // O backend remove a barra inicial e normaliza lowercase.
    // Mandamos como o usuário digitou (com a `/`); o service não impõe formato.
    const payload: CreateCannedResponseInput = {
      shortCode: data.shortCode,
      content: data.content,
      description: data.description?.trim() ? data.description.trim() : null,
    };
    if (editing) {
      mutateEditar.mutate({ id: editing.id, payload });
    } else {
      mutateCriar.mutate(payload);
    }
  };

  const isSaving = mutateCriar.isPending || mutateEditar.isPending;
  const placeholdersDesconhecidos = contentValue ? findUnknownPlaceholders(contentValue) : [];

  return (
    <div className="p-4 sm:p-6 lg:p-8 space-y-6 max-w-7xl mx-auto">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Respostas Prontas</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Crie atalhos (ex: <code className="bg-muted px-1 rounded">/saudacao</code>) para enviar
            mensagens recorrentes no chat.
          </p>
        </div>
        <Button onClick={abrirCriar}>
          <Plus className="w-4 h-4 mr-2" />
          Nova Resposta
        </Button>
      </div>

      <Card>
        <CardHeader className="space-y-3">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <CardTitle className="text-base">
              Respostas cadastradas ({items.length})
            </CardTitle>
            <div className="relative w-full sm:w-72">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input
                placeholder="Buscar por atalho, conteúdo..."
                value={search}
                onChange={e => setSearch(e.target.value)}
                className="pl-8"
              />
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-3">
              {[1, 2, 3].map(i => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : items.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
              <MessageSquareReply className="w-12 h-12 mb-4 opacity-30" />
              <p className="text-sm font-medium">
                {search
                  ? 'Nenhuma resposta encontrada para essa busca'
                  : 'Nenhuma resposta pronta cadastrada'}
              </p>
              <p className="text-xs mt-1">
                {search ? 'Tente outro termo.' : 'Clique em "Nova Resposta" para criar a primeira.'}
              </p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[180px]">Atalho</TableHead>
                  <TableHead>Conteúdo</TableHead>
                  <TableHead className="hidden md:table-cell w-[220px]">Descrição</TableHead>
                  <TableHead className="text-right w-[140px]">Ações</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map(item => (
                  <TableRow key={item.id}>
                    <TableCell>
                      <code className="font-mono text-sm bg-muted px-2 py-1 rounded">
                        {formatShortCode(item.shortCode)}
                      </code>
                    </TableCell>
                    <TableCell className="max-w-[320px]">
                      <p className="text-sm text-foreground truncate" title={item.content}>
                        {item.content}
                      </p>
                    </TableCell>
                    <TableCell className="hidden md:table-cell text-muted-foreground text-sm truncate">
                      {item.description || '—'}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => setPreviewItem(item)}
                          title="Pré-visualizar"
                          aria-label={`Pré-visualizar resposta ${formatShortCode(item.shortCode)}`}
                        >
                          <Eye className="w-4 h-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => abrirEditar(item)}
                          title="Editar"
                          aria-label={`Editar resposta ${formatShortCode(item.shortCode)}`}
                        >
                          <Pencil className="w-4 h-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => setDeletingId(item.id)}
                          className="text-destructive hover:text-destructive"
                          title="Excluir"
                          aria-label={`Excluir resposta ${formatShortCode(item.shortCode)}`}
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
            <DialogTitle>
              {editing ? 'Editar Resposta Pronta' : 'Nova Resposta Pronta'}
            </DialogTitle>
          </DialogHeader>
          <form onSubmit={handleSubmit(onSubmit)} className="space-y-4 py-2">
            <div className="space-y-1">
              <Label htmlFor="shortCode">Atalho (shortCode)</Label>
              <Input
                id="shortCode"
                {...register('shortCode')}
                placeholder="/saudacao"
                className="font-mono"
                autoComplete="off"
                spellCheck={false}
              />
              {errors.shortCode ? (
                <p className="text-xs text-destructive">{errors.shortCode.message}</p>
              ) : (
                <p className="text-xs text-muted-foreground">
                  Comece com <code className="bg-muted px-1 rounded">/</code>, use apenas letras
                  minúsculas, números e hífen.
                </p>
              )}
            </div>

            <div className="space-y-1">
              <Label htmlFor="content">Conteúdo da mensagem</Label>
              <Textarea
                id="content"
                {...register('content')}
                placeholder="Olá {nome}, tudo bem? Posso ajudar com mais alguma coisa?"
                rows={5}
              />
              {errors.content && (
                <p className="text-xs text-destructive">{errors.content.message}</p>
              )}
              <p className="text-xs text-muted-foreground">
                Placeholders disponíveis: <code className="bg-muted px-1 rounded">{'{nome}'}</code>{' '}
                <code className="bg-muted px-1 rounded">{'{telefone}'}</code>{' '}
                <code className="bg-muted px-1 rounded">{'{valor}'}</code>{' '}
                <code className="bg-muted px-1 rounded">{'{empresa}'}</code>
              </p>
            </div>

            <div className="space-y-1">
              <Label htmlFor="description">Descrição (opcional)</Label>
              <Input
                id="description"
                {...register('description')}
                placeholder="Ex: Saudação inicial padrão para novos contatos"
              />
              {errors.description && (
                <p className="text-xs text-destructive">{errors.description.message}</p>
              )}
            </div>

            {/* Preview ao vivo */}
            {contentValue && contentValue.trim().length > 0 && (
              <div className="space-y-2 pt-2 border-t">
                <Label className="text-xs uppercase tracking-wider text-muted-foreground">
                  Preview
                </Label>
                {placeholdersDesconhecidos.length > 0 && (
                  <Alert
                    variant="default"
                    className="border-yellow-300 bg-yellow-50 text-yellow-900 dark:border-yellow-800 dark:bg-yellow-950/30 dark:text-yellow-200 [&>svg]:text-yellow-600 dark:[&>svg]:text-yellow-400"
                  >
                    <AlertTriangle className="h-4 w-4" />
                    <AlertDescription className="text-xs">
                      Variáveis sem dado de exemplo (serão enviadas literalmente):{' '}
                      {placeholdersDesconhecidos.map((v, i) => (
                        <span key={v}>
                          <code className="bg-yellow-100 dark:bg-yellow-900/40 px-1 rounded">
                            {v}
                          </code>
                          {i < placeholdersDesconhecidos.length - 1 ? ', ' : ''}
                        </span>
                      ))}
                    </AlertDescription>
                  </Alert>
                )}
                <div className="bg-muted/50 border rounded-lg p-3">
                  <p className="text-sm whitespace-pre-wrap text-foreground">
                    {previewContent(contentValue)}
                  </p>
                </div>
              </div>
            )}

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => solicitarFechamento(false)}
                disabled={isSaving}
              >
                Cancelar
              </Button>
              <Button type="submit" disabled={isSaving}>
                {isSaving ? 'Salvando...' : editing ? 'Salvar alterações' : 'Criar resposta'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Dialog preview standalone */}
      <Dialog open={!!previewItem} onOpenChange={() => setPreviewItem(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <span>Preview —</span>
              <code className="font-mono text-sm bg-muted px-2 py-0.5 rounded">
                {previewItem ? formatShortCode(previewItem.shortCode) : ''}
              </code>
            </DialogTitle>
          </DialogHeader>
          <div className="py-2 space-y-3">
            <p className="text-xs text-muted-foreground">Visualização com dados de exemplo</p>
            {previewItem &&
              (() => {
                const desconhecidas = findUnknownPlaceholders(previewItem.content);
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
                          <code className="bg-yellow-100 dark:bg-yellow-900/40 px-1 rounded">
                            {v}
                          </code>
                          {i < desconhecidas.length - 1 ? ', ' : ''}
                        </span>
                      ))}
                    </AlertDescription>
                  </Alert>
                );
              })()}
            <div className="bg-green-50 dark:bg-green-950/20 border border-green-200 dark:border-green-900 rounded-lg p-4">
              <p className="text-sm whitespace-pre-wrap text-foreground">
                {previewItem ? previewContent(previewItem.content) : ''}
              </p>
            </div>
            {previewItem?.description && (
              <p className="text-xs text-muted-foreground italic">{previewItem.description}</p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPreviewItem(null)}>
              Fechar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* AlertDialog descartar alterações */}
      <AlertDialog open={confirmDiscardOpen} onOpenChange={setConfirmDiscardOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Descartar alterações?</AlertDialogTitle>
            <AlertDialogDescription>
              Você possui alterações não salvas. Se fechar agora, elas serão perdidas.
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
      <AlertDialog
        open={!!deletingId}
        onOpenChange={open => {
          if (!open) setDeletingId(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Excluir resposta pronta?</AlertDialogTitle>
            <AlertDialogDescription>
              Esta ação não pode ser desfeita. A resposta será removida permanentemente desta conta.
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
