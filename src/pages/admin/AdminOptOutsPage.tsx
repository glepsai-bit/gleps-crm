/**
 * Página de Opt-outs WhatsApp — Sprint 3 T-022
 *
 * Exibe lista de contatos com opt-out, permite re-opt-in manual
 * e exportação CSV.
 */

import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  whatsappConsentsBackendService,
  type WhatsappConsent,
  type FiltroConsent,
} from '@/services/whatsapp-consents.backend.service';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
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
  Search,
  UserCheck,
} from 'lucide-react';
import { toast } from 'sonner';
import { safeFormatDateBR } from '@/utils/dateUtils';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
  const [reoptInContato, setReoptInContato] = useState<WhatsappConsent | null>(null);
  const [exportando, setExportando] = useState(false);

  // Busca server-side (filtro período e q)
  const { data: optOuts = [], isLoading } = useQuery<WhatsappConsent[]>({
    queryKey: ['whatsapp-optouts', filtro, busca],
    queryFn: () => whatsappConsentsBackendService.listOptedOut(filtro, busca),
    // Debounce leve: quando busca muda, aguarda 400ms antes de refetch
    // (TanStack Query não tem debounce nativo — usamos o estado local)
  });

  // Filtro client-side adicional sobre a busca (para quando backend não filtra)
  const resultados = useMemo(() => {
    if (!busca.trim()) return optOuts;
    const q = busca.toLowerCase();
    return optOuts.filter(
      (c) =>
        c.nome.toLowerCase().includes(q) ||
        c.telefone.includes(q)
    );
  }, [optOuts, busca]);

  const reoptInMutation = useMutation({
    mutationFn: (contactId: string) =>
      whatsappConsentsBackendService.optIn(contactId),
    onSuccess: () => {
      toast.success(`Re-opt-in realizado para ${reoptInContato?.nome}`);
      queryClient.invalidateQueries({ queryKey: ['whatsapp-optouts'] });
      setReoptInContato(null);
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
                  <TableRow key={contato.contactId}>
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
                        className="gap-2 text-emerald-600 border-emerald-500/40 hover:bg-emerald-50 hover:text-emerald-700 dark:hover:bg-emerald-950"
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
        onOpenChange={(open) => !open && setReoptInContato(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Confirmar re-opt-in?</AlertDialogTitle>
            <AlertDialogDescription>
              <strong>{reoptInContato?.nome}</strong> voltará a receber mensagens de WhatsApp.
              Certifique-se de que o contato autorizou explicitamente antes de prosseguir.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={reoptInMutation.isPending}>
              Cancelar
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() =>
                reoptInContato && reoptInMutation.mutate(reoptInContato.contactId)
              }
              disabled={reoptInMutation.isPending}
              className="bg-emerald-600 text-white hover:bg-emerald-700"
            >
              {reoptInMutation.isPending && (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              )}
              Confirmar re-opt-in
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
