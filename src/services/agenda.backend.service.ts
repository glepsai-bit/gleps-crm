/**
 * Agenda como habilidade do agente — não é um bloco do fluxo.
 *
 * O agente marca horário por dentro do bloco "Atender com IA" (seção Agenda em
 * `PainelAgente.tsx`); estas rotas alimentam essa seção e a tela de regras
 * `AdminIaAgendaPage.tsx` (`/admin/ia/agenda`). Mesmo padrão do módulo de IA:
 * `apiClient` direto, envelope `{ data }`.
 *
 * Contrato combinado com o Dev Principal — os 5 endpoints ficam sob
 * `/api/agenda`, JWT admin + accountId, mesmo formato de resposta do resto.
 */
import { apiClient } from '@/api/client';
import { API_ENDPOINTS } from '@/api/endpoints';

interface DataEnvelope<T> {
  data: T;
}

/** Uma faixa de atendimento num dia — "das 09:00 às 12:00". */
export interface FaixaDeHorario {
  inicio: string; // 'HH:MM'
  fim: string; // 'HH:MM'
}

/**
 * Os horários de um profissional, por dia da semana.
 *
 * Chave é o dia como STRING ('0' a '6', 0 = domingo) — é o formato que o
 * `JSON.stringify` de um objeto faz do índice numérico, e é o que o backend
 * espera de volta. Dia ausente do objeto = não atende naquele dia.
 */
export type HorariosDaSemana = Record<string, FaixaDeHorario[]>;

/** Os 7 dias, na ordem que a UI mostra (segunda primeiro). */
export const DIAS_DA_SEMANA: { dia: string; rotulo: string; rotuloCurto: string }[] = [
  { dia: '1', rotulo: 'Segunda', rotuloCurto: 'Seg' },
  { dia: '2', rotulo: 'Terça', rotuloCurto: 'Ter' },
  { dia: '3', rotulo: 'Quarta', rotuloCurto: 'Qua' },
  { dia: '4', rotulo: 'Quinta', rotuloCurto: 'Qui' },
  { dia: '5', rotulo: 'Sexta', rotuloCurto: 'Sex' },
  { dia: '6', rotulo: 'Sábado', rotuloCurto: 'Sáb' },
  { dia: '0', rotulo: 'Domingo', rotuloCurto: 'Dom' },
];

/** Os dias úteis — o que o botão "copiar para os dias úteis" preenche. */
export const DIAS_UTEIS = ['1', '2', '3', '4', '5'];

export interface GoogleDoProfissional {
  conectado: boolean;
  email: string | null;
  podeEscrever: boolean;
  precisaReconectar: boolean;
  motivo: string | null;
}

export interface ProfissionalDaAgenda {
  userId: string;
  nome: string;
  email: string;
  /** Tem agenda habilitada nesta conta — ver painel do agente e Regras da agenda. */
  ativo: boolean;
  horarios: HorariosDaSemana;
  intervaloMinutos: number;
  google: GoogleDoProfissional;
}

export interface ServicoDaAgenda {
  id: string;
  nome: string;
  /** null = produto sem duração cadastrada — não agendável. */
  duracaoMinutos: number | null;
  /** Preço padrão do serviço (pode faltar em respostas antigas). */
  valorPadrao?: number;
  ativo: boolean;
}

export interface ConfiguracaoDaAgenda {
  antecedenciaMinimaMinutos: number;
  janelaMaximaDias: number;
  passoMinutos: number;
  holdMinutos: number;
  /** Etapa do funil aplicada ao confirmar um agendamento; null = não mexe na etapa. */
  etapaAoAgendar: string | null;
}

export interface AgendaConfiguracaoResponse {
  configuracao: ConfiguracaoDaAgenda;
  /** TODOS os usuários ativos da conta — `ativo: false` pra quem ainda não tem agenda. */
  profissionais: ProfissionalDaAgenda[];
  servicos: ServicoDaAgenda[];
}

export interface HorarioDisponivel {
  id: string;
  profissionalId: string;
  profissional: string;
  inicio: string; // ISO
  fim: string; // ISO
  rotulo: string;
}

export interface HorariosDisponiveisResponse {
  horarios: HorarioDisponivel[];
  /** Ex.: "só sobrou horário daqui a 12 dias" — mostrar mesmo com lista vazia. */
  aviso?: string;
}

export const agendaBackendService = {
  async getConfiguracao(): Promise<AgendaConfiguracaoResponse> {
    const res = await apiClient.get<DataEnvelope<AgendaConfiguracaoResponse>>(
      API_ENDPOINTS.AGENDA_IA.CONFIGURACAO
    );
    return res.data;
  },

  async atualizarConfiguracao(
    input: Partial<ConfiguracaoDaAgenda>
  ): Promise<ConfiguracaoDaAgenda> {
    const res = await apiClient.put<DataEnvelope<ConfiguracaoDaAgenda>>(
      API_ENDPOINTS.AGENDA_IA.CONFIGURACAO,
      input
    );
    return res.data;
  },

  async atualizarProfissional(
    userId: string,
    input: { ativo?: boolean; horarios?: HorariosDaSemana; intervaloMinutos?: number }
  ): Promise<ProfissionalDaAgenda> {
    const res = await apiClient.put<DataEnvelope<ProfissionalDaAgenda>>(
      API_ENDPOINTS.AGENDA_IA.PROFISSIONAL(userId),
      input
    );
    return res.data;
  },

  async atualizarServico(
    productId: string,
    duracaoMinutos: number | null
  ): Promise<ServicoDaAgenda> {
    const res = await apiClient.put<DataEnvelope<ServicoDaAgenda>>(
      API_ENDPOINTS.AGENDA_IA.SERVICO(productId),
      { duracaoMinutos }
    );
    return res.data;
  },

  async getHorarios(params: {
    profissionalId: string;
    produtoId: string;
    dias?: number;
  }): Promise<HorariosDisponiveisResponse> {
    const query = new URLSearchParams({
      profissionalId: params.profissionalId,
      produtoId: params.produtoId,
      dias: String(params.dias ?? 7),
    });
    const res = await apiClient.get<DataEnvelope<HorariosDisponiveisResponse>>(
      `${API_ENDPOINTS.AGENDA_IA.HORARIOS}?${query.toString()}`
    );
    return res.data;
  },
};

export default agendaBackendService;
