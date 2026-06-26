/**
 * Página de Opt-outs WhatsApp — Sprint 3 T-022
 *
 * Exibe lista de contatos com opt-out, permite re-opt-in manual
 * e exportação CSV.
 */

import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  whatsappConsentsBackendService,
  type WhatsappConsent,
  type FiltroConsent,
} from '@/services/whatsapp-consents.backend.service';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Ban,
  Download,
  Loader2,
  Plus,
  Search,
  UserCheck,
} from 'lucide-react';
import { toast } from 'sonner';
import { safeFormatDateBR } from '@/utils/dateUtils';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Hook simples de debounce — atrasa a propagação do valor em `delay` ms.
 * Usado para evitar refetch a cada keystroke da busca (BUG-049).
 */
function useDebouncedValue<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return debounced;
}

const FILTROS_PERIODO: { value: FiltroConsent; label: string }[] = [
  { value: 'last7d', label: 'Últimos 7 dias' },
  { value: 'last30d', label: 'Últimos 30 dias' },
  { value: 'all', label: 'Todos' },
];

function origemBadge(origem: WhatsappConsent['origem']) {
  if (origem === 'manual') {
    return (
      <Badge variant="outline" className="text-xs">
        Manual
      </Badge>
    );
  }
  return (
    <Badge variant="secondary" className="text-xs">
      Automático
    </Badge>
  );
}

// ---------------------------------------------------------------------------
// Componente
// ---------------------------------------------------------------------------

