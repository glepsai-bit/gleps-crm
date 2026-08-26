/**
 * T-028 Fase 2 — fluxos de atendimento IA.
 * Mesmo padrão de ai.backend.service.ts: apiClient direto, envelope { data }.
 */
import { apiClient } from '@/api/client';

interface DataEnvelope<T> {
  data: T;
}

export type FlowStatus = 'draft' | 'shadow' | 'active';
export type RunStatus = 'buffering' | 'running' | 'done' | 'failed' | 'skipped';

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

  async getRun(runId: string): Promise<FlowRunDetail> {
    const r = await apiClient.get<DataEnvelope<FlowRunDetail>>(`/api/flows/runs/${runId}`);
    return r.data;
  },
};
