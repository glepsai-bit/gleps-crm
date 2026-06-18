/**
 * T-019 — Webhook n8n POR-CONTA.
 *
 * Arquitetura:
 * - URL e secret vivem em Account.n8nWebhookUrl / Account.n8nWebhookSecret
 *   (substitui o N8N_WEBHOOK_URL global do .env que existia em T-017).
 * - Cada conta pode apontar pro proprio fluxo n8n, OU desligar a integracao
 *   deixando o campo NULL (early return silencioso).
 * - Unico evento emitido pro n8n: appointment.attendance. O evento
 *   appointment.outcome foi removido em T-019 — markOutcome agora so grava
 *   no banco (consultas via CRM, sem side-effect externo).
 *
 * Seguranca:
 * - Se n8nWebhookSecret estiver setado, request leva header
 *   X-Webhook-Signature: sha256=HMAC-SHA256(secret, body). O n8n valida
 *   recomputando a HMAC com o mesmo segredo. Sem segredo, request vai sem
 *   header (compat com flows simples de teste).
 *
 * Operacional:
 * - POST best-effort: 5s timeout via AbortSignal.timeout, falhas logadas
 *   mas nunca propagam (CRM continua funcionando mesmo com n8n down).
 * - chamador SEMPRE passa o Account ja carregado (include: { account: true }
 *   no findUnique) — evita N+1 e deixa explicito que a integracao depende
 *   de config da conta, nao do ambiente global.
 */
import { createHmac } from 'crypto';
import { Prisma, Account } from '@prisma/client';

// Timeout pra POST no n8n. 5s eh folgado pra webhook saudavel e curto o
// suficiente pra nao segurar o event loop quando o n8n esta down.
const N8N_TIMEOUT_MS = 5000;

const appointmentWithRels = Prisma.validator<Prisma.CalendarEventDefaultArgs>()({
  include: { contact: true, account: true },
});

export type AppointmentWithRels = Prisma.CalendarEventGetPayload<typeof appointmentWithRels>;

export type N8nAppointmentEvent = 'appointment.attendance';

type N8nAccountConfig = Pick<Account, 'id' | 'nome' | 'n8nWebhookUrl' | 'n8nWebhookSecret'>;

async function postJson(
  url: string,
  body: unknown,
  secret: string | null,
): Promise<{ ok: boolean; status: number }> {
  // node 20+ tem fetch global; sem deps extras.
  // AbortSignal.timeout garante que requests pro n8n nao pendurem o processo
  // quando o destino estiver down — chamador trata DOMException como falha
  // best-effort no try/catch.
  const payload = JSON.stringify(body);
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (secret && secret.trim().length > 0) {
    const sig = createHmac('sha256', secret).update(payload).digest('hex');
    headers['X-Webhook-Signature'] = `sha256=${sig}`;
  }
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: payload,
    signal: AbortSignal.timeout(N8N_TIMEOUT_MS),
  });
  return { ok: res.ok, status: res.status };
}

function buildPayload(
  event: N8nAppointmentEvent,
  appointment: AppointmentWithRels,
  actor?: { userId: string; name?: string },
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
   * Dispara appointment.attendance para o webhook configurado na Account.
   * Best-effort: erros sao logados, NUNCA propagam pra cima (nao bloqueia
   * resposta HTTP do markAttendance).
   *
   * Se account.n8nWebhookUrl for NULL/vazio, sai cedo com delivered=false
   * (conta com integracao desligada — comportamento esperado, log info).
   */
  async emitAttendanceChanged(
    appointment: AppointmentWithRels,
    account: N8nAccountConfig | null,
    actor?: { userId: string; name?: string },
  ): Promise<{ delivered: boolean; reason?: string }> {
    const url = account?.n8nWebhookUrl?.trim();
    if (!url) {
      // info, nao warn — conta sem webhook configurado eh estado valido.
      console.info('[n8n-webhook] skipped: account sem n8n_webhook_url', {
        appointmentId: appointment.id,
        accountId: appointment.accountId,
      });
      return { delivered: false, reason: 'account sem n8n_webhook_url configurado' };
    }
    try {
      const payload = buildPayload('appointment.attendance', appointment, actor);
      const secret = account?.n8nWebhookSecret?.trim() || null;
      const result = await postJson(url, payload, secret);
      if (!result.ok) {
        console.warn('[n8n-webhook] attendance falhou', {
          status: result.status,
          appointmentId: appointment.id,
          accountId: appointment.accountId,
        });
        return { delivered: false, reason: `HTTP ${result.status}` };
      }
      return { delivered: true };
    } catch (err) {
      console.warn('[n8n-webhook] attendance exception', {
        err: (err as Error).message,
        appointmentId: appointment.id,
        accountId: appointment.accountId,
      });
      return { delivered: false, reason: (err as Error).message };
    }
  },
};
