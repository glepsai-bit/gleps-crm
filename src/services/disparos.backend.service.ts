/* eslint-disable @typescript-eslint/no-explicit-any -- normaliza respostas de API sem tipo fixo */
/**
 * Disparos (motor único com fila no banco) — cliente HTTP.
 *
 * Backend: backend/src/routes/disparo.routes.ts em /api/disparos.
 * As rotas e os campos seguem o contrato da etapa D. Onde o contrato não fixa
 * a forma exata da resposta, o normalizador aceita as variações prováveis
 * (array puro ou envelope { data }, campos planos ou aninhados) para a tela
 * não quebrar por um detalhe de serialização.
 */

import { apiClient, tokenManager } from '@/api/client';
import { apiConfig } from '@/config/api.config';

const BASE = '/api/disparos';

export type StatusDisparo = 'agendado' | 'enviando' | 'pausado' | 'concluido' | 'cancelado';

export type StatusEnvio =
  | 'pendente'
  | 'enviando'
  | 'enviada'
  | 'entregue'
  | 'lida'
  | 'respondeu'
  | 'falhou'
  | 'pulado_optout'
  | 'pulado_invalido'
  | 'pulado_duplicado'
  | 'cancelado';

export type TipoAnexo = 'imagem' | 'pdf' | 'audio';

export interface AnexoDisparo {
  tipo: TipoAnexo;
  /** Caminho relativo devolvido pelo upload (`id` da resposta de /anexos). */
  path: string;
  nome: string;
  mime: string;
  tamanho: number;
}

export type ListaDisparo =
  | { tipo: 'publico'; audienceId: string }
  | { tipo: 'leads'; etapaTagId?: string; tagIds?: string[] }
  | { tipo: 'numeros'; quantidade: number; linhas?: string[] };

export type AtendeRespostas = 'agente' | 'humano';

export interface PreviewLista {
  total: number;
  vaoReceber: number;
  optout: number;
  duplicados: number;
  invalidos: number;
}

export type StatusNumero = 'pronto' | 'aquecendo' | 'pausado' | 'nao_aquecido';

export interface NumeroDisparo {
  inboxId: string;
  nome: string;
  telefone: string | null;
  conectado: boolean;
  status: StatusNumero;
  dia: number | null;
  limiteDiario: number;
  restantesHoje: number;
  /** Nome do agente de IA do inbox, quando o backend informa. */
  agenteNome: string | null;
}

export interface NumerosDisparoResposta {
  numeros: NumeroDisparo[];
  /** Quantos pediram para sair (para o link "N pediram para sair"). */
  optouts: number | null;
}

export interface DisparoResumo {
  id: string;
  nome: string;
  texto: string;
  variantes: string[];
  anexo: AnexoDisparo | null;
  lista: ListaDisparo;
  /** Texto pronto ("Público Pacientes sem retorno"), quando o backend manda. */
  listaRotulo: string | null;
  inboxIds: string[];
  atendeRespostas: AtendeRespostas;
  status: StatusDisparo;
  pausadoMotivo: string | null;
  agendadoPara: string | null;
  iniciadoEm: string | null;
  concluidoEm: string | null;
  previsaoTerminoEm: string | null;
  total: number;
  enviadas: number;
  falhas: number;
  respondidas: number;
  optout: number;
  pulados: number;
  createdAt: string | null;
}

export interface ListaDeDisparos {
  emAndamento: DisparoResumo[];
  concluidos: DisparoResumo[];
}

export interface EnvioDisparo {
  id: string;
  nome: string | null;
  telefone: string;
  inboxId: string;
  inboxNome: string | null;
  status: StatusEnvio;
  erro: string | null;
  enviadoEm: string | null;
  respondidoEm: string | null;
  naoAntesDe: string | null;
}

export interface DetalheDisparo {
  disparo: DisparoResumo;
  envios: EnvioDisparo[];
  pagina: number;
  totalPaginas: number;
  totalEnvios: number;
}

