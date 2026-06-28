import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Zap, CheckCircle2, XCircle, Clock, Download, ArrowLeft, Phone, StopCircle, Ban, Eye, Search, Filter, X as XIcon,
} from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { useBackend } from '@/config/backend.config';
import { apiClient } from '@/api/client';
import { API_ENDPOINTS } from '@/api/endpoints';
import { useToast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';
import {
  prospectingBackendService,
  type DispatchBatchRow,
  type BatchListFilters,
} from '@/services/prospecting.backend.service';
import {
  extractCampaignType,
  getCampaignTypeMeta,
  getSourceMeta,
} from './campaignTypeLookup';

interface DispatchBatch {
  id: string;
  keyword: string | null;
  location: string | null;
  total_contacts: number;
  sent_count: number;
  failed_count: number;
  status: string;
  delay_seconds: number;
  started_at: string;
  completed_at: string | null;
  // T-022 — novos campos pra cards enriquecidos / filtros
  source: string | null;
  triggerName: string | null;
  campaignType: string | null;
  metadata: Record<string, unknown> | null;
}

interface DispatchLog {
  id: string;
  contact_name: string;
  phone: string;
  inbox_id: number;
  inbox_name: string | null;
  status: string;
  error_message: string | null;
  sent_at: string | null;
}

// Map backend camelCase/snake_case to flat shape do componente. Mantém
// compat com o Supabase legado (snake_case puro) e com o Prisma JSON
// (camelCase). T-022 adiciona source/triggerName/campaignType/metadata.
function normalizeBatch(b: any): DispatchBatch {
  const metadata: Record<string, unknown> | null =
    b.metadata && typeof b.metadata === 'object' ? (b.metadata as Record<string, unknown>) : null;
  return {
    id: b.id,
    keyword: b.keyword ?? null,
    location: b.location ?? null,
    total_contacts: b.total_contacts ?? b.totalContacts ?? 0,
    sent_count: b.sent_count ?? b.sentCount ?? 0,
    failed_count: b.failed_count ?? b.failedCount ?? 0,
    status: b.status,
    delay_seconds: b.delay_seconds ?? b.delaySeconds ?? 30,
    started_at: b.started_at ?? b.startedAt ?? b.created_at ?? b.createdAt ?? new Date().toISOString(),
    completed_at: b.completed_at ?? b.completedAt ?? null,
    source: b.source ?? null,
    triggerName: b.trigger_name ?? b.triggerName ?? null,
    campaignType: extractCampaignType(metadata),
    metadata,
  };
}

function normalizeLog(l: any): DispatchLog {
  return {
    id: l.id,
    contact_name: l.contact_name ?? l.contactName ?? '',
    phone: l.phone,
    inbox_id: l.inbox_id ?? l.inboxId ?? 0,
    inbox_name: l.inbox_name ?? l.inboxName ?? null,
    status: l.status,
    error_message: l.error_message ?? l.errorMessage ?? null,
    sent_at: l.sent_at ?? l.sentAt ?? null,
  };
}

interface Props {
  accountId: string;
  activeBatchId?: string | null;
}

/* ============================================================
 * Filtros UI (estado)
 * ============================================================ */

interface MonitorFilters {
  q: string;
  source: string[];
  status: string[];
  campaignType: string;   // single select
  fromDate: string;
  toDate: string;
}

const EMPTY_FILTERS: MonitorFilters = {
  q: '',
  source: [],
  status: [],
  campaignType: 'all',
  fromDate: '',
  toDate: '',
};

const SOURCE_OPTIONS: { value: string; label: string }[] = [
  { value: 'manual', label: 'Manual' },
  { value: 'manual_scheduled', label: 'Agendado' },
  { value: 'n8n', label: 'n8n' },
  { value: 'api', label: 'API' },
  { value: 'integration', label: 'Integração' },
];

const STATUS_OPTIONS: { value: string; label: string }[] = [
  { value: 'completed', label: 'Concluído' },
  { value: 'cancelled', label: 'Cancelado' },
  { value: 'failed', label: 'Falhou' },
  // running/scheduled/paused ficam na aba Agendadas — não mostramos aqui
  // por default, mas habilitamos no filtro pra quem quiser revisitar.
  { value: 'running', label: 'Em andamento' },
  { value: 'scheduled', label: 'Agendado' },
  { value: 'paused', label: 'Pausado' },
];

function buildBackendFilters(f: MonitorFilters): BatchListFilters {
  const out: BatchListFilters = {};
  if (f.q.trim()) out.q = f.q.trim();
  if (f.source.length > 0) out.source = f.source;
  if (f.status.length > 0) out.status = f.status;
  if (f.campaignType && f.campaignType !== 'all') out.campaignType = [f.campaignType];
  if (f.fromDate) out.fromDate = f.fromDate;
  if (f.toDate) {
    // Inclui o dia inteiro: 23:59:59 do toDate.
    out.toDate = `${f.toDate}T23:59:59.999Z`;
  }
  out.limit = 50;
  return out;
}

function activeFilterCount(f: MonitorFilters): number {
  let n = 0;
  if (f.q.trim()) n += 1;
  if (f.source.length > 0) n += 1;
  if (f.status.length > 0) n += 1;
  if (f.campaignType && f.campaignType !== 'all') n += 1;
  if (f.fromDate) n += 1;
  if (f.toDate) n += 1;
  return n;
}

/* ============================================================
 * Component
 * ============================================================ */

export function DispatchMonitor({ accountId, activeBatchId }: Props) {
  const { toast } = useToast();
  const [filters, setFilters] = useState<MonitorFilters>(EMPTY_FILTERS);
  const [selectedBatch, setSelectedBatch] = useState<DispatchBatch | null>(null);
  // Auto-select roda APENAS uma vez por activeBatchId. Sem essa ref, o polling
  // de 3s re-disparava o auto-select e jogava o usuario de volta pro detalhe
  // mesmo depois dele clicar "Voltar" — bug visual "tela troca sozinha".
  const autoSelectedFor = useRef<string | null>(null);
  const [logs, setLogs] = useState<DispatchLog[]>([]);
  const [cancelling, setCancelling] = useState(false);
  // Fallback Supabase: state local quando NÃO usamos backend Express.
  const [supabaseBatches, setSupabaseBatches] = useState<DispatchBatch[]>([]);
  const [supabaseLoading, setSupabaseLoading] = useState(false);

  /* ---------------------- Query backend (com filtros) ---------------------- */
  const backendFilters = useMemo(() => buildBackendFilters(filters), [filters]);
  const backendBatchesQuery = useQuery<DispatchBatchRow[]>({
    queryKey: ['prospecting-batches', backendFilters],
    queryFn: () => prospectingBackendService.listBatches(backendFilters),
    enabled: !!accountId && useBackend,
    // 3s polling — mesmo intervalo do legado, mas via TanStack Query.
    refetchInterval: selectedBatch ? false : 3000,
    refetchIntervalInBackground: false,
    retry: false,
  });

  const campaignTypesQuery = useQuery<string[]>({
    queryKey: ['prospecting-campaign-types', accountId],
    queryFn: () => prospectingBackendService.getCampaignTypes(),
    enabled: !!accountId && useBackend,
    staleTime: 60_000,
    retry: false,
  });

  /* ---------------------- Fallback Supabase ---------------------- */
  const fetchSupabaseBatches = useCallback(async () => {
    if (!accountId || useBackend) return;
    setSupabaseLoading(true);
    try {
      const { data } = await supabase
        .from('dispatch_batches')
        .select('*')
        .eq('account_id', accountId)
        .order('created_at', { ascending: false })
        .limit(20);
      setSupabaseBatches((data ?? []).map(normalizeBatch));
    } catch (err) {
      console.error('Error loading batches (supabase):', err);
    } finally {
      setSupabaseLoading(false);
    }
  }, [accountId]);

  useEffect(() => {
    if (useBackend) return;
    fetchSupabaseBatches();
  }, [fetchSupabaseBatches]);

  /* ---------------------- Batches normalizados ---------------------- */
  const batches: DispatchBatch[] = useMemo(() => {
    if (useBackend) {
      return (backendBatchesQuery.data ?? []).map(normalizeBatch);
    }
    return supabaseBatches;
  }, [backendBatchesQuery.data, supabaseBatches]);

  const loading = useBackend ? backendBatchesQuery.isLoading : supabaseLoading;

  /* ---------------------- Logs ---------------------- */
  const fetchLogs = useCallback(async (batchId: string) => {
    try {
      if (useBackend) {
        const response = await apiClient.get<any>(API_ENDPOINTS.PROSPECTING.BATCH_LOGS(batchId));
        const data = (response as any).data || response;
        setLogs((Array.isArray(data) ? data : []).map(normalizeLog));
      } else {
        const { data } = await supabase
          .from('dispatch_logs')
          .select('*')
          .eq('batch_id', batchId)
          .order('created_at', { ascending: true });
        if (data) setLogs(data as DispatchLog[]);
      }
    } catch (err) {
      console.error('Error loading logs:', err);
    }
  }, []);

  // Auto-select active batch — APENAS uma vez por activeBatchId.
  // Sem o guard de ref, o polling de 3s re-disparava esse effect e forcava
  // a navegacao pra tela de detalhe mesmo depois do usuario voltar pra lista.
  useEffect(() => {
    if (!activeBatchId || batches.length === 0) return;
    if (autoSelectedFor.current === activeBatchId) return;
    const found = batches.find(b => b.id === activeBatchId);
    if (found) {
      setSelectedBatch(found);
      autoSelectedFor.current = activeBatchId;
    }
  }, [activeBatchId, batches]);

  // Realtime Supabase (somente fallback)
  useEffect(() => {
    if (useBackend || !accountId) return;
    const channel = supabase
      .channel('dispatch-batches-realtime')
      .on('postgres_changes', {
        event: '*',
        schema: 'public',
        table: 'dispatch_batches',
      }, () => {
        // Mais simples: recarrega tudo. Volume é baixo (limit 20).
        fetchSupabaseBatches();
      })
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [accountId, fetchSupabaseBatches]);

  // Poll logs em 3s quando há detalhe selecionado.
  useEffect(() => {
    if (!selectedBatch || !useBackend) return;
    const interval = setInterval(() => {
      fetchLogs(selectedBatch.id);
    }, 3000);
    return () => clearInterval(interval);
  }, [selectedBatch?.id, fetchLogs]);

  // Load logs when batch selected
  useEffect(() => {
    if (!selectedBatch) { setLogs([]); return; }
    fetchLogs(selectedBatch.id);
  }, [selectedBatch?.id, fetchLogs]);

  // DM-1: Resync selectedBatch quando o polling atualiza batches[]. Sem isso,
  // o usuario fica preso na detail view com contadores estaticos (0%/0 enviados)
  // mesmo quando o batch ja avancou no backend — bug "barra nao mexe".
  useEffect(() => {
    if (!selectedBatch) return;
    const updated = batches.find(b => b.id === selectedBatch.id);
    if (!updated) return;
    if (
      updated.status !== selectedBatch.status ||
      updated.sent_count !== selectedBatch.sent_count ||
      updated.failed_count !== selectedBatch.failed_count ||
      updated.total_contacts !== selectedBatch.total_contacts ||
      updated.completed_at !== selectedBatch.completed_at
    ) {
      setSelectedBatch(updated);
    }
  }, [batches, selectedBatch]);

  // Realtime log updates (Supabase only)
  useEffect(() => {
    if (!selectedBatch || useBackend) return;
    const channel = supabase
      .channel('dispatch-logs-realtime')
      .on('postgres_changes', {
        event: '*',
        schema: 'public',
        table: 'dispatch_logs',
        filter: `batch_id=eq.${selectedBatch.id}`,
      }, (payload) => {
        const updated = payload.new as DispatchLog;
        setLogs(prev => {
          const exists = prev.find(l => l.id === updated.id);
          if (exists) return prev.map(l => l.id === updated.id ? updated : l);
          return [...prev, updated];
        });
      })
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [selectedBatch?.id]);

  const handleCancel = async (batchId: string) => {
    setCancelling(true);
    try {
      if (useBackend) {
        const response = await apiClient.post<any>(API_ENDPOINTS.PROSPECTING.CANCEL, { batch_id: batchId });
        const data = (response as any).data || response;
        if (!data?.success) throw new Error('Falha ao cancelar');
      } else {
        const { data, error } = await supabase.functions.invoke('dispatch-messages', {
          body: { action: 'cancel', account_id: accountId, batch_id: batchId },
        });
        if (error) throw error;
        if (!data?.success) throw new Error('Falha ao cancelar');
      }
      toast({ title: 'Disparo cancelado', description: 'Os envios pendentes foram cancelados.' });
      if (useBackend) {
        backendBatchesQuery.refetch();
      } else {
        fetchSupabaseBatches();
      }
      // DM-7: forcar selectedBatch pra 'cancelled' imediatamente.
      setSelectedBatch(prev => (prev && prev.id === batchId ? { ...prev, status: 'cancelled' } : prev));
    } catch (err: any) {
      toast({ title: 'Erro ao cancelar', description: err.message, variant: 'destructive' });
    } finally {
      setCancelling(false);
    }
  };

  const exportReport = () => {
    if (!selectedBatch || logs.length === 0) return;
    const headers = ['Contato', 'Telefone', 'Inbox', 'Status', 'Erro', 'Horário'];
    const rows = logs.map(l => [
      l.contact_name, l.phone, l.inbox_name || '', l.status,
      l.error_message || '', l.sent_at ? new Date(l.sent_at).toLocaleTimeString('pt-BR') : '',
    ]);
    const csv = [headers.join(';'), ...rows.map(r => r.join(';'))].join('\n');
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `disparo-${selectedBatch.id.slice(0, 8)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const getStatusLabel = (status: string) => {
    switch (status) {
      case 'completed': return 'Concluído';
      case 'running': return 'Em andamento';
      case 'scheduled': return 'Agendado';
      case 'paused': return 'Pausado';
      case 'cancelled': return 'Cancelado';
      case 'failed': return 'Falhou';
      default: return status;
    }
  };

  const getStatusVariant = (status: string): 'default' | 'secondary' | 'destructive' | 'outline' => {
    switch (status) {
      case 'completed': return 'default';
      case 'running': return 'secondary';
      case 'scheduled': return 'outline';
      case 'paused': return 'secondary';
      case 'cancelled': return 'outline';
      case 'failed': return 'destructive';
      default: return 'outline';
    }
  };

  const runningBatches = batches.filter(b => b.status === 'running');

  /* ============================================================
   * Detail view
   * ============================================================ */
  if (selectedBatch) {
    const processed = selectedBatch.sent_count + selectedBatch.failed_count;
    const progress = selectedBatch.total_contacts > 0
      ? Math.round((processed / selectedBatch.total_contacts) * 100)
      : 0;
    const sourceMeta = getSourceMeta(selectedBatch.source);
    const campaignTypeMeta = getCampaignTypeMeta(selectedBatch.campaignType);

    return (
      <div className="space-y-4">
        {runningBatches.length > 1 && (
          <Card>
            <CardContent className="py-3">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-xs font-medium text-muted-foreground mr-1">Campanhas ativas:</span>
                {runningBatches.map(b => (
                  <Button
                    key={b.id}
                    variant={b.id === selectedBatch.id ? 'default' : 'outline'}
                    size="sm"
                    className="text-xs h-7"
                    onClick={() => setSelectedBatch(b)}
                  >
                    <Eye className="w-3 h-3 mr-1" />
                    {b.keyword || b.triggerName || 'Campanha'} ({b.sent_count}/{b.total_contacts})
                  </Button>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        <div className="flex items-center justify-between flex-wrap gap-2">
          <Button variant="ghost" size="sm" onClick={() => setSelectedBatch(null)}>
            <ArrowLeft className="w-4 h-4 mr-1" />
            Voltar
          </Button>
          <div className="flex items-center gap-2 flex-wrap">
            <Badge variant={sourceMeta.variant} className={cn('text-xs', sourceMeta.badgeClass)}>
              {sourceMeta.label}
            </Badge>
            <Badge variant="outline" className={cn('text-xs', campaignTypeMeta.badgeClass)}>
              <span className="mr-1">{campaignTypeMeta.icon}</span>
              {campaignTypeMeta.label}
            </Badge>
            <Badge variant={getStatusVariant(selectedBatch.status)}>
              {getStatusLabel(selectedBatch.status)}
            </Badge>
            {selectedBatch.status === 'running' && (
              <Button
                variant="destructive"
                size="sm"
                onClick={() => handleCancel(selectedBatch.id)}
                disabled={cancelling}
              >
                <StopCircle className="w-4 h-4 mr-1" />
                {cancelling ? 'Cancelando...' : 'Parar disparo'}
              </Button>
            )}
            <Button variant="outline" size="sm" onClick={exportReport}>
              <Download className="w-4 h-4 mr-1" />
              Exportar
            </Button>
          </div>
        </div>

        {selectedBatch.triggerName && (
          <div className="text-xs text-muted-foreground font-mono">
            trigger: {selectedBatch.triggerName}
          </div>
        )}

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <Card>
            <CardContent className="pt-4 pb-3">
              <div className="text-2xl font-bold">{selectedBatch.total_contacts}</div>
              <p className="text-xs text-muted-foreground mt-1">
                {selectedBatch.keyword && <span>🔍 {selectedBatch.keyword}</span>}
                {selectedBatch.location && <span> · 📍 {selectedBatch.location}</span>}
                {!selectedBatch.keyword && 'Total de contatos'}
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4 pb-3">
              <div className="text-2xl font-bold text-green-600">{selectedBatch.sent_count}</div>
              <p className="text-xs text-muted-foreground mt-1">✅ com sucesso</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4 pb-3">
              <div className="text-2xl font-bold text-destructive">{selectedBatch.failed_count}</div>
              <p className="text-xs text-muted-foreground mt-1">❌ falha no envio</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4 pb-3">
              <div className="text-xs text-muted-foreground">Número(s) usado(s)</div>
              <div className="text-sm font-medium mt-1 flex items-center gap-1">
                <Phone className="w-3 h-3" />
                {[...new Set(logs.map(l => l.inbox_name).filter(Boolean))].join(', ') || '—'}
              </div>
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardContent className="pt-4 pb-3">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-medium">Progresso do disparo</span>
              <span className="text-sm text-muted-foreground">
                {processed} de {selectedBatch.total_contacts} contatos processados
              </span>
            </div>
            <Progress
              value={progress}
              className={`h-3 ${selectedBatch.status === 'cancelled' ? '[&>div]:bg-muted-foreground' : selectedBatch.failed_count > 0 ? '[&>div]:bg-gradient-to-r [&>div]:from-green-500 [&>div]:to-green-400' : ''}`}
            />
            <div className="flex justify-between mt-1">
              <span className="text-xs text-muted-foreground">{processed}/{selectedBatch.total_contacts} contatos</span>
              <span className="text-xs font-medium">{progress}%</span>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Log de envios em tempo real</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="max-h-80 overflow-y-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Contato</TableHead>
                    <TableHead>Telefone</TableHead>
                    <TableHead>Inbox</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Horário</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {logs.map(log => (
                    <TableRow key={log.id}>
                      <TableCell className="font-medium">{log.contact_name}</TableCell>
                      <TableCell className="text-muted-foreground">{log.phone}</TableCell>
                      <TableCell className="text-xs">{log.inbox_name || '—'}</TableCell>
                      <TableCell>
                        {log.status === 'sent' && (
                          <Badge variant="outline" className="text-green-600 border-green-200 bg-green-50 dark:text-green-400 dark:border-green-900 dark:bg-green-950/30">
                            <CheckCircle2 className="w-3 h-3 mr-1" /> Enviado
                          </Badge>
                        )}
                        {log.status === 'failed' && (
                          <Badge variant="outline" className="text-destructive border-red-200 bg-red-50 dark:border-red-900 dark:bg-red-950/30">
                            <XCircle className="w-3 h-3 mr-1" /> Erro
                          </Badge>
                        )}
                        {log.status === 'pending' && (
                          <Badge variant="outline" className="text-muted-foreground">
                            <Clock className="w-3 h-3 mr-1" /> Aguardando
                          </Badge>
                        )}
                        {log.status === 'cancelled' && (
                          <Badge variant="outline" className="text-muted-foreground border-muted">
                            <Ban className="w-3 h-3 mr-1" /> Cancelado
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-muted-foreground text-xs">
                        {log.sent_at ? new Date(log.sent_at).toLocaleTimeString('pt-BR') : '—'}
                      </TableCell>
                    </TableRow>
                  ))}
                  {logs.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={5} className="text-center text-muted-foreground py-8">
                        Aguardando início dos envios...
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  /* ============================================================
   * Filtros UI
   * ============================================================ */
  const filtersActive = activeFilterCount(filters);

  const toggleArrayFilter = (key: 'source' | 'status', value: string) => {
    setFilters((prev) => {
      const current = new Set(prev[key]);
      if (current.has(value)) current.delete(value);
      else current.add(value);
      return { ...prev, [key]: Array.from(current) };
    });
  };

  const clearFilters = () => setFilters(EMPTY_FILTERS);

  const filtersBar = (
    <Card>
      <CardContent className="py-3 space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative flex-1 min-w-[200px]">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              placeholder="Buscar (keyword, trigger, tipo)..."
              className="pl-9 h-9"
              value={filters.q}
              onChange={(e) => setFilters((p) => ({ ...p, q: e.target.value }))}
            />
          </div>

          {/* Source multi-select */}
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="outline" size="sm" className="h-9">
                <Filter className="w-3.5 h-3.5 mr-1.5" />
                Fonte{filters.source.length > 0 ? ` (${filters.source.length})` : ''}
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-52 p-2">
              <div className="space-y-1.5">
                {SOURCE_OPTIONS.map((opt) => {
                  const checked = filters.source.includes(opt.value);
                  return (
                    <Label
                      key={opt.value}
                      className="flex items-center gap-2 px-2 py-1.5 hover:bg-accent rounded cursor-pointer text-sm font-normal"
                    >
                      <Checkbox
                        checked={checked}
                        onCheckedChange={() => toggleArrayFilter('source', opt.value)}
                      />
                      {opt.label}
                    </Label>
                  );
                })}
              </div>
            </PopoverContent>
          </Popover>

          {/* Status multi-select */}
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="outline" size="sm" className="h-9">
                <Filter className="w-3.5 h-3.5 mr-1.5" />
                Status{filters.status.length > 0 ? ` (${filters.status.length})` : ''}
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-52 p-2">
              <div className="space-y-1.5">
                {STATUS_OPTIONS.map((opt) => {
                  const checked = filters.status.includes(opt.value);
                  return (
                    <Label
                      key={opt.value}
                      className="flex items-center gap-2 px-2 py-1.5 hover:bg-accent rounded cursor-pointer text-sm font-normal"
                    >
                      <Checkbox
                        checked={checked}
                        onCheckedChange={() => toggleArrayFilter('status', opt.value)}
                      />
                      {opt.label}
                    </Label>
                  );
                })}
              </div>
            </PopoverContent>
          </Popover>

          {/* Campaign type select */}
          <Select
            value={filters.campaignType}
            onValueChange={(v) => setFilters((p) => ({ ...p, campaignType: v }))}
          >
            <SelectTrigger className="h-9 w-44">
              <SelectValue placeholder="Tipo de campanha" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todos os tipos</SelectItem>
              {(campaignTypesQuery.data ?? []).map((t) => {
                const meta = getCampaignTypeMeta(t);
                return (
                  <SelectItem key={t} value={t}>
                    {meta.icon} {meta.label}
                  </SelectItem>
                );
              })}
            </SelectContent>
          </Select>

          {/* Date range — usa native date inputs (mais leve que DateRangePicker) */}
          <Input
            type="date"
            className="h-9 w-[145px]"
            value={filters.fromDate}
            onChange={(e) => setFilters((p) => ({ ...p, fromDate: e.target.value }))}
            aria-label="Data inicial"
          />
          <span className="text-xs text-muted-foreground">até</span>
          <Input
            type="date"
            className="h-9 w-[145px]"
            value={filters.toDate}
            onChange={(e) => setFilters((p) => ({ ...p, toDate: e.target.value }))}
            aria-label="Data final"
          />

          {filtersActive > 0 && (
            <Button variant="ghost" size="sm" className="h-9" onClick={clearFilters}>
              <XIcon className="w-3.5 h-3.5 mr-1" />
              Limpar filtros ({filtersActive})
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );

  /* ============================================================
   * Loading / Empty
   * ============================================================ */
  if (loading) {
    return (
      <div className="space-y-3">
        {filtersBar}
        <div className="flex items-center justify-between">
          <Skeleton className="h-6 w-44" />
        </div>
        {[...Array(5)].map((_, i) => (
          <Card key={i}>
            <CardContent className="pt-4 pb-3 space-y-2">
              <div className="flex items-start justify-between">
                <div className="space-y-2 flex-1">
                  <Skeleton className="h-4 w-1/3" />
                  <Skeleton className="h-3 w-1/4" />
                </div>
                <Skeleton className="h-6 w-20 rounded-full" />
              </div>
              <div className="flex items-center gap-3">
                <Skeleton className="h-3 w-20" />
                <Skeleton className="h-3 w-16" />
                <Skeleton className="h-3 w-14" />
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    );
  }

  if (batches.length === 0 && filtersActive === 0) {
    return (
      <div className="space-y-3">
        {filtersBar}
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Histórico de Disparos</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
              <Zap className="w-12 h-12 mb-4 opacity-30" />
              <p className="text-sm font-medium">Nenhum disparo realizado ainda</p>
              <p className="text-xs mt-1">Extraia leads e envie mensagens pela aba Extração</p>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  /* ============================================================
   * Listagem — cards enriquecidos
   * ============================================================ */
  // Quando filtros não estão ativos, escondemos scheduled/paused/running (a aba
  // "Agendadas" cuida deles). Quando filtros estão ativos, respeitamos o que
  // o backend devolver (ex: usuário marcou status=running de propósito).
  const filteredBatches =
    filters.status.length > 0
      ? batches
      : batches.filter((b) => !['scheduled', 'paused'].includes(b.status));

  const visibleRunning = filteredBatches.filter((b) => b.status === 'running');
  const visibleOthers = filteredBatches.filter((b) => b.status !== 'running');

  return (
    <div className="space-y-3">
      {filtersBar}

      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold">Histórico de Disparos</h3>
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="text-xs">
            {filteredBatches.length} disparo{filteredBatches.length === 1 ? '' : 's'}
          </Badge>
          {visibleRunning.length > 0 && (
            <Badge variant="secondary" className="animate-pulse">
              {visibleRunning.length} ativa{visibleRunning.length === 1 ? '' : 's'}
            </Badge>
          )}
        </div>
      </div>

      {filteredBatches.length === 0 && filtersActive > 0 && (
        <Card>
          <CardContent className="py-10 flex flex-col items-center justify-center text-muted-foreground">
            <Search className="w-10 h-10 mb-3 opacity-30" />
            <p className="text-sm font-medium">Nenhum disparo bate com os filtros aplicados</p>
            <Button variant="outline" size="sm" className="mt-3" onClick={clearFilters}>
              Limpar filtros
            </Button>
          </CardContent>
        </Card>
      )}

      {visibleRunning.length > 0 && (
        <div className="space-y-2">
          {visibleRunning.map((batch) => (
            <BatchCard
              key={batch.id}
              batch={batch}
              live
              onSelect={() => setSelectedBatch(batch)}
              onCancel={() => handleCancel(batch.id)}
              cancelling={cancelling}
              getStatusLabel={getStatusLabel}
              getStatusVariant={getStatusVariant}
            />
          ))}
        </div>
      )}

      {visibleOthers.map((batch) => (
        <BatchCard
          key={batch.id}
          batch={batch}
          onSelect={() => setSelectedBatch(batch)}
          getStatusLabel={getStatusLabel}
          getStatusVariant={getStatusVariant}
        />
      ))}
    </div>
  );
}

/* ============================================================
 * BatchCard — header enriquecido (badges source/campaign_type + trigger)
 * ============================================================ */

interface BatchCardProps {
  batch: DispatchBatch;
  live?: boolean;
  onSelect: () => void;
  onCancel?: () => void;
  cancelling?: boolean;
  getStatusLabel: (status: string) => string;
  getStatusVariant: (status: string) => 'default' | 'secondary' | 'destructive' | 'outline';
}

function BatchCard({
  batch,
  live = false,
  onSelect,
  onCancel,
  cancelling,
  getStatusLabel,
  getStatusVariant,
}: BatchCardProps) {
  const sourceMeta = getSourceMeta(batch.source);
  const campaignTypeMeta = getCampaignTypeMeta(batch.campaignType);
  const processed = batch.sent_count + batch.failed_count;
  const progress = batch.total_contacts > 0 ? Math.round((processed / batch.total_contacts) * 100) : 0;
  const title = batch.keyword || batch.triggerName || 'Disparo manual';

  return (
    <Card
      className={cn(
        'cursor-pointer hover:shadow-md transition-shadow',
        live && 'border-primary/30 bg-primary/5'
      )}
      onClick={onSelect}
    >
      <CardContent className="pt-4 pb-3">
        <div className="flex items-start justify-between gap-3 mb-2 flex-wrap">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              {live && (
                <span className="relative flex h-2 w-2 flex-shrink-0">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500" />
                </span>
              )}
              <p className="font-medium text-sm truncate">{title}</p>
              <Badge variant={sourceMeta.variant} className={cn('text-[10px] py-0 h-5', sourceMeta.badgeClass)}>
                {sourceMeta.label}
              </Badge>
              <Badge variant="outline" className={cn('text-[10px] py-0 h-5', campaignTypeMeta.badgeClass)}>
                <span className="mr-1">{campaignTypeMeta.icon}</span>
                {campaignTypeMeta.label}
              </Badge>
            </div>
            <div className="flex items-center gap-2 mt-1 flex-wrap">
              <p className="text-xs text-muted-foreground">
                {live
                  ? `Iniciado ${new Date(batch.started_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`
                  : `${new Date(batch.started_at).toLocaleDateString('pt-BR')} ${new Date(batch.started_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`}
              </p>
              {batch.location && (
                <p className="text-xs text-muted-foreground">📍 {batch.location}</p>
              )}
              {batch.triggerName && (
                <span className="text-[10px] font-mono text-muted-foreground bg-muted/40 px-1.5 py-0.5 rounded">
                  trigger: {batch.triggerName}
                </span>
              )}
            </div>
          </div>
          <div
            className="flex items-center gap-2 flex-shrink-0"
            onClick={(e) => e.stopPropagation()}
            onPointerDown={(e) => e.stopPropagation()}
          >
            <Badge variant={live ? 'secondary' : getStatusVariant(batch.status)}>
              {live ? 'Em andamento' : getStatusLabel(batch.status)}
            </Badge>
            {live && onCancel && (
              <Button
                variant="destructive"
                size="sm"
                className="h-7 text-xs"
                onClick={(e) => { e.stopPropagation(); onCancel(); }}
                disabled={cancelling}
              >
                <StopCircle className="w-3 h-3 mr-1" /> Parar
              </Button>
            )}
          </div>
        </div>
        <div className="flex items-center gap-4 text-xs mb-2 flex-wrap">
          <span className="text-muted-foreground">
            <strong className="text-foreground">{batch.total_contacts}</strong> contatos
          </span>
          <span className="text-green-600 font-medium">{batch.sent_count} enviados</span>
          {batch.failed_count > 0 && (
            <span className="text-destructive font-medium">{batch.failed_count} falhas</span>
          )}
        </div>
        {live && <Progress value={progress} className="h-1.5" />}
      </CardContent>
    </Card>
  );
}
