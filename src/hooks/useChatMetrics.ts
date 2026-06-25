/**
 * useChatMetrics — hook de metricas de chat/atendimento.
 *
 * Consome o endpoint interno GET /api/chat/metrics (chat-metrics.backend.service)
 * que agrega Conversation/Message/SLABreach no Postgres local. REMOVED upstream
 * dependency. Mantém apenas as métricas que o backend novo realmente expoe.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import {
  chatMetricsBackendService,
  type ChatMetricsResult,
} from '@/services/chat-metrics.backend.service';

export interface UseChatMetricsParams {
  dateFrom: Date;
  dateTo: Date;
  inboxId?: string;
  enablePolling?: boolean;
  pollingInterval?: number;
}

export interface DashboardAgentRow {
  agentName: string;
  atendimentosAssumidos: number;
  atendimentosResolvidos: number;
  tempoMedioResposta: string;
  taxaResolucao: number;
}

export interface DashboardMetricsData {
  totalLeads: number;
  conversasAtivas: number;
  retornosNoPeriodo: number;
  atendimentosIA: number;
  atendimentosHumano: number;
  atendimentosClassificados: number;
  percentualIA: number;
  percentualHumano: number;
  tempoMedioPrimeiraResposta: string;
  tempoMedioResolucao: string;
  taxaTransbordo: string;
  atendimento: {
    total: number;
    ia: number;
    humano: number;
    semAssignee: number;
  };
  resolucao: {
    total: number;
    ia: { total: number; explicito: number; botNativo: number; inferido: number };
    humano: { total: number; explicito: number; inferido: number };
    naoClassificado: number;
    transbordoFinalizado: number;
  };
  taxas: {
    resolucaoIA: string;
    resolucaoHumano: string;
    transbordo: string;
    eficienciaIA: string;
  };
  picoPorHora: Array<{ hora: number; totalConversas: number }>;
  backlog: { ate15min: number; de15a60min: number; acima60min: number };
  qualidade: { conversasSemResposta: number; taxaAtendimentoVenda: string };
  agentes: DashboardAgentRow[];
}

function fmtMin(min: number | null): string {
  if (min === null || Number.isNaN(min)) return '—';
  if (min < 1) return `${Math.round(min * 60)}s`;
  if (min < 60) return `${Math.round(min)}min`;
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return m > 0 ? `${h}h${m}min` : `${h}h`;
}

function adaptResult(r: ChatMetricsResult): DashboardMetricsData {
  const total = r.totalConversations || 0;
  const resolved = r.resolvedConversations || 0;
  const open = r.openConversations || 0;
  const iaTotal = r.resolvedByAi || 0;
  const humanTotal = r.resolvedByHuman || 0;
  const classificadas = iaTotal + humanTotal;
  const percentIA = classificadas > 0 ? Math.round((iaTotal / classificadas) * 100) : 0;
  const percentHumano = classificadas > 0 ? 100 - percentIA : 0;

  const agentes: DashboardAgentRow[] = r.byAgent.map((a) => ({
    agentName: a.agentName,
    atendimentosAssumidos: a.total,
    atendimentosResolvidos: a.resolved,
    tempoMedioResposta: fmtMin(a.avgFirstResponseMin),
    taxaResolucao:
      a.total > 0 ? Math.round((a.resolved / a.total) * 100) : 0,
  }));

  return {
    totalLeads: total,
    conversasAtivas: open,
    retornosNoPeriodo: 0,
    atendimentosIA: iaTotal,
    atendimentosHumano: humanTotal,
    atendimentosClassificados: classificadas,
    percentualIA: percentIA,
    percentualHumano: percentHumano,
    tempoMedioPrimeiraResposta: fmtMin(r.avgFirstResponseMin),
    tempoMedioResolucao: fmtMin(r.avgResolutionMin),
    taxaTransbordo: '0%',
    atendimento: {
      total: open,
      ia: 0,
      humano: 0,
      semAssignee: open,
    },
    resolucao: {
      total: resolved,
      ia: { total: iaTotal, explicito: iaTotal, botNativo: 0, inferido: 0 },
      humano: { total: humanTotal, explicito: humanTotal, inferido: 0 },
      naoClassificado: Math.max(resolved - classificadas, 0),
      transbordoFinalizado: 0,
    },
    taxas: {
      resolucaoIA: `${percentIA}%`,
      resolucaoHumano: `${percentHumano}%`,
      transbordo: '0%',
      eficienciaIA: total > 0 ? `${Math.round((iaTotal / total) * 100)}%` : '0%',
    },
    picoPorHora: [],
    backlog: { ate15min: 0, de15a60min: 0, acima60min: 0 },
    qualidade: { conversasSemResposta: 0, taxaAtendimentoVenda: '0%' },
    agentes,
  };
}

export function useChatMetrics(params: UseChatMetricsParams) {
  const { account } = useAuth();
  const [data, setData] = useState<DashboardMetricsData | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [lastSyncAt, setLastSyncAt] = useState<string | null>(null);
  const [isTabActive, setIsTabActive] = useState<boolean>(
    typeof document !== 'undefined' ? document.visibilityState === 'visible' : true
  );
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const isConfigured = Boolean(account?.id);

  const fetchOnce = useCallback(
    async (silent = false) => {
      if (!isConfigured) return;
      if (silent) setIsSyncing(true);
      else setIsLoading(true);
      try {
        const result = await chatMetricsBackendService.getChatMetrics({
          fromDate: params.dateFrom,
          toDate: params.dateTo,
          inboxId: params.inboxId,
        });
        setData(adaptResult(result));
        setLastSyncAt(new Date().toISOString());
        setError(null);
      } catch (err: any) {
        setError(err?.message || 'Erro ao carregar métricas');
      } finally {
        if (silent) setIsSyncing(false);
        else setIsLoading(false);
      }
    },
    [isConfigured, params.dateFrom, params.dateTo, params.inboxId]
  );

  useEffect(() => {
    void fetchOnce(false);
  }, [fetchOnce]);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    const handler = () => setIsTabActive(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', handler);
    return () => document.removeEventListener('visibilitychange', handler);
  }, []);

  useEffect(() => {
    if (!params.enablePolling || !isConfigured) return;
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(() => {
      if (isTabActive) void fetchOnce(true);
    }, params.pollingInterval ?? 30000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [params.enablePolling, params.pollingInterval, isConfigured, isTabActive, fetchOnce]);

  const refetch = useCallback(() => fetchOnce(true), [fetchOnce]);

  return useMemo(
    () => ({
      data,
      isLoading,
      isSyncing,
      lastSyncAt,
      isTabActive,
      error,
      isConfigured,
      refetch,
    }),
    [data, isLoading, isSyncing, lastSyncAt, isTabActive, error, isConfigured, refetch]
  );
}

export default useChatMetrics;