export interface NovoDisparoInput {
  nome: string;
  texto: string;
  variantes: string[];
  anexo: AnexoDisparo | null;
  lista: ListaDisparo;
  inboxIds: string[];
  atendeRespostas: AtendeRespostas;
  /** ISO. Ausente = agora. */
  agendadoPara?: string;
}

// ---------------------------------------------------------------------------
// Normalização
// ---------------------------------------------------------------------------

const desembrulhar = (res: any): any => (res && typeof res === 'object' && 'data' in res && res.data !== undefined && !Array.isArray(res) ? res.data : res);
const n = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : 0);
const s = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

export function normalizarDisparo(d: any): DisparoResumo {
  return {
    id: d.id,
    nome: d.nome ?? 'Disparo',
    texto: d.texto ?? '',
    variantes: Array.isArray(d.variantes) ? d.variantes : [],
    anexo: d.anexo ?? null,
    lista: d.lista ?? { tipo: 'numeros', quantidade: n(d.total) },
    listaRotulo: s(d.listaRotulo ?? d.listaDescricao),
    inboxIds: Array.isArray(d.inboxIds) ? d.inboxIds : [],
    atendeRespostas: d.atendeRespostas === 'humano' ? 'humano' : 'agente',
    status: d.status,
    pausadoMotivo: s(d.pausadoMotivo),
    agendadoPara: s(d.agendadoPara),
    iniciadoEm: s(d.iniciadoEm),
    concluidoEm: s(d.concluidoEm),
    previsaoTerminoEm: s(d.previsaoTerminoEm ?? d.previsaoTermino),
    total: n(d.total),
    enviadas: n(d.enviadas),
    falhas: n(d.falhas),
    respondidas: n(d.respondidas),
    optout: n(d.optout),
    pulados: n(d.pulados),
    createdAt: s(d.createdAt ?? d.created_at),
  };
}

function normalizarNumero(x: any): NumeroDisparo {
  const cap = x.capacidade ?? x;
  return {
    inboxId: x.inboxId ?? x.id,
    nome: x.inboxNome ?? x.nome ?? x.name ?? 'Número',
    telefone: s(x.telefone),
    conectado: x.conectado ?? x.connected ?? true,
    status: cap.status ?? 'nao_aquecido',
    dia: cap.dia ?? null,
    limiteDiario: n(cap.limiteDiario),
    restantesHoje: n(cap.restantesHoje),
    agenteNome: s(x.agenteNome ?? x.agente?.nome),
  };
}

function normalizarEnvio(e: any): EnvioDisparo {
  return {
    id: e.id,
    nome: s(e.nome),
    telefone: e.telefone ?? '',
    inboxId: e.inboxId ?? '',
    inboxNome: s(e.inboxNome ?? e.inbox?.nome),
    status: e.status,
    erro: s(e.erro),
    enviadoEm: s(e.enviadoEm),
    respondidoEm: s(e.respondidoEm),
    naoAntesDe: s(e.naoAntesDe),
  };
}

// ---------------------------------------------------------------------------
// Upload multipart (o apiClient só fala JSON)
// ---------------------------------------------------------------------------

function urlCompleta(endpoint: string): string {
  const base = apiConfig.baseUrl.replace(/\/+$/, '');
  if (base.startsWith('http')) {
    const prefixo = new URL(base).pathname.replace(/\/+$/, '');
    const normal = prefixo && endpoint.startsWith(prefixo + '/') ? endpoint.slice(prefixo.length) : endpoint;
    return `${base}${normal}`;
  }
  const normal = base && endpoint.startsWith(base + '/') ? endpoint.slice(base.length) : endpoint;
  return `${window.location.origin}${base}${normal}`;
}

// ---------------------------------------------------------------------------
// Chamadas
// ---------------------------------------------------------------------------

