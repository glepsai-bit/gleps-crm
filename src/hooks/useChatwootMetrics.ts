import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { useAuth } from '@/contexts/AuthContext';
import { useBackend } from '@/config/backend.config';
import { hasChatwootConfig } from '@/utils/chatwootConfig';
import { supabase } from '@/integrations/supabase/client';
import { apiClient } from '@/api/client';
import { API_ENDPOINTS } from '@/api/endpoints';
import type { AtendimentoMetrics, ResolucaoMetrics, TaxasMetrics, TransbordoMetrics } from '@/types/chatwoot-metrics';

export interface DashboardMetrics {
  totalLeads: number;
  conversasAtivas: number;
  retornosNoPeriodo: number;
  conversasResolvidas: number;
  conversasPendentes: number;
  conversasSemResposta: number;

  // CAMADA 1: Atendimento em tempo real
  atendimento: AtendimentoMetrics;
  
  // CAMADA 2: Resolução (histórico)
  resolucao: ResolucaoMetrics;
  
  // Taxas calculadas
  taxas: TaxasMetrics;
  
  // Transbordo detalhado
  transbordo: TransbordoMetrics;

  // Contagens absolutas (retrocompatibilidade)
  atendimentosIA?: number;
  atendimentosHumano?: number;
  atendimentosClassificados?: number;

  percentualIA: number;
  percentualHumano: number;
  tempoMedioPrimeiraResposta: string;
  tempoMedioResolucao: string;
  taxaTransbordo: string;
  conversasPorCanal: Array<{
    inboxId: number;
    canal: string;
    inboxName: string;
    totalConversas: number;
  }>;
  picoPorHora: Array<{
    hora: number;
    totalConversas: number;
  }>;
  backlog: {
    ate15min: number;
    de15a60min: number;
    acima60min: number;
  };
  agentes: Array<{
    agentId: number;
    agentName: string;
    agentEmail: string;
    thumbnail?: string;
    atendimentosAssumidos: number;
    atendimentosResolvidos: number;
    tempoMedioResposta: string;
    taxaResolucao: number;
  }>;
  qualidade: {
    conversasSemResposta: number;
    taxaAtendimentoVenda: string;
  };
}

interface UseChatwootMetricsParams {
  dateFrom: Date;
  dateTo: Date;
  inboxId?: number;
  agentId?: number;
  pollingInterval?: number;
  enablePolling?: boolean;
}

interface UseChatwootMetricsResult {
  data: DashboardMetrics | null;
  isLoading: boolean;
  isSyncing: boolean;
  lastSyncAt: string | null;
  isTabActive: boolean;
  error: string | null;
  isConfigured: boolean;
  refetch: () => void;
}

const DEFAULT_METRICS: DashboardMetrics = {
  totalLeads: 0,
  conversasAtivas: 0,
  retornosNoPeriodo: 0,
  conversasResolvidas: 0,
  conversasPendentes: 0,
  conversasSemResposta: 0,
  // CAMADA 1: Atendimento em tempo real
  atendimento: {
    total: 0,
    ia: 0,
    humano: 0,
    semAssignee: 0,
  },
  // CAMADA 2: Resolução
  resolucao: {
    total: 0,
    ia: { total: 0, explicito: 0, botNativo: 0, inferido: 0 },
    humano: { total: 0, explicito: 0, inferido: 0 },
    naoClassificado: 0,
    transbordoFinalizado: 0,
  },
  // Taxas
  taxas: {
    resolucaoIA: '0%',
    resolucaoHumano: '0%',
    transbordo: '0%',
    eficienciaIA: '0%',
  },
  // Transbordo
  transbordo: {
    total: 0,
    iniciadasPorIA: 0,
    taxa: '0%',
  },
  // Retrocompatibilidade
  atendimentosIA: 0,
  atendimentosHumano: 0,
  atendimentosClassificados: 0,
  percentualIA: 0,
  percentualHumano: 0,
  tempoMedioPrimeiraResposta: '0s',
  tempoMedioResolucao: '0s',
  taxaTransbordo: '0%',
  conversasPorCanal: [],
  picoPorHora: [],
  backlog: { ate15min: 0, de15a60min: 0, acima60min: 0 },
  agentes: [],
  qualidade: { conversasSemResposta: 0, taxaAtendimentoVenda: '0%' },
};

const DEFAULT_POLLING_INTERVAL = 30000; // 30 seconds

async function fetchChatwootMetricsViaBackend(
  dateFrom: Date,
  dateTo: Date,
  inboxId?: number,
  agentId?: number,
): Promise<DashboardMetrics> {
  try {
    const response = await apiClient.post<{ success: boolean; data: DashboardMetrics; error?: string; chatwootFetchHealthy?: boolean }>(
      API_ENDPOINTS.CHATWOOT.METRICS,
      {
        dateFrom: dateFrom.toISOString(),
        dateTo: dateTo.toISOString(),
        inboxId,
        agentId,
      }
    );
    if ((response as any).success && (response as any).data) {
      return (response as any).data as DashboardMetrics;
    }
    // If the response itself is the metrics data
    return response as unknown as DashboardMetrics;
  } catch (err: any) {
    // Check if this is a Chatwoot integration error (502)
    const errorMsg = err?.message || 'Erro ao carregar métricas';
    const isChatwootDown = err?.status === 502;
    const error = new Error(
      isChatwootDown
        ? `Integração Chatwoot indisponível: ${errorMsg}`
        : errorMsg
    );
    (error as any).isChatwootIntegrationError = isChatwootDown;
    throw error;
  }
}

