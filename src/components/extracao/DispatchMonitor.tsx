import { useState, useEffect, useCallback, useRef } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Skeleton } from '@/components/ui/skeleton';
import { Zap, CheckCircle2, XCircle, Clock, Download, ArrowLeft, Phone, StopCircle, Ban, Eye } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { useBackend } from '@/config/backend.config';
import { apiClient } from '@/api/client';
import { API_ENDPOINTS } from '@/api/endpoints';
import { useToast } from '@/hooks/use-toast';

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

// Map backend camelCase to snake_case for consistency
function normalizeBatch(b: any): DispatchBatch {
  return {
    id: b.id,
    keyword: b.keyword ?? null,
    location: b.location ?? null,
    total_contacts: b.total_contacts ?? b.totalContacts ?? 0,
    sent_count: b.sent_count ?? b.sentCount ?? 0,
    failed_count: b.failed_count ?? b.failedCount ?? 0,
    status: b.status,
    delay_seconds: b.delay_seconds ?? b.delaySeconds ?? 30,
    started_at: b.started_at ?? b.startedAt,
    completed_at: b.completed_at ?? b.completedAt ?? null,
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

export function DispatchMonitor({ accountId, activeBatchId }: Props) {
  const { toast } = useToast();
  const [batches, setBatches] = useState<DispatchBatch[]>([]);
  const [selectedBatch, setSelectedBatch] = useState<DispatchBatch | null>(null);
  // Auto-select roda APENAS uma vez por activeBatchId. Sem essa ref, o polling
  // de 3s re-disparava o auto-select e jogava o usuario de volta pro detalhe
  // mesmo depois dele clicar "Voltar" — bug visual "tela troca sozinha".
  const autoSelectedFor = useRef<string | null>(null);
  const [logs, setLogs] = useState<DispatchLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [cancelling, setCancelling] = useState(false);
  // NOTA: Retomar/pausar batches agora eh EXCLUSIVAMENTE pela aba "Agendadas"
  // (AgendadasTab + novo state machine), que preserva a mensagem ORIGINAL da
  // campanha. O handleResume legado daqui enviava texto hard-coded ('Ola {nome},
  // tudo bem?'), trocando o conteudo da campanha por algo totalmente diferente
  // — bug LGPD/marca (DM-9 / L3-001). Por isso o estado/botoes foram removidos.

  const fetchBatches = useCallback(async () => {
    if (!accountId) { setLoading(false); return; }
    try {
      if (useBackend) {
        const response = await apiClient.get<any>(API_ENDPOINTS.PROSPECTING.BATCHES);
        const data = (response as any).data || response;
        setBatches((Array.isArray(data) ? data : []).map(normalizeBatch));
      } else {
        const { data } = await supabase
          .from('dispatch_batches')
          .select('*')
          .eq('account_id', accountId)
          .order('created_at', { ascending: false })
          .limit(20);
        if (data) setBatches(data as DispatchBatch[]);
      }
    } catch (err) {
      console.error('Error loading batches:', err);
    } finally {
      setLoading(false);
    }
  }, [accountId]);

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

  // Load batches
  useEffect(() => {
    setLoading(true);
    fetchBatches();
  }, [fetchBatches]);

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

  // Realtime or polling for batch updates
  useEffect(() => {
    if (!accountId) return;

    if (useBackend) {
      // Poll every 3 seconds when there are running batches
      const interval = setInterval(() => {
        fetchBatches();
        if (selectedBatch) fetchLogs(selectedBatch.id);
      }, 3000);
      return () => clearInterval(interval);
    } else {
      const channel = supabase
        .channel('dispatch-batches-realtime')
        .on('postgres_changes', {
          event: '*',
          schema: 'public',
          table: 'dispatch_batches',
        }, (payload) => {
          const updated = payload.new as DispatchBatch;
          setBatches(prev => {
            const exists = prev.find(b => b.id === updated.id);
            if (exists) return prev.map(b => b.id === updated.id ? updated : b);
            return [updated, ...prev];
          });
          if (selectedBatch?.id === updated.id) setSelectedBatch(updated);
        })
        .subscribe();
      return () => { supabase.removeChannel(channel); };
    }
  }, [accountId, selectedBatch?.id, fetchBatches, fetchLogs]);

  // Load logs when batch selected
  useEffect(() => {
    if (!selectedBatch) { setLogs([]); return; }
    fetchLogs(selectedBatch.id);
  }, [selectedBatch?.id, fetchLogs]);

  // DM-1: Resync selectedBatch quando o polling atualiza batches[]. Sem isso,
  // o usuario fica preso na detail view com contadores estaticos (0%/0 enviados)
  // mesmo quando o batch ja avancou no backend — bug "barra nao mexe".
  // Comparamos campos relevantes pra evitar setState desnecessario em ref nova.
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
      await fetchBatches();
      // DM-7: forcar selectedBatch pra 'cancelled' imediatamente. Sem isso, o
      // status local segue 'running' ate o proximo polling (3s) e o botao "Parar
      // disparo" continua visivel/clicavel — UX confusa e potencial double-cancel.
      // O useEffect de resync (acima) tambem cobre, mas aqui garantimos o estado
      // certo na hora pro caso de a request de cancel ainda nao ter refletido
      // no GET de batches (race).
      setSelectedBatch(prev => (prev && prev.id === batchId ? { ...prev, status: 'cancelled' } : prev));
    } catch (err: any) {
      toast({ title: 'Erro ao cancelar', description: err.message, variant: 'destructive' });
    } finally {
      setCancelling(false);
    }
  };

  // handleResume removido — ver nota no useState acima. Use a aba "Agendadas".

  const exportReport = () => {
    if (!selectedBatch || logs.length === 0) return;
    const headers = ['Contato', 'Telefone', 'Inbox', 'Status', 'Erro', 'Horário'];
    const rows = logs.map(l => [
      l.contact_name, l.phone, l.inbox_name || '', l.status,
      l.error_message || '', l.sent_at ? new Date(l.sent_at).toLocaleTimeString('pt-BR') : '',
    ]);
    const csv = [headers.join(';'), ...rows.map(r => r.join(';'))].join('\n');
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
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
      // Nao mascarar status novos como "Falhou" — antes o default mostrava
      // badge destructive vermelho em qualquer status desconhecido (ex: scheduled
      // aparecia como "Falhou" na aba Disparos).
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

  // Detail view
  if (selectedBatch) {
    const processed = selectedBatch.sent_count + selectedBatch.failed_count;
    const progress = selectedBatch.total_contacts > 0
      ? Math.round((processed / selectedBatch.total_contacts) * 100)
      : 0;

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
                    {b.keyword || 'Campanha'} ({b.sent_count}/{b.total_contacts})
                  </Button>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        <div className="flex items-center justify-between">
          <Button variant="ghost" size="sm" onClick={() => setSelectedBatch(null)}>
            <ArrowLeft className="w-4 h-4 mr-1" />
            Voltar
          </Button>
          <div className="flex items-center gap-2">
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
            {/* Botao "Retomar disparo" removido — DM-9/L3-001: o handleResume
                legado enviava mensagem hard-coded e quebrava a campanha original.
                Use a aba "Agendadas" para retomar/pausar com mensagem preservada. */}
            <Button variant="outline" size="sm" onClick={exportReport}>
              <Download className="w-4 h-4 mr-1" />
              Exportar
            </Button>
          </div>
        </div>

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

  // Batch history list
  if (loading) {
    // C2 — Skeleton cards (5) substituem o spinner "Carregando histórico..."
    // pra dar feedback concreto de estrutura, não só atividade.
    return (
      <div className="space-y-3">
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

  if (batches.length === 0) {
    return (
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
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold">Histórico de Disparos</h3>
        {runningBatches.length > 0 && (
          <Badge variant="secondary" className="animate-pulse">
            {runningBatches.length} campanha(s) ativa(s)
          </Badge>
        )}
      </div>

      {runningBatches.length > 0 && (
        <div className="space-y-2">
          {runningBatches.map(batch => {
            const processed = batch.sent_count + batch.failed_count;
            const progress = batch.total_contacts > 0 ? Math.round((processed / batch.total_contacts) * 100) : 0;
            return (
              <Card
                key={batch.id}
                className="border-primary/30 bg-primary/5 cursor-pointer hover:shadow-md transition-shadow"
                onClick={() => setSelectedBatch(batch)}
              >
                <CardContent className="pt-4 pb-3">
                  <div className="flex items-start justify-between mb-2">
                    <div>
                      <p className="font-medium text-sm flex items-center gap-2">
                        <span className="relative flex h-2 w-2">
                          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
                          <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500" />
                        </span>
                        {batch.keyword || 'Disparo manual'}
                        {batch.location && <span className="text-muted-foreground"> · 📍 {batch.location}</span>}
                      </p>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        Iniciado {new Date(batch.started_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}
                      </p>
                    </div>
                    <div
                      className="flex items-center gap-2"
                      onClick={(e) => e.stopPropagation()}
                      onPointerDown={(e) => e.stopPropagation()}
                    >
                      <Badge variant="secondary">Em andamento</Badge>
                      <Button
                        variant="destructive"
                        size="sm"
                        className="h-7 text-xs"
                        onClick={(e) => { e.stopPropagation(); handleCancel(batch.id); }}
                        disabled={cancelling}
                      >
                        <StopCircle className="w-3 h-3 mr-1" /> Parar
                      </Button>
                    </div>
                  </div>
                  <div className="flex items-center gap-4 text-xs mb-2">
                    <span className="text-green-600 font-medium">{batch.sent_count} enviados</span>
                    {batch.failed_count > 0 && <span className="text-destructive font-medium">{batch.failed_count} erros</span>}
                    <span className="text-muted-foreground">{batch.total_contacts} total</span>
                  </div>
                  <Progress value={progress} className="h-1.5" />
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/* Esconder scheduled/paused — esses estados pertencem a aba "Agendadas".
          Sem esse filtro, agendamentos futuros aparecem na aba "Disparos" e
          (com o fix de label/variant acima) ainda ficam visualmente duplicados. */}
      {batches.filter(b => !['running', 'scheduled', 'paused'].includes(b.status)).map(batch => (
        <Card
          key={batch.id}
          className="cursor-pointer hover:shadow-md transition-shadow"
          onClick={() => setSelectedBatch(batch)}
        >
          <CardContent className="pt-4 pb-3">
            <div className="flex items-start justify-between mb-2">
              <div>
                <p className="font-medium text-sm">
                  {batch.keyword || 'Disparo manual'}
                  {batch.location && <span className="text-muted-foreground"> · 📍 {batch.location}</span>}
                </p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {new Date(batch.started_at).toLocaleDateString('pt-BR')} {new Date(batch.started_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}
                </p>
              </div>
              <div
                className="flex items-center gap-2"
                onClick={(e) => e.stopPropagation()}
                onPointerDown={(e) => e.stopPropagation()}
              >
                <Badge variant={getStatusVariant(batch.status)}>
                  {getStatusLabel(batch.status)}
                </Badge>
                {/* Botao "Retomar" removido — ver nota em handleResume/useState. */}
              </div>
            </div>
            <div className="flex items-center gap-4 text-xs">
              <span className="text-green-600 font-medium">{batch.sent_count} enviados</span>
              {batch.failed_count > 0 && <span className="text-destructive font-medium">{batch.failed_count} erros</span>}
              <span className="text-muted-foreground">{batch.total_contacts} total</span>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
