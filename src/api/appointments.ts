/**
 * API - Appointments (Human-in-the-Loop T-017)
 * Endpoints de attendance e outcome para agendamentos.
 */

import { apiClient } from '@/api/client';

export type StatusPresenca = 'compareceu' | 'falto' | 'reagendou';
export type ResultadoConsulta =
  | 'fechou_tratamento'
  | 'vai_pensar'
  | 'sem_interesse'
  | 'pediu_retorno';

export interface RespostaPresenca {
  id: string;
  attendanceStatus: StatusPresenca;
  attendanceAt: string;
  attendanceBy: string;
  requiresOutcome: boolean;
}

export interface AgendamentoPendente {
  id: string;
  title: string;
  contactId: string;
  contactName: string;
  startTime: string;
  endTime: string;
  needs: 'attendance' | 'outcome';
}

export interface RespostaPendentes {
  items: AgendamentoPendente[];
  total: number;
}

export interface RespostaOutcome {
  id: string;
  outcome: ResultadoConsulta;
  outcomeValueCents?: number;
  outcomeNotes?: string;
  outcomeAt: string;
  outcomeBy: string;
}

export interface RespostaDinheiroMesa {
  totalCents: number;
  count: number;
  breakdown: Array<{
    outcome: ResultadoConsulta;
    count: number;
    sumCents: number;
  }>;
}

// ---------- Funções de API ----------

export async function marcarPresenca(
  id: string,
  status: StatusPresenca
): Promise<RespostaPresenca> {
  return apiClient.patch<RespostaPresenca>(
    `/api/calendar/events/${id}/attendance`,
    { status }
  );
}

export async function marcarOutcome(
  id: string,
  outcome: ResultadoConsulta,
  valueCents?: number,
  notes?: string
): Promise<RespostaOutcome> {
  return apiClient.patch<RespostaOutcome>(
    `/api/calendar/events/${id}/outcome`,
    { outcome, valueCents, notes }
  );
}

export async function listarPendentes(
  date?: string,
  limit = 20
): Promise<RespostaPendentes> {
  return apiClient.get<RespostaPendentes>(
    '/api/calendar/events/pending-status',
    { params: { date, limit } }
  );
}

export async function buscarDinheiroMesa(
  range = '30d'
): Promise<RespostaDinheiroMesa> {
  return apiClient.get<RespostaDinheiroMesa>(
    '/api/dashboard/dinheiro-mesa',
    { params: { range } }
  );
}
