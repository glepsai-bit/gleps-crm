/**
 * T-027 Fase 1 — Atendimento IA: agentes e base de conhecimento.
 * Padrão do módulo tracking: apiClient direto, envelope { data }.
 */
import { apiClient } from '@/api/client';

interface DataEnvelope<T> {
  data: T;
}

export type AiProviderName = 'openai' | 'anthropic';
export type AiAgentRole = 'classifier' | 'responder' | 'custom';
export type KnowledgeDocStatus = 'pending' | 'indexing' | 'ready' | 'failed';

export interface AiStatus {
  providers: { openai: boolean; anthropic: boolean };
  /** Indexar e transcrever exigem OpenAI — a Anthropic não oferece embeddings nem áudio. */
  knowledgeBaseReady: boolean;
  transcriptionReady: boolean;
  tools: { name: string; description: string }[];
}

export interface AiAgent {
  id: string;
  name: string;
  description: string | null;
  role: AiAgentRole;
  systemPrompt: string;
  provider: AiProviderName;
  model: string | null;
  temperature: string | number;
  maxTokens: number;
  historyLimit: number;
  knowledgeBaseId: string | null;
  knowledgeBase?: { id: string; name: string } | null;
  tools: string[] | null;
  outputSchema: Record<string, unknown> | null;
  /** Agentes que este pode consultar no meio do raciocínio. */
  subAgentIds: string[] | null;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AiAgentInput {
  name?: string;
  description?: string | null;
  role?: AiAgentRole;
  systemPrompt?: string;
  provider?: AiProviderName;
  model?: string | null;
  temperature?: number;
  maxTokens?: number;
  historyLimit?: number;
  knowledgeBaseId?: string | null;
  tools?: string[];
  outputSchema?: Record<string, unknown> | null;
  subAgentIds?: string[] | null;
  active?: boolean;
}

export interface KnowledgeBase {
  id: string;
  name: string;
  description: string | null;
  docCount: number;
  chunkCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface KnowledgeDoc {
  id: string;
  title: string;
  sourceType: 'text' | 'file' | 'url';
  sourceRef: string | null;
  status: KnowledgeDocStatus;
  error: string | null;
  chunkCount: number;
  tokens: number;
  indexedAt: string | null;
  createdAt: string;
}

export interface KnowledgeHit {
  chunkId: string;
  docId: string;
  docTitle: string;
  content: string;
  score: number;
}

export interface AgentRunResult {
  text: string;
  structured: Record<string, unknown> | null;
  toolCalls: { id: string; name: string; arguments: Record<string, unknown> }[];
  hits: KnowledgeHit[];
  usage: {
    inputTokens: number;
    outputTokens: number;
    usdEstimate: number;
    /** false = modelo fora da tabela de preços; o custo exibido não vale. */
    priced: boolean;
  };
  model: string;
  provider: AiProviderName;
  /** 2 = o modelo errou o formato e precisou da rodada de autocorreção. */
  attempts: number;
}

export const aiService = {
  async getStatus(): Promise<AiStatus> {
    const res = await apiClient.get<DataEnvelope<AiStatus>>('/api/ai/status');
    return res.data;
  },

  // ----- Agentes -----
  async listAgents(): Promise<AiAgent[]> {
    const res = await apiClient.get<DataEnvelope<AiAgent[]>>('/api/ai/agents');
    return res.data;
  },

  async createAgent(input: AiAgentInput): Promise<AiAgent> {
    const res = await apiClient.post<DataEnvelope<AiAgent>>('/api/ai/agents', input);
    return res.data;
  },

  async updateAgent(id: string, input: AiAgentInput): Promise<AiAgent> {
    const res = await apiClient.patch<DataEnvelope<AiAgent>>(`/api/ai/agents/${id}`, input);
    return res.data;
  },

  async deleteAgent(id: string): Promise<void> {
    await apiClient.delete(`/api/ai/agents/${id}`);
  },

  async runAgent(
    id: string,
    payload: { message: string; conversationId?: string; variables?: Record<string, string> }
  ): Promise<AgentRunResult> {
    const res = await apiClient.post<DataEnvelope<AgentRunResult>>(
      `/api/ai/agents/${id}/run`,
      payload
    );
    return res.data;
  },

  // ----- Bases de conhecimento -----
  async listBases(): Promise<KnowledgeBase[]> {
    const res = await apiClient.get<DataEnvelope<KnowledgeBase[]>>('/api/ai/knowledge');
    return res.data;
  },

  async createBase(input: { name: string; description?: string | null }): Promise<KnowledgeBase> {
    const res = await apiClient.post<DataEnvelope<KnowledgeBase>>('/api/ai/knowledge', input);
    return res.data;
  },

  async updateBase(
    id: string,
    input: { name?: string; description?: string | null }
  ): Promise<KnowledgeBase> {
    const res = await apiClient.patch<DataEnvelope<KnowledgeBase>>(`/api/ai/knowledge/${id}`, input);
    return res.data;
  },

  async deleteBase(id: string): Promise<void> {
    await apiClient.delete(`/api/ai/knowledge/${id}`);
  },

  async searchBase(baseId: string, query: string, topK = 6): Promise<KnowledgeHit[]> {
    const res = await apiClient.get<DataEnvelope<KnowledgeHit[]>>(
      `/api/ai/knowledge/${baseId}/search?query=${encodeURIComponent(query)}&topK=${topK}`
    );
    return res.data;
  },

  // ----- Documentos -----
  async listDocs(baseId: string): Promise<KnowledgeDoc[]> {
    const res = await apiClient.get<DataEnvelope<KnowledgeDoc[]>>(
      `/api/ai/knowledge/${baseId}/docs`
    );
    return res.data;
  },

  async createDoc(
    baseId: string,
    input: { title: string; content: string; sourceType?: 'text' | 'file' | 'url'; sourceRef?: string | null }
  ): Promise<KnowledgeDoc> {
    const res = await apiClient.post<DataEnvelope<KnowledgeDoc>>(
      `/api/ai/knowledge/${baseId}/docs`,
      input
    );
    return res.data;
  },

  async updateDoc(
    docId: string,
    input: { title?: string; content?: string }
  ): Promise<KnowledgeDoc> {
    const res = await apiClient.patch<DataEnvelope<KnowledgeDoc>>(
      `/api/ai/knowledge/docs/${docId}`,
      input
    );
    return res.data;
  },

  async deleteDoc(docId: string): Promise<void> {
    await apiClient.delete(`/api/ai/knowledge/docs/${docId}`);
  },

  async reindexDoc(docId: string): Promise<KnowledgeDoc> {
    const res = await apiClient.post<DataEnvelope<KnowledgeDoc>>(
      `/api/ai/knowledge/docs/${docId}/reindex`,
      {}
    );
    return res.data;
  },
};