export default function AdminOptOutsPage() {
  const queryClient = useQueryClient();
  const [filtro, setFiltro] = useState<FiltroConsent>('all');
  const [busca, setBusca] = useState('');
  // BUG-049: debounce 300ms na busca antes de refetch + remoção do filtro
  // client-side redundante (server já filtra via `q`).
  const buscaDebounced = useDebouncedValue(busca, 300);
  const [reoptInContato, setReoptInContato] = useState<WhatsappConsent | null>(null);
  const [motivo, setMotivo] = useState('');
  const [exportando, setExportando] = useState(false);

  // L-CFG-2: dialog "Adicionar opt-out manual" — UI para o endpoint
  // POST /api/whatsapp-consents/:phone/opt-out já existente no backend.
  const [addOpen, setAddOpen] = useState(false);
  const [addTelefone, setAddTelefone] = useState('');
  const [addMotivo, setAddMotivo] = useState('');

  // Busca server-side (filtro período e q debounced)
  const { data: optOuts = [], isLoading } = useQuery<WhatsappConsent[]>({
    queryKey: ['whatsapp-optouts', filtro, buscaDebounced],
    queryFn: () =>
      whatsappConsentsBackendService.listOptedOut(filtro, buscaDebounced),
  });

  // Resultados = retorno do server (sem refiltro client-side).
  const resultados = optOuts;

  const optOutManualMutation = useMutation({
    mutationFn: (vars: { telefone: string; motivo?: string }) =>
      whatsappConsentsBackendService.optOut(vars.telefone, vars.motivo),
    onSuccess: () => {
      toast.success('Opt-out manual registrado com sucesso');
      queryClient.invalidateQueries({ queryKey: ['whatsapp-optouts'] });
      setAddOpen(false);
      setAddTelefone('');
      setAddMotivo('');
    },
    onError: (err: unknown) => {
      toast.error(
        'Erro ao registrar opt-out: ' +
          ((err as { message?: string })?.message ?? 'desconhecido')
      );
    },
  });

  const reoptInMutation = useMutation({
    mutationFn: (vars: { id: string; motivo?: string }) =>
      whatsappConsentsBackendService.optIn(vars.id, vars.motivo),
    onSuccess: () => {
      toast.success(`Re-opt-in realizado para ${reoptInContato?.nome}`);
      queryClient.invalidateQueries({ queryKey: ['whatsapp-optouts'] });
      setReoptInContato(null);
      setMotivo('');
    },
    onError: (err: unknown) => {
      toast.error(
        'Erro ao fazer re-opt-in: ' +
          ((err as { message?: string })?.message ?? 'desconhecido')
      );
    },
  });

  async function handleExportar() {
    setExportando(true);
    try {
      await whatsappConsentsBackendService.exportCsv();
      toast.success('Download iniciado');
    } catch (err: unknown) {
      toast.error(
        'Erro ao exportar: ' +
          ((err as { message?: string })?.message ?? 'Backend ainda não disponível')
      );
    } finally {
      setExportando(false);
    }
  }

  return (
    <div className="page-container space-y-6">
      {/* Header */}
      <div className="page-header">
        <div>
          <h1 className="text-xl sm:text-2xl md:text-3xl font-bold text-foreground flex items-center gap-2">
            <Ban className="w-6 h-6" />
            Opt-outs WhatsApp
          </h1>
          <p className="text-xs sm:text-sm text-muted-foreground mt-1">
            Contatos que solicitaram não receber mensagens via WhatsApp.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {/* L-CFG-2: gatilho para registrar opt-out manualmente
              (consume POST /api/whatsapp-consents/:phone/opt-out já existente). */}
          <Button
            variant="default"
            className="gap-2"
            onClick={() => setAddOpen(true)}
          >
            <Plus className="w-4 h-4" />
            Adicionar manual
          </Button>
          <Button
            variant="outline"
            className="gap-2"
            onClick={handleExportar}
            disabled={exportando}
          >
            {exportando ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Download className="w-4 h-4" />
            )}
            Exportar CSV
          </Button>
        </div>
      </div>

      {/* Filtros */}
      <Card>
        <CardContent className="pt-4">
          <div className="flex flex-col sm:flex-row gap-3">
            {/* Busca */}
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input
                placeholder="Buscar por nome ou telefone..."
                className="pl-9"
                value={busca}
                onChange={(e) => setBusca(e.target.value)}
              />
            </div>

            {/* Período */}
            <Select
              value={filtro}
              onValueChange={(v) => setFiltro(v as FiltroConsent)}
            >
              <SelectTrigger className="w-full sm:w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {FILTROS_PERIODO.map((f) => (
                  <SelectItem key={f.value} value={f.value}>
                    {f.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      {/* Lista */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center justify-between">
            <span>Lista de opt-outs</span>
            {!isLoading && (
              <span className="text-sm font-normal text-muted-foreground">
                {resultados.length} contato(s)
              </span>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-3">
              {[1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : resultados.length === 0 ? (
            <div className="text-center py-16 text-muted-foreground">
              <Ban className="w-12 h-12 mx-auto mb-3 opacity-20" />
              <p className="font-medium text-base">Nenhum opt-out registrado. Bom sinal!</p>
              <p className="text-xs mt-1 text-muted-foreground/70">
                {busca || filtro !== 'all'
                  ? 'Tente ajustar os filtros de busca.'
                  : 'Nenhum contato solicitou opt-out ainda.'}
                {/* Backend Sprint 3 pendente — retornará lista vazia até ser implementado */}
              </p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Nome</TableHead>
                  <TableHead>Telefone</TableHead>
                  <TableHead>Data opt-out</TableHead>
                  <TableHead>Origem</TableHead>
                  <TableHead className="text-right">Ações</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {resultados.map((contato) => (
                  <TableRow key={contato.contactId ?? contato.telefone}>
                    <TableCell className="font-medium">{contato.nome}</TableCell>
                    <TableCell className="font-mono text-sm">
                      {contato.telefone}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {safeFormatDateBR(contato.optedOutAt, 'dd/MM/yyyy HH:mm')}
                    </TableCell>
                    <TableCell>{origemBadge(contato.origem)}</TableCell>
                    <TableCell className="text-right">
                      <Button
                        variant="outline"
                        size="sm"
                        className="gap-2 text-success border-success/40 hover:bg-success/10 hover:text-success"
                        onClick={() => setReoptInContato(contato)}
                      >
                        <UserCheck className="w-4 h-4" />
                        Re-opt-in
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Confirmação re-opt-in */}
      <AlertDialog
        open={!!reoptInContato}
        onOpenChange={(open) => {
          if (!open) {
            setReoptInContato(null);
            setMotivo('');
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Confirmar re-opt-in?</AlertDialogTitle>
            <AlertDialogDescription>
              <strong>{reoptInContato?.nome}</strong> voltará a receber mensagens de WhatsApp.
              Certifique-se de que o contato autorizou explicitamente antes de prosseguir.
            </AlertDialogDescription>
          </AlertDialogHeader>

          {/* BUG-083: motivo opcional (auditoria) enviado no body do POST */}
          <div className="space-y-2 py-2">
            <Label htmlFor="motivo-reoptin" className="text-sm">
              Motivo (opcional)
            </Label>
            <Textarea
              id="motivo-reoptin"
              placeholder="Ex.: contato autorizou via e-mail em 23/06"
              value={motivo}
              onChange={(e) => setMotivo(e.target.value)}
              disabled={reoptInMutation.isPending}
              rows={3}
            />
          </div>

          <AlertDialogFooter>
            <AlertDialogCancel disabled={reoptInMutation.isPending}>
              Cancelar
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() =>
                reoptInContato &&
                reoptInMutation.mutate({
                  id: reoptInContato.contactId ?? reoptInContato.telefone,
                  motivo: motivo.trim() || undefined,
                })
              }
              disabled={reoptInMutation.isPending}
              className="bg-success text-success-foreground hover:bg-success/90"
            >
              {reoptInMutation.isPending && (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              )}
              Confirmar re-opt-in
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* L-CFG-2: dialog "Adicionar opt-out manual" */}
      <Dialog
        open={addOpen}
        onOpenChange={(open) => {
          if (!open && !optOutManualMutation.isPending) {
            setAddOpen(false);
            setAddTelefone('');
            setAddMotivo('');
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Adicionar opt-out manual</DialogTitle>
            <DialogDescription>
              Registra opt-out de WhatsApp para um número. O contato deixará de
              receber mensagens via campanhas e disparos.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3 py-2">
            <div className="space-y-1.5">
              <Label htmlFor="optout-telefone" className="text-sm">
                Telefone <span className="text-destructive">*</span>
              </Label>
              <Input
                id="optout-telefone"
                placeholder="Ex.: 5511999998888"
                value={addTelefone}
                onChange={(e) => setAddTelefone(e.target.value)}
                disabled={optOutManualMutation.isPending}
              />
              <p className="text-[11px] text-muted-foreground">
                Formato livre — o backend normaliza para apenas dígitos.
              </p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="optout-motivo" className="text-sm">
                Motivo (opcional)
              </Label>
              <Textarea
                id="optout-motivo"
                placeholder="Ex.: contato solicitou via telefone em 25/06"
                value={addMotivo}
                onChange={(e) => setAddMotivo(e.target.value)}
                disabled={optOutManualMutation.isPending}
                rows={3}
              />
            </div>
          </div>

          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => {
                setAddOpen(false);
                setAddTelefone('');
                setAddMotivo('');
              }}
              disabled={optOutManualMutation.isPending}
            >
              Cancelar
            </Button>
            <Button
              onClick={() => {
                const telefone = addTelefone.trim();
                if (!telefone) {
                  toast.error('Informe o telefone');
                  return;
                }
                optOutManualMutation.mutate({
                  telefone,
                  motivo: addMotivo.trim() || undefined,
                });
              }}
              disabled={optOutManualMutation.isPending}
            >
              {optOutManualMutation.isPending && (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              )}
              Registrar opt-out
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
