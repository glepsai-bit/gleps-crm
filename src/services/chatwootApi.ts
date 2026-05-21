import { ChatwootAgent } from '@/types/crm';
import { mockChatwootAgents } from '@/data/mockChatwootData';

/**
 * ===================================================================
 * INTEGRAÇÃO CHATWOOT - DOCUMENTAÇÃO COMPLETA DE ENDPOINTS
 * ===================================================================
 * 
 * Este arquivo documenta todos os endpoints necessários para integração
 * completa com a API do Chatwoot. Atualmente usa dados mock.
 * 
 * ===================================================================
 * ENDPOINT 1: AGENTES
 * ===================================================================
 * 
 * Edge Function: `fetch-chatwoot-agents`
 * 
 * Request:
 * POST /functions/v1/fetch-chatwoot-agents
 * Body: { 
 *   chatwoot_base_url: string,    // Ex: https://app.chatwoot.com
 *   chatwoot_account_id: string,  // Ex: 12345
 *   chatwoot_api_key: string      // Access Token do usuário/agente
 * }
 * 
 * Chatwoot API:
 * GET {BASE_URL}/api/v1/accounts/{ACCOUNT_ID}/agents
 * Headers: { api_access_token: apiKey }
 * 
 * Response:
 * { success: boolean, agents: ChatwootAgent[], error?: string }
 * 
 * ===================================================================
 * ENDPOINT 2: INBOXES (Canais)
 * ===================================================================
 * 
 * Edge Function: `fetch-chatwoot-inboxes`
 * 
 * Chatwoot API:
 * GET {BASE_URL}/api/v1/accounts/{ACCOUNT_ID}/inboxes
 * Headers: { api_access_token: apiKey }
 * 
 * Response esperada do Chatwoot:
 * {
 *   payload: [{
 *     id: number,
 *     name: string,
 *     channel_type: 'Channel::Whatsapp' | 'Channel::Instagram' | 'Channel::WebWidget',
 *     avatar_url: string | null
 *   }]
 * }
 * 
 * ===================================================================
 * ENDPOINT 3: MÉTRICAS DE CONVERSAS
 * ===================================================================
 * 
 * Edge Function: `fetch-chatwoot-metrics`
 * 
 * Chatwoot APIs necessárias:
 * 
 * a) Resumo de conversas:
 *    GET {BASE_URL}/api/v1/accounts/{ID}/reports/summary
 *    Params: { type: 'conversations', since: timestamp, until: timestamp, inbox_id? }
 * 
 * b) Contagem por período:
 *    GET {BASE_URL}/api/v1/accounts/{ID}/reports/conversations
 *    Params: { type: 'count', since, until, inbox_id?, agent_id? }
 * 
 * c) Tempo primeira resposta:
 *    GET {BASE_URL}/api/v1/accounts/{ID}/reports/conversations
 *    Params: { type: 'avg_first_response_time', since, until }
 * 
 * d) Tempo de resolução:
 *    GET {BASE_URL}/api/v1/accounts/{ID}/reports/conversations
 *    Params: { type: 'avg_resolution_time', since, until }
 * 
 * ===================================================================
 * ENDPOINT 4: PERFORMANCE DE AGENTES
 * ===================================================================
 * 
 * Edge Function: `fetch-chatwoot-agent-metrics`
 * 
 * Chatwoot API:
 * GET {BASE_URL}/api/v1/accounts/{ID}/reports/agents
 * Params: { since: timestamp, until: timestamp, inbox_id? }
 * 
 * Response esperada:
 * [{
 *   id: number,
 *   name: string,
 *   conversations_count: number,
 *   resolved_conversations_count: number,
 *   avg_first_response_time: number (segundos),
 *   avg_resolution_time: number (segundos)
 * }]
 * 
 * ===================================================================
 * ENDPOINT 5: MÉTRICAS DE BOT (IA vs Humano)
 * ===================================================================
 * 
 * Edge Function: `fetch-chatwoot-bot-metrics`
 * 
 * Abordagem: Contar conversas por assignee_type
 * 
 * Chatwoot API:
 * GET {BASE_URL}/api/v1/accounts/{ID}/conversations
 * Params: { 
 *   status: 'all',
 *   since: timestamp,
 *   until: timestamp
 * }
 * 
 * Lógica no backend:
 * - Conversas com assignee_type = 'AgentBot' → Contabilizar como IA
 * - Conversas com assignee_type = 'Agent' ou humano → Contabilizar como Humano
 * - Taxa de transbordo = conversas que mudaram de bot → humano
 * 
 * ===================================================================
 */

export interface FetchAgentsParams {
  baseUrl: string;   // URL da instância Chatwoot (ex: https://app.chatwoot.com)
  accountId: string; // ID da conta no Chatwoot
  apiKey: string;    // Access Token para autenticação
}

export interface FetchAgentsResult {
  success: boolean;
  agents: ChatwootAgent[];
  error?: string;
}

/**
 * Busca agentes do Chatwoot
 * 
 * TODO: Substituir por chamada real à Edge Function em produção
 * 
 * @example
 * // Produção:
 * const response = await fetch('/functions/v1/fetch-chatwoot-agents', {
 *   method: 'POST',
 *   headers: { 'Content-Type': 'application/json' },
 *   body: JSON.stringify({ 
 *     chatwoot_base_url: baseUrl,
 *     chatwoot_account_id: accountId, 
 *     chatwoot_api_key: apiKey 
 *   })
 * });
 * return await response.json();
 */
export async function fetchChatwootAgents(params: FetchAgentsParams): Promise<FetchAgentsResult> {
  // Simula delay de rede
  await new Promise(resolve => setTimeout(resolve, 1500));
  
  // Validação mock (em produção seria validado pelo backend)
  if (!params.baseUrl || !params.accountId || !params.apiKey) {
    return { 
      success: false, 
      agents: [], 
      error: 'URL Base, Account ID e API Key são obrigatórios' 
    };
  }

  // Valida formato da URL
  try {
    new URL(params.baseUrl);
  } catch {
    return { 
      success: false, 
      agents: [], 
      error: 'URL Base inválida. Use o formato: https://app.chatwoot.com' 
    };
  }
  
  // Simula validação de credenciais inválidas
  if (params.apiKey.length < 5) {
    return { 
      success: false, 
      agents: [], 
      error: 'API Key inválida. Verifique as credenciais.'
    };
  }
  
  // Retorna dados mock simulando sucesso
  return { 
    success: true, 
    agents: mockChatwootAgents 
  };
}

/**
 * Valida conexão com Chatwoot sem buscar agentes
 * 
 * TODO: Implementar endpoint separado se necessário
 */
export async function testChatwootConnection(params: FetchAgentsParams): Promise<{ success: boolean; error?: string }> {
  const result = await fetchChatwootAgents(params);
  return { 
    success: result.success, 
    error: result.error 
  };
}
