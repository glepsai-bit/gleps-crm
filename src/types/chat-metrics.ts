/**
 * Tipos para metricas do chat interno (FitPark — T-022; REMOVED legacy types).
 *
 * Espelham a forma esperada pelos cards do AdminDashboard. O backend agora é
 * o proprio servico chat-metrics (chatMetricsBackendService) — estes tipos
 * descrevem o shape consumido pela UI, NAO o payload da API.
 */

export interface AtendimentoMetrics {
  total: number;       // Total de conversas abertas
  ia: number;          // Sendo atendidas por IA agora
  humano: number;      // Sendo atendidas por humanos agora
  semAssignee: number; // Em aberto sem assignee humano nem bot
}

export interface ResolucaoMetrics {
  total: number;
  ia: {
    total: number;
    explicito: number;
    botNativo: number;
    inferido: number;
  };
  humano: {
    total: number;
    explicito: number;
    inferido: number;
  };
  naoClassificado: number;
  transbordoFinalizado: number;
}

export interface TaxasMetrics {
  resolucaoIA: string;
  resolucaoHumano: string;
  transbordo: string;
  eficienciaIA: string;
}

export interface AgentPerformanceMetrics {
  agentId: string;
  agentName: string;
  atendimentosAssumidos: number;
  atendimentosResolvidos: number;
  tempoMedioResposta: string;
  taxaResolucao: number | string;
}

export interface QualityMetrics {
  conversasSemResposta: number;
  taxaAtendimentoVenda: string;
}