export const disparosService = {
  async listar(): Promise<ListaDeDisparos> {
    const d = desembrulhar(await apiClient.get<any>(BASE));
    return {
      emAndamento: (d?.emAndamento ?? []).map(normalizarDisparo),
      concluidos: (d?.concluidos ?? []).map(normalizarDisparo),
    };
  },

  async numeros(): Promise<NumerosDisparoResposta> {
    const d = desembrulhar(await apiClient.get<any>(`${BASE}/numeros`));
    const lista = Array.isArray(d) ? d : d?.numeros ?? [];
    return { numeros: lista.map(normalizarNumero), optouts: Number.isFinite(Number(d?.optouts)) && d?.optouts != null ? Number(d.optouts) : null };
  },

  async previewLista(lista: ListaDisparo): Promise<PreviewLista> {
    const d = desembrulhar(await apiClient.post<any>(`${BASE}/preview-lista`, { lista }));
    return {
      total: n(d?.total),
      vaoReceber: n(d?.vaoReceber),
      optout: n(d?.optout),
      duplicados: n(d?.duplicados),
      invalidos: n(d?.invalidos),
    };
  },

  async criar(input: NovoDisparoInput): Promise<DisparoResumo> {
    const d = desembrulhar(await apiClient.post<any>(BASE, input));
    return normalizarDisparo(d?.disparo ?? d);
  },

  /** 5 reescritas do texto, mantendo as {{variáveis}}. */
  async variarComIA(texto: string): Promise<string[]> {
    const d = desembrulhar(await apiClient.post<any>(`${BASE}/variar`, { texto }));
    const itens = Array.isArray(d) ? d : d?.variantes ?? d?.opcoes ?? [];
    return itens.map((x: unknown) => String(x));
  },

  async enviarAnexo(arquivo: File): Promise<AnexoDisparo> {
    const form = new FormData();
    form.append('file', arquivo);
    const token = tokenManager.getToken();
    const res = await fetch(urlCompleta(`${BASE}/anexos`), {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body: form,
    });
    const corpo: any = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(corpo?.error?.message ?? corpo?.message ?? (typeof corpo?.error === 'string' ? corpo.error : null) ?? 'Não foi possível enviar o anexo');
    }
    const d = desembrulhar(corpo);
    return { tipo: d.tipo, path: d.id ?? d.path, nome: d.nome ?? arquivo.name, mime: d.mime ?? arquivo.type, tamanho: n(d.tamanho ?? arquivo.size) };
  },

  async detalhe(id: string, pagina = 1, status?: StatusEnvio | 'todos'): Promise<DetalheDisparo> {
    const params: Record<string, string> = { page: String(pagina) };
    if (status && status !== 'todos') params.status = status;
    const d = desembrulhar(await apiClient.get<any>(`${BASE}/${id}`, { params }));
    const envios = d?.envios?.itens ?? d?.envios?.items ?? d?.envios ?? [];
    const meta = d?.paginacao ?? d?.envios ?? d ?? {};
    return {
      disparo: normalizarDisparo(d?.disparo ?? d),
      envios: (Array.isArray(envios) ? envios : []).map(normalizarEnvio),
      pagina: n(meta.page ?? meta.pagina ?? pagina) || pagina,
      totalPaginas: n(meta.totalPaginas ?? meta.totalPages) || 1,
      totalEnvios: n(meta.total ?? meta.totalEnvios ?? d?.disparo?.total),
    };
  },

  async pausar(id: string): Promise<void> {
    await apiClient.post(`${BASE}/${id}/pausar`);
  },
  async retomar(id: string): Promise<void> {
    await apiClient.post(`${BASE}/${id}/retomar`);
  },
  async cancelar(id: string): Promise<void> {
    await apiClient.post(`${BASE}/${id}/cancelar`);
  },
  async reenviarNaoRespondidos(id: string): Promise<DisparoResumo> {
    const d = desembrulhar(await apiClient.post<any>(`${BASE}/${id}/reenviar-nao-respondidos`));
    return normalizarDisparo(d?.disparo ?? d);
  },
};
