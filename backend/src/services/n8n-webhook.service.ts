/**
 * T-017 — Disparo de webhooks pra n8n quando attendance/outcome de um
 * appointment muda. Reuso simples: lê N8N_WEBHOOK_URL do ambiente,
 * faz POST best-effort e nunca derruba o request principal.
 *
 * Caminho feliz: o n8n recebe o payload e roteia para flows da galeria
 * T-013. Caminho de erro: log + swallow (circuit breaker T-012 cobre a
 * idempotência de outras rotas).
 */
import { Prisma } from '@prisma/client';
import { prisma } from '../config/database';

// Timeout pra POST no n8n. 5s é folgado pra webhook saudável e curto o
// suficiente pra não segurar o event loop quando o n8n está down.
const N8N_TIMEOUT_MS = 5000;

const appointmentWithRels = Prisma.validator<Prisma.CalendarEventDefaultArgs>()({
  include: { contact: true, account: true },
});

export type AppointmentWithRels = Prisma.CalendarEventGetPayload<typeof appointmentWithRels>;

export type N8nAppointmentEvent =
  | 'appointment.attendance'
  | 'appointment.outcome';

function getWebhookUrl(): string | null {
  const url = process.env.N8N_WEBHOOK_URL?.trim();
  return url && url.length > 0 ? url : null;
}

async function postJson(url: string, body: unknown): Promise<{ ok: boolean; status: number }> {
  // node 20+ tem fetch global; sem deps extras.
  // AbortSignal.timeout garante que requests pro n8n não pendurem o processo
  // quando o destino estiver down — chamador trata DOMException como falha
  // best-effort no try/catch.
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(N8N_TIMEOUT_MS),
  });
  return { ok: res.ok, status: res.status };
}

function buildPayload(
  event: N8nAppointmentEvent,
  appointment: AppointmentWithRels,
  actor?: { userId: string; name?: string }
) {
  return {
    event,
    accountId: appointment.accountId,
    appointmentId: appointment.id,
    contactId: appointment.contactId,
    contact: appointment.contact
      ? {
          id: appointment.contact.id,
          nome: appointment.contact.nome,
          telefone: appointment.contact.telefone,
          email: appointment.contact.email,
        }
      : null,
    appointment: {
      id: appointment.id,
      title: appointment.title,
      startTime: appointment.startTime,
      endTime: appointment.endTime,
      status: appointment.status,
      attendanceStatus: appointment.attendanceStatus,
      attendanceMarkedAt: appointment.attendanceMarkedAt,
      outcome: appointment.outcome,
      outcomeValue: appointment.outcomeValue,
      outcomeNotes: appointment.outcomeNotes,
      outcomeMarkedAt: appointment.outcomeMarkedAt,
    },
    account: appointment.account
      ? { id: appointment.account.id, nome: appointment.account.nome }
      : null,
    actor: actor ?? null,
    timestamp: new Date().toISOString(),
  };
}

export const n8nWebhookService = {
  /**
   * Dispara appointment.attendance. Best-effort: erros são logados, não
   * propagam pra cima.
   */
  async emitAttendanceChanged(
    appointment: AppointmentWithRels,
    actor?: { userId: string; name?: string }
  ): Promise<{ delivered: boolean; reason?: string }> {
    const url = getWebhookUrl();
    if (!url) {
      return { delivered: false, reason: 'N8N_WEBHOOK_URL não configurado' };
    }
    try {
      const payload = buildPayload('appointment.attendance', appointment, actor);
      const result = await postJson(url, payload);
      if (!result.ok) {
        console.warn('[n8n-webhook] attendance falhou', { status: result.status, appointmentId: appointment.id });
        return { delivered: false, reason: `HTTP ${result.status}` };
      }
      return { delivered: true };
    } catch (err) {
      console.warn('[n8n-webhook] attendance exception', { err: (err as Error).message, appointmentId: appointment.id });
      return { delivered: false, reason: (err as Error).message };
    }
  },

  /**
   * Dispara appointment.outcome. Best-effort.
   */
  async emitOutcomeChanged(
    appointment: AppointmentWithRels,
    actor?: { userId: string; name?: string }
  ): Promise<{ delivered: boolean; reason?: string }> {
    const url = getWebhookUrl();
    if (!url) {
      return { delivered: false, reason: 'N8N_WEBHOOK_URL não configurado' };
    }
    try {
      const payload = buildPayload('appointment.outcome', appointment, actor);
      const result = await postJson(url, payload);
      if (!result.ok) {
        console.warn('[n8n-webhook] outcome falhou', { status: result.status, appointmentId: appointment.id });
        return { delivered: false, reason: `HTTP ${result.status}` };
      }
      return { delivered: true };
    } catch (err) {
      console.warn('[n8n-webhook] outcome exception', { err: (err as Error).message, appointmentId: appointment.id });
      return { delivered: false, reason: (err as Error).message };
    }
  },
};
