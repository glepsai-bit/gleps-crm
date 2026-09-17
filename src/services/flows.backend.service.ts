/**
 * T-028 Fase 2 — fluxos de atendimento IA.
 * Mesmo padrão de ai.backend.service.ts: apiClient direto, envelope { data }.
 */
import { apiClient } from '@/api/client';

interface DataEnvelope<T> {
  data: T;
}

export type FlowStatus = 'draft' | 'shadow' | 'active';
export type RunStatus =
  | 'buffering'
  | 'running'
  /** Follow-up marcado pra depois: o run volta à fila na hora certa. */
  | 'sleeping'
  | 'done'
  | 'failed'
  | 'skipped';

export interface FlowNode {
  id: string;
  type: string;
  label?: string;
  config?: Record<string, unknown>;
  position?: { x: number; y: number };
}

export interface FlowEdge {
  id: string;
  source: string;
  target: string;
  branch?: string | null;
}

export interface FlowGraph {
  nodes: FlowNode[];
  edges: FlowEdge[];
}

export interface FlowSummary {
  id: string;
  name: string;
  description: string | null;
  status: FlowStatus;
  version: number;
  inboxIds: string[] | null;
  runCount: number;
  nodeCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface Flow {
  id: string;
  name: string;
  description: string | null;
  status: FlowStatus;
  graph: FlowGraph;
  version: number;
  inboxIds: string[] | null;
  createdAt: string;
  updatedAt: string;
  /** Problemas que impedem ativar. Vem do backend pra tela não duplicar a regra. */
  problemas?: string[];
}

export interface NodeTypeInfo {
  type: string;
  label: string;
  description: string;
  branches: { key: string; label: string }[];
  /** Age pra fora (envia, altera conversa, chama API). Suprimido no modo sombra. */
  mutates: boolean;
}

export interface FlowCatalog {
  nodes: NodeTypeInfo[];
  /**
   * Schema de saída sugerido pro agente. O enum de `etapa` vem das etapas REAIS
   * do kanban da conta (vazio se não houver nenhuma) — não é mais uma lista
   * fixa no código.
   */
  agentSchema: Record<string, unknown>;
}

export interface FlowRunSummary {
  id: string;
  flowId: string;
  conversationId: string;
  status: RunStatus;
  shadow: boolean;
  stopReason: string | null;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  flow: { name: string };
  _count: { steps: number };
}

export interface FlowRunStep {
  id: string;
  nodeId: string;
  nodeType: string;
  status: 'ok' | 'error' | 'skipped';
  input: Record<string, unknown> | null;
  output: Record<string, unknown> | null;
  ms: number;
  error: string | null;
  ordem: number;
  createdAt: string;
}

export interface FlowRunDetail extends Omit<FlowRunSummary, '_count' | 'flow'> {
  flow: { name: string; status: FlowStatus };
  context: Record<string, unknown>;
  steps: FlowRunStep[];
}

/**
 * O turno ficou na janela de agrupamento.
 *
 * O simulador respeita a MESMA espera do atendimento real: com "Agrupar
 * mensagens" no desenho, a resposta só vem quando a janela fecha — e cada
 * mensagem nova empurra `runAfter`. A tela acompanha por `previewRunAtual`.
 */
export interface FlowPreviewBuffering {
  conversationId: string;
  runId: string;
  status: 'buffering';
  /** Quando a janela fecha (ISO, relógio do servidor). */
  runAfter: string;
  /** Tamanho da janela, em segundos. */
  segundos: number;
}

/** Resultado de um turno do simulador. */
export interface FlowPreview {
  /** Conversa de teste. Mande de volta no próximo turno pra manter o contexto. */
  conversationId: string;
  runId: string;
  /** O que a IA responderia. Null quando o fluxo parou antes de responder. */
  resposta: string | null;
  status: RunStatus;
  stopReason: string | null;
  error: string | null;
  steps: FlowRunStep[];
  /** Longo prazo — fica no contato, vale entre conversas. */
  memoria: Record<string, unknown>;
  /** Curto prazo — fica na conversa. */
  sessao: Record<string, unknown>;
}

/** O turno em andamento (ou o último) da conversa de teste. */
export interface FlowPreviewRunAtual {
  runId: string;
  status: RunStatus;
  /** Quando a janela de agrupamento fecha; null fora do 'buffering'. */
  runAfter: string | null;
  steps: FlowRunStep[];
  /** Derivada dos passos que falam — preenchida quando o run terminou. */
  resposta: string | null;
  stopReason: string | null;
  error: string | null;
  /** Só quando o run terminou; antes disso vêm vazias. */
  memoria: Record<string, unknown>;
  sessao: Record<string, unknown>;
}

/** Status em que o run não vai mais mudar sozinho. */
export const RUN_STATUS_TERMINAL: ReadonlySet<RunStatus> = new Set<RunStatus>([
  'done',
  'failed',
  'sleeping',
  'skipped',
]);

export function ehTurnoAgrupando(r: FlowPreview | FlowPreviewBuffering): r is FlowPreviewBuffering {
  return r.status === 'buffering' && 'runAfter' in r && 'segundos' in r;
}

export const flowsService = {
  async catalog(): Promise<FlowCatalog> {
    const r = await apiClient.get<DataEnvelope<FlowCatalog>>('/api/flows/catalog');
    return r.data;
  },

  async list(): Promise<FlowSummary[]> {
    const r = await apiClient.get<DataEnvelope<FlowSummary[]>>('/api/flows');
    return r.data;
  },

  async get(id: string): Promise<Flow> {
    const r = await apiClient.get<DataEnvelope<Flow>>(`/api/flows/${id}`);
    return r.data;
  },

  async create(input: { name: string; description?: string | null; graph: FlowGraph }): Promise<Flow> {
    const r = await apiClient.post<DataEnvelope<Flow>>('/api/flows', input);
    return r.data;
  },

  /**
   * Cria a cadência de follow-up: três toques com espera crescente, cada um
   * conferindo se ainda cabe falar antes de escrever. Nasce em rascunho.
   */
  async seedFollowup(agentId?: string): Promise<{ flow: Flow; promptHint: string }> {
    const r = await apiClient.post<DataEnvelope<Flow> & { promptHint: string }>(
      '/api/flows/seed-followup',
      { ...(agentId ? { agentId } : {}) }
    );
    return { flow: r.data, promptHint: r.promptHint };
  },

  /** Cria o fluxo padrão (tradução do workflow do n8n). Nasce em rascunho. */
  async seedDefault(agentId?: string): Promise<Flow> {
    const r = await apiClient.post<DataEnvelope<Flow>>('/api/flows/seed-default', {
      ...(agentId ? { agentId } : {}),
    });
    return r.data;
  },

  async update(
    id: string,
    input: { name?: string; description?: string | null; graph?: FlowGraph; inboxIds?: string[] | null }
  ): Promise<Flow> {
    const r = await apiClient.patch<DataEnvelope<Flow>>(`/api/flows/${id}`, input);
    return r.data;
  },

  async setStatus(id: string, status: FlowStatus): Promise<Flow> {
    const r = await apiClient.post<DataEnvelope<Flow>>(`/api/flows/${id}/status`, { status });
    return r.data;
  },

  async remove(id: string): Promise<void> {
    await apiClient.delete(`/api/flows/${id}`);
  },

  async listRuns(params: { flowId?: string; status?: RunStatus; limit?: number } = {}): Promise<FlowRunSummary[]> {
    const qs = new URLSearchParams();
    if (params.flowId) qs.set('flowId', params.flowId);
    if (params.status) qs.set('status', params.status);
    if (params.limit) qs.set('limit', String(params.limit));
    const sufixo = qs.toString() ? `?${qs.toString()}` : '';
    const r = await apiClient.get<DataEnvelope<FlowRunSummary[]>>(`/api/flows/runs${sufixo}`);
    return r.data;
  },

  /**
   * Simulador: um turno do lead na conversa de teste.
   * Nada sai pro WhatsApp e nada muda no funil.
   *
   * Sem janela de agrupamento no desenho, roda o fluxo inteiro na hora e
   * devolve o que a IA responderia. COM janela, devolve `status: 'buffering'`
   * e a hora em que ela fecha — o resultado chega depois por `previewRunAtual`.
   */
  async preview(
    flowId: string,
    input: { message: string; conversationId?: string | null }
  ): Promise<FlowPreview | FlowPreviewBuffering> {
    // Timeout próprio: o padrão de 30s é curto pra um turno que chama o modelo,
    // consulta especialista e busca na base — o run terminaria no servidor e a
    // tela mostraria "timeout", que é a pior coisa pra quem está depurando.
    const r = await apiClient.post<DataEnvelope<FlowPreview | FlowPreviewBuffering>>(
      `/api/flows/${flowId}/preview`,
      input,
      { timeout: 180_000 }
    );
    return r.data;
  },

  /**
   * O turno em andamento da conversa de teste. O canvas chama em intervalos
   * curtos enquanto o turno roda, pra acender os blocos conforme executam — e,
   * com janela de agrupamento, é por aqui que a resposta chega quando o
   * worker termina o run.
   */
  async previewRunAtual(conversationId: string): Promise<FlowPreviewRunAtual | null> {
    const r = await apiClient.get<DataEnvelope<FlowPreviewRunAtual | null>>(
      `/api/flows/preview/${conversationId}/run`
    );
    return r.data;
  },

  /** Descarta a conversa de teste — o simulador recomeça sem memória nenhuma. */
  async resetPreview(conversationId: string): Promise<void> {
    await apiClient.delete(`/api/flows/preview/${conversationId}`);
  },

  async getRun(runId: string): Promise<FlowRunDetail> {
    const r = await apiClient.get<DataEnvelope<FlowRunDetail>>(`/api/flows/runs/${runId}`);
    return r.data;
  },
};
