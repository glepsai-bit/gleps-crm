/**
 * API - Appointments (Human-in-the-Loop T-017)
 * Endpoints de attendance e outcome para agendamentos.
 *
 * BUG-1 corrigido: URLs trocadas de /api/calendar/events/* para /api/appointments/*
 * BUG-2 corrigido: StatusPresenca agora usa os enums do BE (ATTENDED/NO_SHOW/RESCHEDULED)
 * BUG-3 corrigido: ResultadoConsulta agora usa os enums do BE (CLOSED/CONSIDERING/NOT_INTERESTED/RETURN_REQUESTED)
 * BUG-4 corrigido: payload envia { value: number } em BRL real (ex: 500.00), nao valueCents em centavos
 * BUG-5 corrigido: RespostaPendentes agora reflete { pendingAttendance, pendingOutcome, total }
 */

import { apiClient } from '@/api/client';

// Enums exatos do backend (backend/prisma/schema.prisma:531-544)
// AttendanceStatus: PENDING | ATTENDED | NO_SHOW | RESCHEDULED
// Zod no controller aceita apenas: ATTENDED | NO_SHOW | RESCHEDULED (nao PENDING no PATCH)
export type StatusPresenca = 'ATTENDED' | 'NO_SHOW' | 'RESCHEDULED';

// AppointmentOutcome: PENDING | CLOSED | CONSIDERING | NOT_INTERESTED | RETURN_REQUESTED
// Zod no controller aceita apenas: CLOSED | CONSIDERING | NOT_INTERESTED | RETURN_REQUESTED (nao PENDING no PATCH)
export type ResultadoConsulta =
  | 'CLOSED'
  | 'CONSIDERING'
  | 'NOT_INTERESTED'
  | 'RETURN_REQUESTED';

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

// BUG-5: estrutura real do BE (appointment.controller.ts:281-285)
export interface RespostaPendentes {
  pendingAttendance: AgendamentoPendente[];
  pendingOutcome: AgendamentoPendente[];
  total: number;
}

export interface RespostaOutcome {
  id: string;
  outcome: ResultadoConsulta;
  outcomeValue?: number;
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
  // BUG-1: URL corrigida de /api/calendar/events/ para /api/appointments/
  // BUG-2: status agora é o enum uppercase do BE
  return apiClient.patch<RespostaPresenca>(
    `/api/appointments/${id}/attendance`,
    { status }
  );
}

export async function marcarOutcome(
  id: string,
  outcome: ResultadoConsulta,
  // BUG-4: value em BRL real (float), nao valueCents em centavos
  // BE espera Decimal: new Prisma.Decimal(body.value) — campo: "value"
  value?: number,
  notes?: string
): Promise<RespostaOutcome> {
  // BUG-1: URL corrigida de /api/calendar/events/ para /api/appointments/
  // BUG-3: outcome agora é o enum uppercase do BE
  // BUG-4: campo "value" (nao valueCents), representa BRL real
  return apiClient.patch<RespostaOutcome>(
    `/api/appointments/${id}/outcome`,
    { outcome, value, notes }
  );
}

export async function listarPendentes(
  date?: string,
  limit = 20
): Promise<RespostaPendentes> {
  // BUG-1: URL corrigida de /api/calendar/events/pending-status para /api/appointments/pending-status
  return apiClient.get<RespostaPendentes>(
    '/api/appointments/pending-status',
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
