/**
 * TIPOS PARA MÉTRICAS DO CHATWOOT
 * 
 * Interfaces que espelham a estrutura esperada da API do Chatwoot
 * para facilitar a integração futura com o backend real.
 */

/**
 * Inbox (Canal) do Chatwoot
 * Representa um canal de atendimento configurado na conta
 * 
 * Endpoint: GET /api/v1/accounts/{id}/inboxes
 */
export interface ChatwootInbox {
  id: number;
  name: string;
  channel_type: 'Channel::Whatsapp' | 'Channel::FacebookPage' | 'Channel::WebWidget' | 'Channel::Instagram' | string;
  avatar_url?: string;
  // Mapeamento interno para nosso tipo Channel
  mappedChannel: 'whatsapp' | 'instagram' | 'webchat';
}

/**
 * Parâmetros para buscar métricas do dashboard
 */
export interface DashboardMetricsParams {
  accountId: string;
  dateRange: { from: Date; to: Date };
  inboxId?: number;        // Filtro por canal/inbox
  agentId?: number;        // Filtro por agente
}

/**
 * Resposta das métricas do dashboard
 */
/**
 * CAMADA 1: Atendimento em Tempo Real
 * Quem ESTÁ atendendo agora?
 */
export interface AtendimentoMetrics {
  total: number;              // Total de conversas abertas
  ia: number;                 // Sendo atendidas por IA agora
  humano: number;             // Sendo atendidas por humanos agora
  semAssignee: number;        // Em Aberto — conversas sem IA confirmada nem humano atribuído
}

/**
 * CAMADA 2: Resolução (Histórico)
 * Quem RESOLVEU o problema?
 */
export interface ResolucaoMetrics {
  total: number;              // Total resolvidas no período
  ia: {
    total: number;
    explicito: number;        // resolved_by = 'ai' (n8n)
    botNativo: number;        // agent_bot do Chatwoot
    inferido: number;         // via heurística
  };
  humano: {
    total: number;
    explicito: number;        // resolved_by = 'human' (n8n)
    inferido: number;         // via heurística
  };
  naoClassificado: number;    // Sem resolved_by (conversas antigas)
  transbordoFinalizado: number; // IA iniciou, humano fechou
}

/**
 * Taxas calculadas
 */
export interface TaxasMetrics {
  resolucaoIA: string;        // % resolvidas por IA
  resolucaoHumano: string;    // % resolvidas por humano
  transbordo: string;         // % de transbordo (IA -> Humano que fechou)
  eficienciaIA: string;       // % de conversas que IA resolveu sozinha
}

/**
 * Estrutura de resoluções detalhadas (retrocompatibilidade)
 */
export interface ResolucoesDetalhadas {
  ia: {
    total: number;
    explicito: number;
    inferido: number;
  };
  humano: {
    total: number;
    explicito: number;
    inferido: number;
  };
  naoClassificado: number;
}

/**
 * Métricas de transbordo (handoff)
 */
export interface TransbordoMetrics {
  total: number;           // Conversas onde IA iniciou e humano finalizou
  iniciadasPorIA: number;  // conversas iniciadas por IA
  taxa: string;            // % do total iniciado por IA
}

/**
 * Auditoria de metodologia de classificação
 */
export interface ClassificacaoAudit {
  metodologiaExplicita: number;
  metodologiaInferida: number;
  metodologiaFallback: number;
  metodologiaBotNativo: number;
}

export interface DashboardMetricsResponse {
  success: boolean;
  data?: {
    totalLeads: number;
    conversasAtivas: number;
    conversasResolvidas?: number;
    conversasPendentes?: number;
    conversasSemResposta?: number;

    // CAMADA 1: Atendimento em tempo real
    atendimento?: AtendimentoMetrics;
    
    // CAMADA 2: Resolução (histórico)
    resolucao?: ResolucaoMetrics;
    
    // Taxas calculadas
    taxas?: TaxasMetrics;

    // Contagens absolutas (retrocompatibilidade)
    atendimentosIA?: number;
    atendimentosHumano?: number;
    atendimentosClassificados?: number;

    // Percentuais
    percentualIA: number;
    percentualHumano: number;
    
    // Transbordo detalhado
    transbordo?: TransbordoMetrics;
    
    // Tempo
    tempoMedioPrimeiraResposta: string;
    tempoMedioResolucao: string;
    taxaTransbordo: string;
    
    // Por canal
    conversasPorCanal: Array<{ 
      inboxId: number; 
      canal: string; 
      inboxName?: string;
      totalConversas: number;
    }>;
    
    // Pico horário
    picoPorHora: Array<{ 
      hora: number; 
      totalConversas: number;
    }>;
    
    // Backlog
    backlog: { 
      ate15min: number; 
      de15a60min: number; 
      acima60min: number;
    };
    
    // Performance de agentes
    agentes?: AgentPerformanceMetrics[];
    
    // Qualidade
    qualidade?: QualityMetrics;
    
    // Debug/Auditoria
    _debug?: {
      totalConversationsRaw: number;
      totalConversationsFiltered: number;
      atendimento: AtendimentoMetrics;
      resolucao: ResolucaoMetrics;
      classificacao: ClassificacaoAudit;
      inboxesCount: number;
      agentsCount: number;
      dateRange: { from: string; to: string };
    };
  };
  error?: string;
}

/**
 * Parâmetros para buscar inboxes
 */
export interface FetchInboxesParams {
  baseUrl: string;
  accountId: string;
  apiKey: string;
}

/**
 * Resposta da busca de inboxes
 */
export interface FetchInboxesResult {
  success: boolean;
  inboxes: ChatwootInbox[];
  error?: string;
}

/**
 * Métricas de performance de agente
 * Dados retornados por: GET /api/v1/accounts/{id}/reports/agents
 */
export interface AgentPerformanceMetrics {
  agentId: number;
  agentName: string;
  atendimentosAssumidos: number;
  atendimentosResolvidos: number;
  tempoMedioResposta: string;
  taxaResolucao: number;
}

/**
 * Dados de qualidade e conversão
 */
export interface QualityMetrics {
  conversasSemResposta: number;
  taxaAtendimentoVenda: string;
}

/**
 * Mapeamento de channel_type do Chatwoot para tipo interno
 */
export const CHANNEL_TYPE_MAP: Record<string, 'whatsapp' | 'instagram' | 'webchat'> = {
  'Channel::Whatsapp': 'whatsapp',
  'Channel::Instagram': 'instagram',
  'Channel::FacebookPage': 'instagram', // Messenger/IG unificado
  'Channel::WebWidget': 'webchat',
};

/**
 * Função auxiliar para mapear channel_type
 */
export function mapChannelType(channelType: string): 'whatsapp' | 'instagram' | 'webchat' {
  return CHANNEL_TYPE_MAP[channelType] || 'webchat';
}
