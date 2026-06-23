import { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  apiKeysBackendService,
  type ApiKey,
  type CreatedApiKey,
} from '@/services/api-keys.backend.service';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Checkbox } from '@/components/ui/checkbox';
import { Skeleton } from '@/components/ui/skeleton';
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
  ArrowLeft,
  Copy,
  Key,
  Loader2,
  Plus,
  ShieldAlert,
  Trash2,
} from 'lucide-react';
import { safeFormatDateBR } from '@/utils/dateUtils';
import { toast } from 'sonner';

/**
 * Formata uma data como tempo relativo em português (ex: "há 3 minutos").
 * Para datas mais antigas que 30 dias, cai pra dd/MM/yyyy.
 */
function formatRelativeBR(value: string | null | undefined): string {
  if (!value) return 'Nunca';
  const d = new Date(value);
  if (isNaN(d.getTime())) return '-';
  const diffMs = Date.now() - d.getTime();
  const sec = Math.round(diffMs / 1000);
  if (sec < 60) return 'agora há pouco';
  const min = Math.round(sec / 60);
  if (min < 60) return `há ${min} minuto${min > 1 ? 's' : ''}`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `há ${hr} hora${hr > 1 ? 's' : ''}`;
  const days = Math.round(hr / 24);
  if (days < 30) return `há ${days} dia${days > 1 ? 's' : ''}`;
  return safeFormatDateBR(value, 'dd/MM/yyyy');
}

