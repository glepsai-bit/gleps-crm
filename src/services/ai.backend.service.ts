/**
 * T-027 Fase 1 — Atendimento IA: agentes e base de conhecimento.
 * Padrão do módulo tracking: apiClient direto, envelope { data }.
 */
import { apiClient, tokenManager, type ApiError } from '@/api/client';
import { apiConfig } from '@/config/api.config';

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
  /**
   * Quem é o negócio. Vai SEMPRE no prompt de qualquer agente ligado nesta
   * base — diferente da descrição, que só serve pra humano escolher a base.
   */
  businessContext: string | null;
  docCount: number;
  chunkCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface KnowledgeDoc {
  id: string;
  title: string;
  /** Uma linha do que o documento cobre, gerada na indexação. Vira o índice. */
  summary: string | null;
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

/**
 * Mesma resolução de URL do apiClient (que a mantém privada): respeita o
 * prefixo de `apiConfig.baseUrl` sem duplicar o `/api` que os endpoints já
 * carregam.
 */
function urlAbsoluta(endpoint: string): string {
  const baseUrl = apiConfig.baseUrl;
  if (baseUrl.startsWith('http')) {
    const prefix = new URL(baseUrl).pathname.replace(/\/+$/, '');
    const normalizado =
      prefix && endpoint.startsWith(prefix + '/') ? endpoint.slice(prefix.length) : endpoint;
    return `${baseUrl.replace(/\/+$/, '')}${normalizado}`;
  }
  const prefix = baseUrl.replace(/\/+$/, '');
  const normalizado =
    prefix && endpoint.startsWith(prefix + '/') ? endpoint.slice(prefix.length) : endpoint;
  return `${window.location.origin}${prefix}${normalizado}`;
}

/**
 * Upload multipart fora do apiClient — ele força `Content-Type: application/json`
 * e passa o body por JSON.stringify, o que transformaria o FormData em "{}".
 * O erro sai no MESMO formato do apiClient ({ message, code, status }) para
 * quem chama tratar os dois caminhos igual. Não há refresh automático em 401:
 * reenviar um arquivo de 15 MB sozinho não vale o risco — o usuário tenta de novo.
 */
async function postMultipart<T>(endpoint: string, form: FormData): Promise<T> {
  const headers: Record<string, string> = {};
  const token = tokenManager.getToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(urlAbsoluta(endpoint), { method: 'POST', headers, body: form });
  if (!res.ok) {
    let message = res.statusText || 'Erro desconhecido';
    let code: string | undefined;
    try {
      const body = (await res.json()) as {
        error?: { message?: string; code?: string } | string;
        message?: string;
      };
      if (typeof body?.error === 'object' && body.error) {
        message = body.error.message || message;
        code = body.error.code;
      } else {
        message = body?.message || (typeof body?.error === 'string' ? body.error : '') || message;
      }
    } catch {
      /* corpo sem JSON: fica o statusText */
    }
    const erro: ApiError = { message, code, status: res.status };
    throw erro;
  }
  return (await res.json()) as T;
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

  async createBase(input: {
    name: string;
    description?: string | null;
    businessContext?: string | null;
  }): Promise<KnowledgeBase> {
    const res = await apiClient.post<DataEnvelope<KnowledgeBase>>('/api/ai/knowledge', input);
    return res.data;
  },

  async updateBase(
    id: string,
    input: { name?: string; description?: string | null; businessContext?: string | null }
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

  /**
   * POST /api/ai/bases/:baseId/docs/upload — .pdf, .docx, .txt, .md, .csv, .json
   * (até 15 MB). O servidor extrai o texto de PDF e Word; planilha não passa
   * por aqui — o navegador converte xlsx pra CSV antes.
   * 422 = documento ilegível (PDF escaneado, arquivo vazio, acima de 400 mil
   * caracteres): a mensagem já diz o que fazer, mostre como veio.
   */
  async uploadDoc(baseId: string, file: File, title?: string): Promise<KnowledgeDoc> {
    const form = new FormData();
    form.append('file', file, file.name);
    if (title?.trim()) form.append('title', title.trim());
    const res = await postMultipart<DataEnvelope<KnowledgeDoc>>(
      `/api/ai/bases/${baseId}/docs/upload`,
      form
    );
    return res.data;
  },

  /**
   * POST /api/ai/bases/:baseId/docs/url — o servidor baixa a página (rede
   * interna bloqueada, 2 MB, 15 s) e guarda só o texto legível.
   * 422 = página sem texto útil / erro HTTP / grande demais.
   */
  async createDocFromUrl(baseId: string, url: string, title?: string): Promise<KnowledgeDoc> {
    const res = await apiClient.post<DataEnvelope<KnowledgeDoc>>(
      `/api/ai/bases/${baseId}/docs/url`,
      { url: url.trim(), ...(title?.trim() ? { title: title.trim() } : {}) }
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
