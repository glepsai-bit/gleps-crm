import { useState, useCallback, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { useBackend } from '@/config/backend.config';
import { apiClient } from '@/api/client';
import { API_ENDPOINTS } from '@/api/endpoints';
import { useAuth } from '@/contexts/AuthContext';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ExtractionSearchForm } from '@/components/extracao/ExtractionSearchForm';
import { ExtractionResultsTable } from '@/components/extracao/ExtractionResultsTable';
import { DispatchDialog } from '@/components/extracao/DispatchDialog';
import { DispatchMonitor } from '@/components/extracao/DispatchMonitor';
import { SaveAudienceDialog } from '@/components/extracao/SaveAudienceDialog';
import { SavedAudiencesTab } from '@/components/extracao/SavedAudiencesTab';
import { CampaignDashboard } from '@/components/extracao/CampaignDashboard';
import { DispatchTypeDashboard } from '@/components/extracao/DispatchTypeDashboard';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
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
import { Download, Send, Search, Zap, Save, Users, Calendar, BarChart2, X as XIcon, Pause, Play, Eye, MapPin } from 'lucide-react';
import { EmptyState } from '@/components/ui/empty-state';
import { useToast } from '@/hooks/use-toast';
import type { ExtractedLead, ApiUsage } from '@/components/extracao/types';

type BatchStatus = 'scheduled' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';

interface BatchRow {
  id: string;
  status: BatchStatus | string;
  keyword?: string | null;
  triggerName?: string | null;
  trigger_name?: string | null;
  template_name?: string | null;
  templateName?: string | null;
  total_contacts?: number | null;
  totalContacts?: number | null;
  sent_count?: number | null;
  sentCount?: number | null;
  failed_count?: number | null;
  failedCount?: number | null;
  scheduled_at?: string | null;
  scheduledAt?: string | null;
}

function getNum(b: BatchRow, snake: 'total_contacts' | 'sent_count' | 'failed_count', camel: 'totalContacts' | 'sentCount' | 'failedCount'): number {
  const v = (b as Record<string, unknown>)[snake] ?? (b as Record<string, unknown>)[camel];
  return typeof v === 'number' ? v : 0;
}

function getScheduledAt(b: BatchRow): string | null {
  return (b.scheduled_at ?? b.scheduledAt) ?? null;
}

function getBatchName(b: BatchRow): string {
  return b.keyword ?? b.triggerName ?? b.trigger_name ?? 'Disparo manual';
}

function getTemplateName(b: BatchRow): string {
  return b.template_name ?? b.templateName ?? '—';
}

function statusBadgeVariant(status: string): 'default' | 'secondary' | 'destructive' | 'outline' {
  switch (status) {
    case 'running':
      return 'default';
    case 'scheduled':
      return 'secondary';
    case 'paused':
      return 'outline';
    case 'completed':
      return 'default';
    case 'cancelled':
    case 'failed':
      return 'destructive';
    default:
      return 'outline';
  }
}

function statusLabel(status: string): string {
  switch (status) {
    case 'running':
      return 'Rodando';
    case 'scheduled':
      return 'Agendado';
    case 'paused':
      return 'Pausado';
    case 'completed':
      return 'Concluído';
    case 'cancelled':
      return 'Cancelado';
    case 'failed':
      return 'Falhou';
    default:
      return status;
  }
}

