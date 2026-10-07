/**
 * Aquecimento — service do front para /api/aquecimento (backend: aquecimento.service.ts).
 * Os tipos espelham o contrato da etapa W; o backend responde { success, data }.
 */
import { apiClient } from '@/api/client';

export type StatusAquecimento = 'aquecendo' | 'pronto' | 'pausado' | 'aguardando_parceiro';
export type SaudeAquecimento = 'boa' | 'atencao' | 'pausado';

export interface NumeroAquecimento {
  id: string;
  inboxId: string | null;
  inboxNome: string;
  /** E.164 sem formatação, ex.: 5534988119078 */
  telefone: string;
  status: StatusAquecimento;
  /** 1..30; em manutenção fica em 30 */
  dia: number;
  modo: 'rampa' | 'manutencao';
  hoje: { planejadas: number; enviadas: number; recebidas: number; disparos: number };
  saude: SaudeAquecimento;
  falhasSeguidas: number;
  pausadoMotivo: string | null;
  pausadoEm: string | null;
  prontoEm: string | null;
  limiteDiario: number;
  restantesHoje: number;
}

export interface AgoraAquecimento {
  proximaRodadaEm: string;
  janela: { inicio: string; fim: string; fuso: string };
  trocadasHoje: number;
  falhasHoje: number;
  infraPausaAte: string | null;
}

export interface ListaAquecimento {
  numeros: NumeroAquecimento[];
  agora: AgoraAquecimento;
}

export interface InboxDisponivel {
  id: string;
  nome: string;
  telefone: string | null;
  /** status da conexão na Evolution; 'open' = conectada */
  status?: string;
  conectada?: boolean;
}

export interface DiaHistorico {
  date: string;
  planned: number;
  actual: number;
  receives: number;
  failed: number;
}

function unwrap<T>(resp: unknown): T {
  const r = resp as { data?: T } | null;
  return (r && typeof r === 'object' && 'data' in r ? (r.data as T) : (resp as T));
}

const BASE = '/api/aquecimento';

export const aquecimentoBackendService = {
  async listar(): Promise<ListaAquecimento> {
    return unwrap<ListaAquecimento>(await apiClient.get<unknown>(`${BASE}`));
  },
  async inboxesDisponiveis(): Promise<InboxDisponivel[]> {
    const r = unwrap<InboxDisponivel[]>(await apiClient.get<unknown>(`${BASE}/inboxes-disponiveis`));
    return Array.isArray(r) ? r : [];
  },
  async adicionar(inboxId: string): Promise<NumeroAquecimento> {
    return unwrap<NumeroAquecimento>(await apiClient.post<unknown>(`${BASE}/numeros`, { inboxId }));
  },
  async pausar(id: string): Promise<void> {
    await apiClient.post<unknown>(`${BASE}/numeros/${id}/pausar`);
  },
  async retomar(id: string): Promise<void> {
    await apiClient.post<unknown>(`${BASE}/numeros/${id}/retomar`);
  },
  async remover(id: string): Promise<void> {
    await apiClient.delete<unknown>(`${BASE}/numeros/${id}`);
  },
  async historico(id: string): Promise<DiaHistorico[]> {
    const r = unwrap<DiaHistorico[]>(await apiClient.get<unknown>(`${BASE}/numeros/${id}/historico`));
    return Array.isArray(r) ? r : [];
  },
};