async function fetchChatwootMetrics(
  account: {
    id?: string;
    chatwoot_base_url?: string | null;
    chatwoot_account_id?: string | null;
    chatwoot_api_key?: string | null;
  },
  dateFrom: Date,
  dateTo: Date,
  inboxId?: number,
  agentId?: number,
  signal?: AbortSignal
): Promise<DashboardMetrics> {
  const { data: { session } } = await supabase.auth.getSession();
  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
  const supabaseKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

  console.log('[useChatwootMetrics] Fetching metrics...', {
    online: typeof navigator !== 'undefined' ? navigator.onLine : true,
    dateFrom: dateFrom.toISOString(),
    dateTo: dateTo.toISOString(),
    inboxId,
    agentId,
  });

  const response = await fetch(`${supabaseUrl}/functions/v1/fetch-chatwoot-metrics`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': session?.access_token
        ? `Bearer ${session.access_token}`
        : `Bearer ${supabaseKey}`,
      'apikey': supabaseKey,
    },
    body: JSON.stringify({
      baseUrl: account.chatwoot_base_url,
      accountId: account.chatwoot_account_id,
      apiKey: account.chatwoot_api_key,
      dbAccountId: account.id,
      dateFrom: dateFrom.toISOString(),
      dateTo: dateTo.toISOString(),
      inboxId,
      agentId,
    }),
    signal,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`HTTP ${response.status}: ${errorText}`);
  }

  const result = await response.json();
  
  if (result.success && result.data) {
    return result.data as DashboardMetrics;
  }

  throw new Error(result.error || 'Erro ao carregar métricas');
}

export function useChatwootMetrics({
  dateFrom,
  dateTo,
  inboxId,
  agentId,
  pollingInterval = DEFAULT_POLLING_INTERVAL,
  enablePolling = true,
}: UseChatwootMetricsParams): UseChatwootMetricsResult {
  const { account } = useAuth();

  const isConfigured = hasChatwootConfig(account);

  const query = useQuery({
    queryKey: [
      'chatwoot-metrics',
      account?.id,
      dateFrom.toISOString(),
      dateTo.toISOString(),
      inboxId,
      agentId,
    ],
    queryFn: async ({ signal }) => {
      if (!account || !isConfigured) {
        return DEFAULT_METRICS;
      }
      if (useBackend) {
        return fetchChatwootMetricsViaBackend(dateFrom, dateTo, inboxId, agentId);
      }
      return fetchChatwootMetrics(account, dateFrom, dateTo, inboxId, agentId, signal);
    },
    enabled: isConfigured,
    
    // Polling: atualiza a cada 30s quando aba está ativa
    refetchInterval: enablePolling ? pollingInterval : false,
    refetchIntervalInBackground: false, // Pausa quando aba está inativa
    
    // Cache: dados considerados frescos por 25s (evita refetch imediato ao voltar na aba)
    staleTime: 25000,
    gcTime: 5 * 60 * 1000, // 5 minutos
    
    // Retry: skip auth errors (401/403), retry transient errors up to 3x
    retry: (failureCount, error: any) => {
      if (error?.status === 401 || error?.status === 403) return false;
      return failureCount < 3;
    },
    retryDelay: (attemptIndex) => {
      const baseDelay = Math.min(1000 * 2 ** attemptIndex, 10000);
      const jitter = Math.floor(Math.random() * 500);
      return baseDelay + jitter;
    },
    
    // Mantém dados anteriores enquanto faz refetch (evita flash de loading)
    placeholderData: keepPreviousData,
  });

  // Mapear estados do TanStack Query para interface existente
  const isLoading = isConfigured ? query.isPending : false;
  const isSyncing = query.isFetching && !query.isPending;
  const lastSyncAt = query.dataUpdatedAt 
    ? new Date(query.dataUpdatedAt).toISOString() 
    : null;
  
  // Extrair mensagem de erro formatada
  let errorMessage: string | null = null;
  let isChatwootIntegrationError = false;
  if (query.error) {
    const rawMsg = String(query.error?.message || '');
    const rawMsgLower = rawMsg.toLowerCase();
    const online = typeof navigator !== 'undefined' ? navigator.onLine : true;
    isChatwootIntegrationError = !!(query.error as any)?.isChatwootIntegrationError;
    
    if (query.error.name === 'AbortError') {
      errorMessage = 'Timeout ao buscar métricas. O Chatwoot pode estar lento.';
    } else if (!online) {
      errorMessage = 'Sem conexão com a internet.';
    } else if (isChatwootIntegrationError) {
      errorMessage = rawMsg;
    } else if (rawMsgLower.includes('failed to fetch') || rawMsgLower.includes('networkerror')) {
      errorMessage = 'Falha de conexão ao buscar métricas. Tente novamente em alguns segundos.';
    } else {
      errorMessage = rawMsg || 'Erro de conexão';
    }
    
    console.error('[useChatwootMetrics] Error:', query.error);
  }

  return {
    data: query.data ?? DEFAULT_METRICS,
    isLoading,
    isSyncing,
    lastSyncAt,
    isTabActive: true, // TanStack Query gerencia automaticamente via refetchIntervalInBackground
    error: errorMessage,
    isConfigured,
    refetch: query.refetch,
  };
}