function AgendadasTab({ accountId }: { accountId: string }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [cancelingId, setCancelingId] = useState<string | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  // L-CFG-3: filtros UI (status + busca por nome do disparo) — aplicados
  // client-side sobre o array retornado pelo polling de 5s.
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [searchFilter, setSearchFilter] = useState<string>('');

  const mutateCancelar = useMutation({
    mutationFn: async (batchId: string) => {
      await apiClient.delete(API_ENDPOINTS.PROSPECTING.BATCH_CANCEL(batchId));
    },
    // BUG-FE-001: onSettled garante que o AlertDialog feche em sucesso E erro
    // (antes onSuccess fechava e onError deixava o dialog travado preso ao id).
    onSettled: () => {
      setCancelingId(null);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['batches-agendadas', accountId] });
      toast({ title: 'Disparo cancelado.' });
    },
    onError: (err: Error) => {
      toast({ title: 'Erro ao cancelar', description: err.message, variant: 'destructive' });
    },
  });

  const mutatePausar = useMutation({
    mutationFn: async (batchId: string) => {
      await apiClient.post(API_ENDPOINTS.PROSPECTING.BATCH_PAUSE(batchId), {});
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['batches-agendadas', accountId] });
      toast({ title: 'Disparo pausado.' });
    },
    onError: (err: Error) => {
      toast({ title: 'Erro ao pausar', description: err.message, variant: 'destructive' });
    },
  });

  const mutateRetomar = useMutation({
    mutationFn: async (batchId: string) => {
      await apiClient.post(API_ENDPOINTS.PROSPECTING.BATCH_RESUME(batchId), {});
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['batches-agendadas', accountId] });
      toast({ title: 'Disparo retomado.' });
    },
    onError: (err: Error) => {
      toast({ title: 'Erro ao retomar', description: err.message, variant: 'destructive' });
    },
  });

  const { data: agendadas = [], isLoading, isError, error, refetch } = useQuery<BatchRow[]>({
    queryKey: ['batches-agendadas', accountId],
    queryFn: async () => {
      const res = await apiClient.get<unknown>(API_ENDPOINTS.PROSPECTING.BATCHES_SCHEDULED);
      const payload = (res as { data?: unknown })?.data ?? res;
      const list = Array.isArray(payload) ? payload : [];
      return list as BatchRow[];
    },
    retry: false,
    // BUG-FE-002: pausa polling de 5s quando dialog detalhe está aberto
    // (evita re-render durante leitura do usuário) ou quando uma mutation
    // está em vôo (evita race entre invalidate manual e refetch automático).
    refetchInterval: () => {
      if (detailId) return false;
      if (mutatePausar.isPending || mutateRetomar.isPending || mutateCancelar.isPending) return false;
      return 5000;
    },
    refetchIntervalInBackground: false,
    enabled: !!accountId,
  });

  const detailBatch = detailId ? agendadas.find((b) => b.id === detailId) ?? null : null;

  // L-CFG-3: aplica filtros de status + busca (case-insensitive, trim) antes
  // de renderizar a Table. `all` mantém o comportamento original (sem filtro).
  const searchTermNorm = searchFilter.trim().toLowerCase();
  const filteredAgendadas = agendadas.filter((b) => {
    if (statusFilter !== 'all' && String(b.status) !== statusFilter) return false;
    if (searchTermNorm.length > 0) {
      const nome = getBatchName(b).toLowerCase();
      if (!nome.includes(searchTermNorm)) return false;
    }
    return true;
  });

  if (isLoading) {
    return (
      <Card>
        <CardContent className="py-8 space-y-3">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </CardContent>
      </Card>
    );
  }

  if (isError) {
    return (
      <Card>
        <CardContent className="py-8 flex flex-col items-center justify-center text-muted-foreground gap-2">
          <p className="text-sm font-medium text-destructive">Erro ao carregar disparos agendados</p>
          <p className="text-xs">{(error as Error)?.message ?? 'Tente novamente em instantes.'}</p>
          <Button variant="outline" size="sm" onClick={() => refetch()}>
            Recarregar
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <>
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <CardTitle className="text-base">Disparos em andamento e agendados</CardTitle>
          <Badge variant="outline" className="text-xs">
            {filteredAgendadas.length} de {agendadas.length} disparo{agendadas.length === 1 ? '' : 's'}
          </Badge>
        </CardHeader>
        <CardContent>
          {/* L-CFG-3: filtros (status + busca por nome) */}
          {agendadas.length > 0 && (
            <div className="flex flex-col sm:flex-row gap-3 mb-4">
              <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <Input
                  placeholder="Buscar por nome do disparo..."
                  className="pl-9"
                  value={searchFilter}
                  onChange={(e) => setSearchFilter(e.target.value)}
                />
              </div>
              <Select value={statusFilter} onValueChange={setStatusFilter}>
                <SelectTrigger className="w-full sm:w-48">
                  <SelectValue placeholder="Filtrar por status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Todos os status</SelectItem>
                  <SelectItem value="scheduled">Agendado</SelectItem>
                  <SelectItem value="running">Em andamento</SelectItem>
                  <SelectItem value="paused">Pausado</SelectItem>
                  <SelectItem value="completed">Concluído</SelectItem>
                  <SelectItem value="cancelled">Cancelado</SelectItem>
                  <SelectItem value="failed">Falhou</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}

          {agendadas.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
              <Calendar className="w-10 h-10 mb-3 opacity-30" />
              <p className="text-sm font-medium">Nenhum disparo agendado ou em andamento</p>
              <p className="text-xs mt-1">Configure um agendamento ao criar um disparo</p>
            </div>
          ) : filteredAgendadas.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
              <Search className="w-10 h-10 mb-3 opacity-30" />
              <p className="text-sm font-medium">Nenhum disparo corresponde aos filtros</p>
              <p className="text-xs mt-1">
                Ajuste a busca ou o status para ver mais resultados.
              </p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Nome do lote</TableHead>
                  <TableHead>Qtd. contatos</TableHead>
                  <TableHead>Template</TableHead>
                  <TableHead>Agendado para</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Ações</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredAgendadas.map((b) => {
                  const status = String(b.status ?? 'scheduled');
                  const total = getNum(b, 'total_contacts', 'totalContacts');
                  const sent = getNum(b, 'sent_count', 'sentCount');
                  const failed = getNum(b, 'failed_count', 'failedCount');
                  const progress = total > 0 ? Math.min(((sent + failed) / total) * 100, 100) : 0;
                  const scheduledAt = getScheduledAt(b);
                  const canPause = status === 'scheduled' || status === 'running';
                  const canResume = status === 'paused';
                  const canCancel = status === 'scheduled' || status === 'running' || status === 'paused';
                  const onRowClick = () => setDetailId(b.id);
                  return (
                    <TableRow
                      key={b.id}
                      className="cursor-pointer hover:bg-muted/40"
                      onClick={onRowClick}
                    >
                      <TableCell className="font-medium">{getBatchName(b)}</TableCell>
                      <TableCell>
                        <div className="flex flex-col gap-1">
                          <span>{total || '—'}</span>
                          {(status === 'running' || status === 'paused') && total > 0 && (
                            <div className="w-24">
                              <Progress value={progress} className="h-1" />
                              <span className="text-[10px] text-muted-foreground">
                                {sent + failed}/{total}
                              </span>
                            </div>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="text-muted-foreground text-xs">{getTemplateName(b)}</TableCell>
                      <TableCell className="text-xs">
                        {scheduledAt
                          ? new Date(scheduledAt).toLocaleString('pt-BR', {
                              dateStyle: 'short',
                              timeStyle: 'short',
                            })
                          : '—'}
                      </TableCell>
                      <TableCell>
                        <Badge variant={statusBadgeVariant(status)} className="text-xs">
                          {statusLabel(status)}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                        <div className="flex items-center justify-end gap-1">
                          {canPause && (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-7 text-xs"
                              onClick={() => mutatePausar.mutate(b.id)}
                              disabled={mutatePausar.isPending}
                              title="Pausar"
                            >
                              <Pause className="w-3 h-3 mr-1" />
                              Pausar
                            </Button>
                          )}
                          {canResume && (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-7 text-xs"
                              onClick={() => mutateRetomar.mutate(b.id)}
                              disabled={mutateRetomar.isPending}
                              title="Retomar"
                            >
                              <Play className="w-3 h-3 mr-1" />
                              Retomar
                            </Button>
                          )}
                          {canCancel && (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="text-destructive hover:text-destructive h-7 text-xs"
                              onClick={() => setCancelingId(b.id)}
                              title="Cancelar"
                            >
                              <XIcon className="w-3 h-3 mr-1" />
                              Cancelar
                            </Button>
                          )}
                          {!canCancel && !canPause && !canResume && (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-7 text-xs"
                              onClick={onRowClick}
                              title="Ver detalhes"
                            >
                              <Eye className="w-3 h-3 mr-1" />
                              Detalhes
                            </Button>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <AlertDialog open={!!cancelingId} onOpenChange={(open) => { if (!open) setCancelingId(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancelar disparo?</AlertDialogTitle>
            <AlertDialogDescription>
              O disparo será cancelado e não será mais executado. Esta ação não pode ser desfeita.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Voltar</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => cancelingId && mutateCancelar.mutate(cancelingId)}
              disabled={mutateCancelar.isPending}
            >
              {mutateCancelar.isPending ? 'Cancelando...' : 'Cancelar disparo'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!detailBatch} onOpenChange={(open) => { if (!open) setDetailId(null); }}>
        <AlertDialogContent className="max-w-lg">
          <AlertDialogHeader>
            <AlertDialogTitle>{detailBatch ? getBatchName(detailBatch) : 'Detalhes'}</AlertDialogTitle>
            <AlertDialogDescription>
              {detailBatch ? `Status: ${statusLabel(String(detailBatch.status))}` : ''}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {detailBatch && (
            <div className="space-y-3 text-sm">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <p className="text-xs text-muted-foreground">Total de contatos</p>
                  <p className="font-medium">{getNum(detailBatch, 'total_contacts', 'totalContacts') || '—'}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Enviados</p>
                  <p className="font-medium">{getNum(detailBatch, 'sent_count', 'sentCount')}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Falhas</p>
                  <p className="font-medium">{getNum(detailBatch, 'failed_count', 'failedCount')}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Template</p>
                  <p className="font-medium truncate">{getTemplateName(detailBatch)}</p>
                </div>
                <div className="col-span-2">
                  <p className="text-xs text-muted-foreground">Agendado para</p>
                  <p className="font-medium">
                    {getScheduledAt(detailBatch)
                      ? new Date(getScheduledAt(detailBatch) as string).toLocaleString('pt-BR', {
                          dateStyle: 'short',
                          timeStyle: 'short',
                        })
                      : '—'}
                  </p>
                </div>
              </div>
              {(() => {
                const t = getNum(detailBatch, 'total_contacts', 'totalContacts');
                const s = getNum(detailBatch, 'sent_count', 'sentCount');
                const f = getNum(detailBatch, 'failed_count', 'failedCount');
                if (t === 0) return null;
                const p = Math.min(((s + f) / t) * 100, 100);
                return (
                  <div className="space-y-1">
                    <div className="flex items-center justify-between text-xs text-muted-foreground">
                      <span>Progresso</span>
                      <span>{Math.round(p)}%</span>
                    </div>
                    <Progress value={p} className="h-2" />
                  </div>
                );
              })()}
            </div>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>Fechar</AlertDialogCancel>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

export default function AdminExtracaoPage() {
  const { account } = useAuth();
  const { toast } = useToast();
  const [leads, setLeads] = useState<ExtractedLead[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [isLoading, setIsLoading] = useState(false);
  const [dispatchOpen, setDispatchOpen] = useState(false);
  const [saveAudienceOpen, setSaveAudienceOpen] = useState(false);
   const [usage, setUsage] = useState<ApiUsage | null>(null);
   
   const fetchUsage = useCallback(async () => {
     if (!account?.id) return;

    try {
      if (useBackend) {
        // Production: Express backend (VPS)
        const res = await apiClient.get<{ success: boolean; used: number; limit: number }>(
          API_ENDPOINTS.PROSPECTING.USAGE
        );
        setUsage({ used: res.used ?? 0, limit: res.limit ?? 500 });
      } else {
        // Lovable Cloud (Supabase) fallback
        const { data: usedCount, error: usageError } = await supabase.rpc(
          'get_monthly_extraction_usage',
          { p_account_id: account.id }
        );
        if (usageError) throw usageError;

        const { data: accountData, error: accountError } = await supabase
          .from('accounts')
          .select('monthly_extraction_limit')
          .eq('id', account.id)
          .single();
        if (accountError) throw accountError;

        setUsage({
          used: usedCount || 0,
          limit: accountData.monthly_extraction_limit || 500,
        });
      }
    } catch (err) {
      console.error('Error fetching extraction usage:', err);
    }
  }, [account?.id]);
 
   useEffect(() => {
     fetchUsage();
   }, [fetchUsage]);
  // BUG-FE Regressão E2E-1: Tabs precisa ser controlado + sincronizado com a
  // URL via ?tab=... pra evitar reset da aba durante invalidate de queries
  // (Pausar/Retomar/Cancelar na aba Agendadas estava jogando o usuário de
  // volta pra Disparos porque a aba não persistia entre remounts).
  const [searchParams, setSearchParams] = useSearchParams();
  const initialTab = searchParams.get('tab') ?? 'extracao';
  const [activeTab, setActiveTab] = useState<string>(initialTab);
  const [activeBatchId, setActiveBatchId] = useState<string | null>(null);
  const [extractionMeta, setExtractionMeta] = useState<{ keyword: string; location: string }>({ keyword: '', location: '' });

  useEffect(() => {
    const t = searchParams.get('tab');
    if (t && t !== activeTab) setActiveTab(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  const handleTabChange = useCallback((value: string) => {
    setActiveTab(value);
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set('tab', value);
      return next;
    }, { replace: true });
  }, [setSearchParams]);

   const handleSearchResults = useCallback(
     (results: ExtractedLead[], apiUsage?: ApiUsage, meta?: { keyword: string; location: string }) => {
       setLeads(results);
       setSelectedIds(new Set(results.map((l) => l.id)));
       // If API usage is returned from the function call, use it, otherwise refresh
       if (apiUsage) {
         setUsage(apiUsage);
       } else {
         fetchUsage();
       }
       if (meta) setExtractionMeta(meta);
     },
     [fetchUsage]
   );

  const handleToggleSelect = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const handleSelectAll = useCallback(() => {
    if (selectedIds.size === leads.length) setSelectedIds(new Set());
    else setSelectedIds(new Set(leads.map((l) => l.id)));
  }, [leads, selectedIds.size]);

  const handleRemoveLead = useCallback((id: string) => {
    setLeads((prev) => prev.filter((l) => l.id !== id));
    setSelectedIds((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }, []);

  const handleExportExcel = useCallback(() => {
    if (leads.length === 0) return;
    const headers = ['Nome', 'Cidade', 'Endereço', 'Telefone', 'Site', 'Avaliação', 'Total Avaliações'];
    const rows = leads.map((l) => [
      l.nome, l.cidade, l.endereco, l.telefone, l.site || '',
      l.avaliacao?.toString() || '', l.total_avaliacoes?.toString() || '',
    ]);
    const csv = [headers.join(';'), ...rows.map((r) => r.join(';'))].join('\n');
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `prospeccao-leads-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    toast({ title: 'Exportação concluída', description: `${leads.length} leads exportados.` });
  }, [leads, toast]);

  const handleDispatchStarted = useCallback((batchId: string) => {
    setActiveBatchId(batchId);
    handleTabChange('disparos');
  }, [handleTabChange]);

   const selectedLeads = leads.filter((l) => selectedIds.has(l.id));
   const usagePercent = usage ? Math.min((usage.used / usage.limit) * 100, 100) : 0;
   const isLimitReached = usage ? usage.used >= usage.limit : false;

  return (
    <div className="p-4 sm:p-6 lg:p-8 space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Prospecção</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Extraia leads do Google Maps e dispare mensagens via WhatsApp
          </p>
        </div>
        {usage && (
          <Card className="w-full sm:w-64">
            <CardContent className="py-3 px-4">
              <div className="flex items-center justify-between text-xs text-muted-foreground mb-1">
                <span>Uso mensal da API</span>
                <span className="font-medium text-foreground">{usage.used}/{usage.limit}</span>
              </div>
              <Progress value={usagePercent} className="h-2" />
            </CardContent>
          </Card>
        )}
      </div>

      <Tabs value={activeTab} onValueChange={handleTabChange} activationMode="manual" className="space-y-4">
        <TabsList className="w-full max-w-3xl sm:grid sm:grid-cols-6">
          <TabsTrigger value="extracao" className="gap-1 text-xs sm:text-sm">
            <Search className="w-4 h-4" /> Extração
          </TabsTrigger>
          <TabsTrigger value="publicos" className="gap-1 text-xs sm:text-sm">
            <Users className="w-4 h-4" /> Públicos
          </TabsTrigger>
          <TabsTrigger value="disparos" className="gap-1 text-xs sm:text-sm">
            <Zap className="w-4 h-4" /> Disparos
          </TabsTrigger>
          <TabsTrigger value="agendadas" className="gap-1 text-xs sm:text-sm">
            <Calendar className="w-4 h-4" /> Agendadas
          </TabsTrigger>
          <TabsTrigger value="dashboard" className="gap-1 text-xs sm:text-sm">
            <BarChart2 className="w-4 h-4" /> Dashboard
          </TabsTrigger>
          {/* T-022 — agregação por campaign_type / source / trigger_name */}
          <TabsTrigger value="tipos" className="gap-1 text-xs sm:text-sm">
            <BarChart2 className="w-4 h-4" /> Tipos
          </TabsTrigger>
        </TabsList>

         <TabsContent value="extracao" className="space-y-4">
           <ExtractionSearchForm
             accountId={account?.id || ''}
             onResults={handleSearchResults}
             isLoading={isLoading}
             setIsLoading={setIsLoading}
             isLimitReached={isLimitReached}
           />
          {leads.length === 0 && !isLoading && (
            <Card>
              <CardContent className="p-0">
                <EmptyState
                  icon={<MapPin className="w-10 h-10" />}
                  title="Faca uma busca para extrair leads"
                  description="Informe a palavra-chave e a localizacao acima para extrair leads do Google Maps. Os resultados aparecerao aqui prontos para selecao e disparo."
                />
              </CardContent>
            </Card>
          )}
          {leads.length > 0 && (
            <>
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                <div className="flex items-center gap-2 flex-wrap">
                  <Badge variant="secondary">{leads.length} leads encontrados</Badge>
                  {selectedLeads.length > 0 && (
                    <Badge variant="outline">{selectedLeads.length} selecionados</Badge>
                  )}
                </div>
                <div className="flex items-center gap-2 flex-wrap">
                  <Button variant="outline" size="sm" onClick={handleExportExcel}>
                    <Download className="w-4 h-4 mr-2" /> Exportar CSV
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setSaveAudienceOpen(true)}
                    disabled={selectedLeads.length === 0}
                  >
                    <Save className="w-4 h-4 mr-2" /> Salvar como público ({selectedLeads.length})
                  </Button>
                  <Button
                    size="sm"
                    onClick={() => setDispatchOpen(true)}
                    disabled={selectedLeads.length === 0}
                  >
                    <Send className="w-4 h-4 mr-2" /> Disparar ({selectedLeads.length})
                  </Button>
                </div>
              </div>
              <ExtractionResultsTable
                leads={leads}
                selectedIds={selectedIds}
                onToggleSelect={handleToggleSelect}
                onSelectAll={handleSelectAll}
                onRemove={handleRemoveLead}
              />
            </>
          )}
        </TabsContent>

        <TabsContent value="publicos" className="space-y-4">
          <SavedAudiencesTab
            accountId={account?.id || ''}
            onDispatchStarted={handleDispatchStarted}
          />
        </TabsContent>

        <TabsContent value="disparos" className="space-y-4">
          <DispatchMonitor accountId={account?.id || ''} activeBatchId={activeBatchId} />
        </TabsContent>

        <TabsContent value="agendadas" className="space-y-4">
          <AgendadasTab accountId={account?.id || ''} />
        </TabsContent>

        <TabsContent value="dashboard" className="space-y-4">
          <CampaignDashboard accountId={account?.id || ''} />
        </TabsContent>

        <TabsContent value="tipos" className="space-y-4">
          <DispatchTypeDashboard accountId={account?.id || ''} />
        </TabsContent>
      </Tabs>

      <DispatchDialog
        open={dispatchOpen}
        onOpenChange={setDispatchOpen}
        leads={selectedLeads}
        accountId={account?.id || ''}
        onDispatchStarted={handleDispatchStarted}
      />

      <SaveAudienceDialog
        open={saveAudienceOpen}
        onOpenChange={setSaveAudienceOpen}
        leads={selectedLeads}
        keyword={extractionMeta.keyword}
        location={extractionMeta.location}
      />
    </div>
  );
}