export default function SuperAdminApiKeysPage() {
  const { accountId } = useParams<{ accountId: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [newKeyName, setNewKeyName] = useState('');
  const [createdKey, setCreatedKey] = useState<CreatedApiKey | null>(null);
  const [hasCopiedKey, setHasCopiedKey] = useState(false);
  const [revokingKey, setRevokingKey] = useState<ApiKey | null>(null);
  const [hideRevoked, setHideRevoked] = useState(true);

  // Lista de API keys
  const {
    data: apiKeys = [],
    isLoading,
    isError,
    error,
  } = useQuery<ApiKey[]>({
    queryKey: ['api-keys', accountId],
    queryFn: () => apiKeysBackendService.listApiKeys(accountId!),
    enabled: !!accountId,
  });

  // Criar nova API key
  const createMutation = useMutation({
    mutationFn: (name: string) =>
      apiKeysBackendService.createApiKey(accountId!, { name }),
    onSuccess: (data) => {
      setCreatedKey(data);
      setNewKeyName('');
      queryClient.invalidateQueries({ queryKey: ['api-keys', accountId] });
      toast.success('API Key criada com sucesso!');
    },
    onError: (err: any) => {
      toast.error('Erro ao criar API Key: ' + (err?.message || 'desconhecido'));
    },
  });

  // Revogar API key
  const revokeMutation = useMutation({
    mutationFn: (id: string) =>
      apiKeysBackendService.revokeApiKey(id, accountId!),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['api-keys', accountId] });
      setRevokingKey(null);
      toast.success('API Key revogada com sucesso!');
    },
    onError: (err: any) => {
      toast.error('Erro ao revogar: ' + (err?.message || 'desconhecido'));
    },
  });

  const handleGenerate = () => {
    const name = newKeyName.trim();
    if (!name) {
      toast.error('Nome é obrigatório');
      return;
    }
    createMutation.mutate(name);
  };

  const handleCopyKey = async () => {
    if (!createdKey) return;
    try {
      await navigator.clipboard.writeText(createdKey.plaintextKey);
      toast.success('Chave copiada para a área de transferência');
    } catch {
      toast.error('Não foi possível copiar — copie manualmente');
    }
  };

  const handleCloseCreateDialog = (open: boolean) => {
    if (!open) {
      setIsCreateOpen(false);
      setNewKeyName('');
      setCreatedKey(null);
      setHasCopiedKey(false);
    } else {
      setIsCreateOpen(true);
    }
  };

  const visibleKeys = hideRevoked
    ? apiKeys.filter((k) => !k.revokedAt)
    : apiKeys;

  if (!accountId) {
    return (
      <div className="page-container">
        <p className="text-destructive">accountId ausente na URL.</p>
      </div>
    );
  }

  return (
    <div className="page-container space-y-6">
      {/* Header */}
      <div className="page-header">
        <div>
          <Button
            variant="ghost"
            size="sm"
            className="gap-2 mb-2"
            onClick={() => navigate(`/super-admin/accounts/${accountId}`)}
          >
            <ArrowLeft className="w-4 h-4" />
            Voltar para a conta
          </Button>
          <h1 className="text-xl sm:text-2xl md:text-3xl font-bold text-foreground flex items-center gap-2">
            <Key className="w-6 h-6" />
            API Keys
          </h1>
          <p className="text-xs sm:text-sm text-muted-foreground">
            Gerencie as chaves de API desta conta. Use-as para integrar sistemas
            externos com o GLEPS CRM.
          </p>
        </div>
        <Button
          onClick={() => setIsCreateOpen(true)}
          className="bg-primary text-primary-foreground hover:bg-primary/90 gap-2"
        >
          <Plus className="w-4 h-4" />
          Nova API Key
        </Button>
      </div>

      {/* Filtros */}
      <Card>
        <CardContent className="pt-6 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <Switch
              id="hide-revoked"
              checked={hideRevoked}
              onCheckedChange={setHideRevoked}
            />
            <Label htmlFor="hide-revoked" className="cursor-pointer">
              Ocultar chaves revogadas
            </Label>
          </div>
          <div className="text-xs text-muted-foreground">
            {visibleKeys.length} chave(s) exibida(s){' '}
            {hideRevoked && apiKeys.length !== visibleKeys.length
              ? `· ${apiKeys.length - visibleKeys.length} oculta(s)`
              : ''}
          </div>
        </CardContent>
      </Card>

      {/* Lista */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Chaves desta conta</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-3">
              {[1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : isError ? (
            <div className="text-destructive text-sm">
              Erro ao carregar API keys:{' '}
              {(error as any)?.message || 'desconhecido'}
            </div>
          ) : visibleKeys.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">
              <Key className="w-12 h-12 mx-auto mb-3 opacity-30" />
              <p>Nenhuma API Key {hideRevoked ? 'ativa ' : ''}encontrada.</p>
              <p className="text-xs mt-1">
                Clique em "Nova API Key" para gerar a primeira.
              </p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Nome</TableHead>
                  <TableHead>Prefixo</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Último uso</TableHead>
                  <TableHead>Criada em</TableHead>
                  <TableHead className="text-right">Ações</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visibleKeys.map((key) => {
                  const isRevoked = !!key.revokedAt;
                  return (
                    <TableRow key={key.id}>
                      <TableCell className="font-medium">{key.name}</TableCell>
                      <TableCell>
                        <code className="text-xs font-mono bg-muted px-2 py-1 rounded">
                          {key.prefix}…
                        </code>
                      </TableCell>
                      <TableCell>
                        {isRevoked ? (
                          <Badge
                            variant="outline"
                            className="bg-red-500/10 text-red-500 border-red-500/30"
                          >
                            Revogada
                          </Badge>
                        ) : (
                          <Badge
                            variant="outline"
                            className="bg-emerald-500/10 text-emerald-500 border-emerald-500/30"
                          >
                            Ativa
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-muted-foreground text-sm">
                        {formatRelativeBR(key.lastUsedAt)}
                      </TableCell>
                      <TableCell className="text-muted-foreground text-sm">
                        {safeFormatDateBR(key.createdAt, 'dd/MM/yyyy HH:mm')}
                      </TableCell>
                      <TableCell className="text-right">
                        {!isRevoked && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-destructive hover:text-destructive"
                            onClick={() => setRevokingKey(key)}
                          >
                            <Trash2 className="w-4 h-4 mr-1" />
                            Revogar
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Dialog: criar + exibir plaintext */}
      <Dialog open={isCreateOpen} onOpenChange={handleCloseCreateDialog}>
        <DialogContent
          className="max-w-md"
          onInteractOutside={(e) => {
            if (createdKey) e.preventDefault();
          }}
          onEscapeKeyDown={(e) => {
            if (createdKey) e.preventDefault();
          }}
        >
          {!createdKey ? (
            <>
              <DialogHeader>
                <DialogTitle>Nova API Key</DialogTitle>
                <DialogDescription>
                  Dê um nome descritivo (ex: "Integração Zapier", "Webhook
                  pagamentos"). A chave gerada terá acesso total a esta conta —
                  trate-a como uma senha.
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-4 py-2">
                <div className="space-y-2">
                  <Label htmlFor="api-key-name">Nome</Label>
                  <Input
                    id="api-key-name"
                    value={newKeyName}
                    onChange={(e) => setNewKeyName(e.target.value)}
                    placeholder="Ex: Integração ERP"
                    autoFocus
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        handleGenerate();
                      }
                    }}
                  />
                </div>
              </div>
              <DialogFooter>
                <Button
                  variant="outline"
                  onClick={() => handleCloseCreateDialog(false)}
                  disabled={createMutation.isPending}
                >
                  Cancelar
                </Button>
                <Button
                  onClick={handleGenerate}
                  disabled={!newKeyName.trim() || createMutation.isPending}
                >
                  {createMutation.isPending && (
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  )}
                  Gerar
                </Button>
              </DialogFooter>
            </>
          ) : (
            <>
              <DialogHeader>
                <DialogTitle>API Key gerada</DialogTitle>
                <DialogDescription>
                  Sua nova chave <strong>{createdKey.name}</strong> foi criada
                  com sucesso.
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-4 py-2">
                <div className="rounded-lg border-2 border-amber-500/40 bg-amber-500/10 p-4 space-y-3">
                  <div className="flex items-start gap-2">
                    <ShieldAlert className="w-5 h-5 text-amber-600 dark:text-amber-400 flex-shrink-0 mt-0.5" />
                    <div className="text-sm font-medium text-amber-900 dark:text-amber-200">
                      Copie agora — não será exibido novamente.
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <code className="flex-1 text-xs font-mono bg-background/60 px-3 py-2 rounded border break-all select-all">
                      {createdKey.plaintextKey}
                    </code>
                    <Button
                      size="icon"
                      variant="outline"
                      onClick={handleCopyKey}
                      title="Copiar chave"
                    >
                      <Copy className="w-4 h-4" />
                    </Button>
                  </div>
                  <p className="text-xs text-amber-800 dark:text-amber-300/80">
                    Armazene esta chave em local seguro (cofre de senhas /
                    variáveis de ambiente). Se for perdida, gere uma nova e
                    revogue esta.
                  </p>
                </div>
                <div className="flex items-start gap-2 pt-1">
                  <Checkbox
                    id="copied-key-confirm"
                    checked={hasCopiedKey}
                    onCheckedChange={(checked) =>
                      setHasCopiedKey(checked === true)
                    }
                    className="mt-0.5"
                  />
                  <Label
                    htmlFor="copied-key-confirm"
                    className="text-sm cursor-pointer leading-snug"
                  >
                    Copiei a chave (não será mostrada de novo)
                  </Label>
                </div>
              </div>
              <DialogFooter>
                <Button
                  onClick={() => handleCloseCreateDialog(false)}
                  disabled={!hasCopiedKey}
                >
                  Fechar
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* Confirmação de revogação */}
      <AlertDialog
        open={!!revokingKey}
        onOpenChange={(open) => !open && setRevokingKey(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revogar API Key?</AlertDialogTitle>
            <AlertDialogDescription>
              A chave <strong>{revokingKey?.name}</strong> deixará de funcionar
              imediatamente. Integrações que dependem dela vão parar de receber
              respostas válidas. Esta ação não pode ser desfeita.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={revokeMutation.isPending}>
              Cancelar
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (revokingKey) revokeMutation.mutate(revokingKey.id);
              }}
              disabled={revokeMutation.isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {revokeMutation.isPending && (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              )}
              Revogar
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
